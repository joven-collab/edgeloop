// Runs Visage identification over every target scene, one at a time.
// Strong matches (>= 90%) are added to the scene right away; 70-89% go to a
// review list; lower ones are ignored. Progress is saved after every scene,
// so the run can be stopped and started again and it picks up where it was.
import fs from 'node:fs';
import path from 'node:path';
import { gql, targets, identify, identifyCover } from './visage.mjs';

// quick = cover picture only (fast); full = whole thumbnail sheet (thorough);
// retry = full scan of only the scenes a quick pass found nothing strong in.
const MODE = ['quick', 'full', 'retry'].includes(process.argv[2]) ? process.argv[2] : 'quick';
// --since YYYY-MM-DD: only scenes added to Stash after that day.
const sinceArg = process.argv.indexOf('--since');
const SINCE = sinceArg > 0 ? process.argv[sinceArg + 1] : null;

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
// Progress lives in the project's data folder (gitignored), not in a temp
// folder Windows may clear.
const STATE = path.join(HERE, '..', '..', 'data', 'visage-state.json');
const STRONG = 90;
const REVIEW = 70;
const STASHDB = 'https://stashdb.org/graphql';

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { done: {}, added: [], created: [], review: [], errors: [] };
const save = () => fs.writeFileSync(STATE + '.tmp', JSON.stringify(state)) || fs.renameSync(STATE + '.tmp', STATE);

const local = new Map();
for (const p of (await gql(`{ findPerformers(filter:{per_page:-1}) { performers { id name stash_ids { stash_id } } } }`)).findPerformers.performers) {
    for (const s of p.stash_ids) local.set(s.stash_id, p.id);
}

// A StashDB performer not in Stash yet: scrape it from StashDB and create it.
async function createFromStashDb(m) {
    let input = { name: m.name, stash_ids: [{ endpoint: STASHDB, stash_id: m.id }] };
    try {
        const r = await gql(`query($q:String!){ scrapeSinglePerformer(source:{ stash_box_endpoint: "${STASHDB}" }, input:{ query: $q }) {
            name disambiguation gender birthdate ethnicity country eye_color hair_color height measurements fake_tits career_length tattoos piercings aliases images remote_site_id } }`, { q: m.name });
        const s = (r.scrapeSinglePerformer || []).find(x => x.remote_site_id === m.id);
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
    } catch { /* fall back to name + StashDB link */ }
    let id;
    try {
        id = (await gql(`mutation($i:PerformerCreateInput!){ performerCreate(input:$i){ id } }`, { i: input })).performerCreate.id;
    } catch (e) {
        if (!/already exists/i.test(e.message)) throw e;
        id = (await gql(`query($n:String!){ findPerformers(performer_filter:{ name:{ value:$n, modifier:EQUALS } }){ performers { id } } }`, { n: m.name })).findPerformers.performers[0]?.id;
        if (!id) throw e;
    }
    local.set(m.id, id);
    state.created.push({ id, name: m.name });
    return id;
}

async function addToScene(sceneId, performerIds) {
    const cur = (await gql(`query($id:ID!){ findScene(id:$id){ performers { id } } }`, { id: sceneId })).findScene.performers.map(p => p.id);
    const next = [...new Set([...cur, ...performerIds])];
    if (next.length === cur.length) return;
    await gql(`mutation($i:SceneUpdateInput!){ sceneUpdate(input:$i){ id } }`, { i: { id: sceneId, performer_ids: next } });
}

const ids = await targets(SINCE);
const todo = MODE === 'retry'
    ? ids.filter(id => state.done[id] && state.done[id].via === 'quick' && !state.done[id].strong)
    : ids.filter(id => !state.done[id]);
console.log(`mode ${MODE}: targets ${ids.length}, to scan ${todo.length}`);
let n = 0;
for (const sceneId of todo) {
    n++;
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
        try { res = MODE === 'quick' ? await identifyCover(sceneId) : await identify(sceneId); break; } catch (e) { res = { error: e.message }; await new Promise(r => setTimeout(r, 5000 * (attempt + 1))); }
    }
    const matches = (res?.performers || []).map(p => ({ id: p.id, name: p.name, confidence: p.confidence || 0 }));
    const strong = matches.filter(m => m.confidence >= STRONG);
    const unsure = matches.filter(m => m.confidence >= REVIEW && m.confidence < STRONG);
    try {
        const addIds = [];
        for (const m of strong) addIds.push(local.get(m.id) || await createFromStashDb(m));
        if (addIds.length) { await addToScene(sceneId, addIds); state.added.push({ sceneId, performers: strong.map(m => `${m.name} ${m.confidence}%`) }); }
        if (unsure.length) { state.review = state.review.filter(x => x.sceneId !== sceneId); if (!strong.length) state.review.push({ sceneId, performers: unsure }); }
        if (strong.length) state.review = state.review.filter(x => x.sceneId !== sceneId);
        if (res?.error) state.errors.push({ sceneId, error: res.error });
    } catch (e) {
        state.errors.push({ sceneId, error: e.message });
    }
    state.done[sceneId] = { strong: strong.length, unsure: unsure.length, via: MODE === 'quick' ? 'quick' : 'full', at: Date.now() };
    save();
    if (n % 10 === 0) console.log(`${n}/${todo.length} added ${state.added.length} review ${state.review.length} errors ${state.errors.length}`);
}
console.log('DONE', { scenes: Object.keys(state.done).length, added: state.added.length, created: state.created.length, review: state.review.length, errors: state.errors.length });

// Unsure matches for scenes that still have nobody go to the checklist page
// (http://localhost:8420/review.html), added to whatever is already there.
try {
    const file = path.join(HERE, '..', '..', 'data', 'visage-review.json');
    const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { items: [] };
    const have = new Set(list.items.map(i => String(i.sceneId)));
    const none = new Set((await gql(`{ findScenes(scene_filter:{ performer_count:{ value:0, modifier:EQUALS } }, filter:{per_page:-1}) { scenes { id } } }`)).findScenes.scenes.map(s => s.id));
    let added = 0;
    for (const r of state.review) {
        if (!none.has(String(r.sceneId)) || have.has(String(r.sceneId))) continue;
        list.items.push({ sceneId: String(r.sceneId), candidates: [...r.performers].sort((a, b) => b.confidence - a.confidence), done: false });
        have.add(String(r.sceneId));
        added++;
    }
    fs.writeFileSync(file, JSON.stringify(list));
    console.log(`checklist: ${added} new scenes to review at http://localhost:8420/review.html`);
} catch (e) {
    console.log('checklist not updated: ' + e.message);
}
