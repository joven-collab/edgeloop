// Review list for Visage face matches the batch was unsure about (70-89%):
// data/visage-review.json holds each scene's candidates (StashDB id, name,
// confidence). Accepting one links that performer to the scene in Stash,
// creating the performer from StashDB first when Stash does not have them.
import fs from 'node:fs';
import path from 'node:path';
import { gql } from './library.js';

const STASHDB = 'https://stashdb.org/graphql';

export function reviewFile(root) {
    return path.join(root, 'data', 'visage-review.json');
}

export function loadReview(root) {
    try { return JSON.parse(fs.readFileSync(reviewFile(root), 'utf8')); } catch { return { items: [] }; }
}

function saveReview(root, data) {
    const f = reviewFile(root);
    fs.writeFileSync(f + '.tmp', JSON.stringify(data));
    fs.renameSync(f + '.tmp', f);
}

// StashDB id -> local performer id, for everyone Stash already has.
export async function localPerformers(stash) {
    const d = await gql(stash, `{ findPerformers(filter:{ per_page:-1 }) { performers { id stash_ids { stash_id } } } }`);
    const map = {};
    for (const p of d.findPerformers.performers) for (const s of p.stash_ids) map[s.stash_id] = p.id;
    return map;
}

async function createFromStashDb(stash, stashId, name) {
    let input = { name, stash_ids: [{ endpoint: STASHDB, stash_id: stashId }] };
    try {
        const r = await gql(stash, `query($q:String!){ scrapeSinglePerformer(source:{ stash_box_endpoint: "${STASHDB}" }, input:{ query: $q }) {
            name disambiguation gender birthdate ethnicity country eye_color hair_color height measurements fake_tits career_length tattoos piercings aliases images remote_site_id } }`, { q: name });
        const s = (r.scrapeSinglePerformer || []).find(x => x.remote_site_id === stashId);
        if (s) {
            const h = parseInt(s.height, 10);
            input = {
                ...input, disambiguation: s.disambiguation || undefined,
                gender: s.gender ? String(s.gender).toUpperCase().replace(/ /g, '_') : undefined,
                birthdate: s.birthdate || undefined, ethnicity: s.ethnicity || undefined, country: s.country || undefined,
                eye_color: s.eye_color || undefined, hair_color: s.hair_color || undefined, height_cm: Number.isFinite(h) ? h : undefined,
                measurements: s.measurements || undefined, fake_tits: s.fake_tits || undefined, career_length: s.career_length || undefined,
                tattoos: s.tattoos || undefined, piercings: s.piercings || undefined,
                alias_list: s.aliases ? String(s.aliases).split(/,\s*/).filter(Boolean) : undefined,
                image: s.images?.[0] || undefined
            };
        }
    } catch { /* name + StashDB link only */ }
    try {
        return (await gql(stash, `mutation($i:PerformerCreateInput!){ performerCreate(input:$i){ id } }`, { i: input })).performerCreate.id;
    } catch (e) {
        if (!/already exists/i.test(e.message)) throw e;
        const found = await gql(stash, `query($n:String!){ findPerformers(performer_filter:{ name:{ value:$n, modifier:EQUALS } }){ performers { id } } }`, { n: name });
        if (!found.findPerformers.performers[0]) throw e;
        return found.findPerformers.performers[0].id;
    }
}

// picks: [{ sceneId, stashId, name }]. Every scene sent is marked done,
// including ones with nothing ticked (so a submitted page clears).
export async function applyReview(root, stash, { picks = [], scenes = [] }) {
    const data = loadReview(root);
    const local = await localPerformers(stash);
    let added = 0;
    const failed = [];
    for (const p of picks) {
        try {
            const pid = local[p.stashId] || (local[p.stashId] = await createFromStashDb(stash, p.stashId, p.name));
            const cur = (await gql(stash, `query($id:ID!){ findScene(id:$id){ performers { id } } }`, { id: p.sceneId })).findScene.performers.map(x => x.id);
            if (!cur.includes(pid)) {
                await gql(stash, `mutation($i:SceneUpdateInput!){ sceneUpdate(input:$i){ id } }`, { i: { id: p.sceneId, performer_ids: [...cur, pid] } });
                added++;
            }
        } catch (e) {
            failed.push({ ...p, error: e.message });
        }
    }
    const touched = new Set([...scenes, ...picks.map(p => p.sceneId)].map(String));
    for (const it of data.items) if (touched.has(String(it.sceneId))) it.done = true;
    saveReview(root, data);
    return { added, failed, left: data.items.filter(i => !i.done).length };
}
