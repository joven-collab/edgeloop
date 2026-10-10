// First-run setup: what is ready (Stash, the library, the Handy Application
// ID file, the sync test) and the few things the setup page may save. Saved
// values go to the same gitignored files the rest of the server reads.
import fs from 'node:fs';
import path from 'node:path';
import { libraryRoots, poolFor } from './config.js';
import { gql, loadIndex } from './library.js';

const DONE_FILE = (root) => path.join(root, 'data', 'setup.json');
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// Writes are only taken from this app's own pages: another site open in the
// browser could otherwise post to localhost.
export function fromThisApp(req, port) {
    const ok = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
    if (!ok.has(String(req.headers.host || '').toLowerCase())) return false;
    const origin = req.headers.origin;
    return !origin || ok.has(origin.replace(/^http:\/\//, '').toLowerCase());
}

// Can Stash be reached at `url`, and does it take `headers`?
export async function checkStash(url, headers = {}) {
    try {
        const r = await fetch(`${url}/graphql`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ query: '{ version { version } }' }),
            signal: AbortSignal.timeout(5000)
        });
        if (r.status === 401 || r.status === 403) return { ok: false, needsKey: true };
        if (!r.ok) return { ok: false, error: `Stash answered HTTP ${r.status}` };
        const j = await r.json();
        return { ok: true, version: j?.data?.version?.version || null };
    } catch {
        return { ok: false, error: 'Stash is not reachable' };
    }
}

export const setupDone = (root) => exists(DONE_FILE(root));

export async function setupStatus({ root, stash, hubScenes }) {
    const s = await checkStash(stash.url, stash.headers());
    const out = {
        done: setupDone(root),
        stash: { url: stash.url, hasKey: Boolean(stash.headers().ApiKey), ...s },
        appIdFile: exists(path.join(root, '.handy-app-id')),
        configFile: exists(path.join(root, 'loop.config.json')),
        synctest: { video: false, script: false },
        library: null
    };
    try {
        const files = fs.readdirSync(path.join(root, 'Synctest'));
        out.synctest = { video: files.some(f => /\.(mp4|webm|mkv)$/i.test(f)), script: files.some(f => /\.(csv|funscript)$/i.test(f)) };
    } catch { /* no folder yet */ }
    if (s.ok) {
        try {
            const { scenes } = await hubScenes(stash, { refresh: true });
            const folders = {};
            const pools = { regular: 0, pmv: 0, left: 0 };
            for (const sc of scenes) {
                if (sc.folder) folders[sc.folder] = (folders[sc.folder] || 0) + 1;
                const pool = poolFor(sc.folder, sc.tags, stash.cfg);
                pools[pool || 'left']++;
            }
            const idx = loadIndex(root);
            out.library = {
                scripted: scenes.length,
                roots: await libraryRoots(stash.cfg, q => gql(stash, q)),
                folders: Object.entries(folders).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
                pools,
                indexed: Object.keys(idx.scenes || {}).length,
                indexedAt: idx.syncedAt || null
            };
        } catch (e) { out.library = { error: String(e.message || e) }; }
    }
    return out;
}

// Save the Stash address (in loop.config.json) and API key (in .stash-key),
// but only once Stash takes them.
export async function saveStash({ root, stash }, { url, key }) {
    url = String(url || stash.url).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+$/i.test(url)) return { ok: false, error: 'Use an address like http://localhost:9999' };
    const keyGiven = typeof key === 'string';
    key = keyGiven ? key.trim() : stash.headers().ApiKey || '';
    const s = await checkStash(url, key ? { ApiKey: key } : {});
    if (!s.ok) return s;
    if (url !== stash.url) {
        const file = path.join(root, 'loop.config.json');
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
        cfg.stashUrl = url;
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
        stash.url = url;
        stash.cfg.stashUrl = url;
    }
    if (keyGiven) {
        const keyFile = path.join(root, '.stash-key');
        if (key) fs.writeFileSync(keyFile, key + '\n');
        else fs.rmSync(keyFile, { force: true });
    }
    return s;
}

// The Handy Application ID, kept in .handy-app-id; empty removes it.
export function saveAppId(root, id) {
    id = String(id || '').trim();
    if (id.length > 200 || /\s/.test(id)) return { ok: false, error: 'That does not look like an Application ID.' };
    const file = path.join(root, '.handy-app-id');
    if (id) fs.writeFileSync(file, id + '\n');
    else fs.rmSync(file, { force: true });
    return { ok: true };
}

export function markDone(root, done) {
    const file = DONE_FILE(root);
    if (done) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ done: true, at: new Date().toISOString() }) + '\n');
    } else fs.rmSync(file, { force: true });
    return { ok: true, done: Boolean(done) };
}
