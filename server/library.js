// Library index: scripted Stash scenes sorted into pools (see config.js), each
// analysed once and cached in data/library.json. File paths never leave this
// module; the cache stores only the pool and folder a scene belongs to.
import fs from 'node:fs';
import path from 'node:path';
import { analyzeScript, encodeLevels, halfSpeedActions, cleanActions } from '../src/js/library/script-analysis.js';
import { libraryRoots, folderFor, poolFor } from './config.js';

export const INDEX_VERSION = 1;

function indexFile(root) {
    return path.join(root, 'data', 'library.json');
}

export function loadIndex(root) {
    try {
        const idx = JSON.parse(fs.readFileSync(indexFile(root), 'utf8'));
        if (idx?.version === INDEX_VERSION && idx.scenes) return idx;
    } catch { /* no cache yet */ }
    return { version: INDEX_VERSION, syncedAt: null, scenes: {} };
}

function saveIndex(root, idx) {
    fs.mkdirSync(path.dirname(indexFile(root)), { recursive: true });
    const tmp = indexFile(root) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(idx));
    fs.renameSync(tmp, indexFile(root));
}

export async function gql(stash, query, variables) {
    const r = await fetch(`${stash.url}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...stash.headers() },
        body: JSON.stringify({ query, variables })
    });
    if (!r.ok) throw new Error(`Stash answered ${r.status}${r.status === 401 ? ' (check the API key in .stash-key)' : ''}`);
    const j = await r.json();
    if (j.errors?.length) throw new Error('Stash: ' + j.errors[0].message);
    return j.data;
}

const SCENES_QUERY = `query {
  findScenes(scene_filter: { interactive: true }, filter: { per_page: -1 }) {
    scenes { id updated_at interactive_speed tags { name } performers { id } files { path duration }
      scene_markers { seconds end_seconds primary_tag { name } tags { name } } }
  }
}`;

// Stash scene markers (timestamps), compact: start and end in seconds and the
// marker's tag names, primary first.
function markersOf(s) {
    return (s.scene_markers || [])
        .map(m => ({ s: m.seconds, e: m.end_seconds ?? null, tags: [m.primary_tag?.name, ...(m.tags || []).map(t => t.name)].filter(Boolean) }))
        .sort((a, b) => a.s - b.s);
}

const PERFORMERS_QUERY = `query {
  findPerformers(filter: { per_page: -1 }) {
    performers { id name gender hair_color ethnicity eye_color fake_tits height_cm birthdate country favorite rating100 }
  }
}`;

export async function fetchRawScript(stash, id) {
    const r = await fetch(`${stash.url}/scene/${id}/funscript`, { headers: stash.headers() });
    if (!r.ok) throw new Error(`funscript ${id}: HTTP ${r.status}`);
    const j = await r.json();
    // As Stash does: "range" rescales positions to 0-100, "inverted" flips them.
    const range = Number(j?.range) > 0 ? Number(j.range) : 100;
    const actions = (j?.actions || []).map(a => {
        let pos = a?.pos * 100 / range;
        if (j?.inverted === true) pos = 100 - pos;
        return { ...a, pos };
    });
    return cleanActions(actions);
}

export async function fetchScript(stash, id, variant = 'full') {
    const actions = await fetchRawScript(stash, id);
    return { version: '1.0', inverted: false, range: 100, actions: variant === 'half' ? halfSpeedActions(actions) : actions };
}

async function mapLimit(items, limit, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) { const i = next++; await fn(items[i], i); }
    });
    await Promise.all(workers);
}

export async function syncLibrary(root, stash, { full = false } = {}) {
    const started = Date.now();
    const idx = full ? { version: INDEX_VERSION, syncedAt: null, scenes: {} } : loadIndex(root);
    const data = await gql(stash, SCENES_QUERY);
    const roots = await libraryRoots(stash.cfg, q => gql(stash, q));
    const seen = new Set();
    const todo = [];
    let outside = 0;
    for (const s of data.findScenes.scenes) {
        const file = s.files?.[0];
        const folder = folderFor(file?.path, roots);
        const pool = poolFor(folder, s.tags.map(t => t.name), stash.cfg);
        if (!pool) { outside++; continue; }
        const where = { pool, folder: folder.toLowerCase() };
        seen.add(s.id);
        const prev = idx.scenes[s.id];
        if (!prev || prev.updatedAt !== s.updated_at || prev.pool !== where.pool) todo.push({ s, where, file });
        else { prev.tags = s.tags.map(t => t.name); prev.performers = s.performers.map(p => p.id); prev.markers = markersOf(s); }
    }
    let removed = 0;
    for (const id of Object.keys(idx.scenes)) if (!seen.has(id)) { delete idx.scenes[id]; removed++; }

    const failed = [];
    await mapLimit(todo, 6, async ({ s, where, file }) => {
        try {
            const actions = await fetchRawScript(stash, s.id);
            const a = analyzeScript(actions, Math.round((file.duration || 0) * 1000));
            idx.scenes[s.id] = {
                id: s.id,
                pool: where.pool,
                folder: where.folder,
                updatedAt: s.updated_at,
                durationMs: a.durationMs,
                stashSpeed: s.interactive_speed ?? null,
                tags: s.tags.map(t => t.name),
                performers: s.performers.map(p => p.id),
                markers: markersOf(s),
                mix: a.mix,
                deadPercent: a.deadPercent,
                liveMedianSpeed: a.liveMedianSpeed,
                firstActionMs: a.firstActionMs,
                levels: encodeLevels(a.windows)
            };
        } catch (e) {
            failed.push(s.id);
            delete idx.scenes[s.id];
        }
    });

    // Performer profiles for the scenes in the index (names and StashDB
    // details), refreshed every sync; cheap, and there is nothing to analyse.
    try {
        const used = new Set(Object.values(idx.scenes).flatMap(sc => sc.performers || []));
        const pd = await gql(stash, PERFORMERS_QUERY);
        idx.performers = {};
        for (const p of pd.findPerformers.performers) {
            if (!used.has(p.id)) continue;
            idx.performers[p.id] = {
                id: p.id, name: p.name, gender: p.gender ?? null, hair: p.hair_color || null, ethnicity: p.ethnicity || null,
                eyes: p.eye_color || null, natural: p.fake_tits ? !/fake|augment|yes/i.test(p.fake_tits) : null,
                heightCm: p.height_cm ?? null, born: p.birthdate || null, country: p.country || null,
                favorite: Boolean(p.favorite), rating: p.rating100 ?? null
            };
        }
    } catch { /* keep the old profiles */ }

    idx.syncedAt = new Date().toISOString();
    saveIndex(root, idx);
    const pools = {};
    for (const sc of Object.values(idx.scenes)) pools[sc.pool] = (pools[sc.pool] || 0) + 1;
    return { analyzed: todo.length - failed.length, removed, failed, outsidePools: outside, pools, ms: Date.now() - started };
}
