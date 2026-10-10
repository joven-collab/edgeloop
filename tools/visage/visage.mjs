// Batch face identification through Visage's online service (user-approved).
// Only the scene's thumbnail sprite (sent as "sprite.jpg") and its timing
// file (sent as "thumbs.vtt") are uploaded: no file names or paths.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, libraryRoots, folderFor } from '../../server/config.js';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = path.join(HERE, '..', '..');
const CONFIG = loadConfig(ROOT);
let key = '';
try { key = fs.readFileSync(path.join(ROOT, '.stash-key'), 'utf8').trim(); } catch { /* Stash without a key */ }
const BASE = 'https://cc1234-stashface-onnx.hf.space/gradio_api';

export async function gql(query, variables) {
    const j = await (await fetch(`${CONFIG.stashUrl}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { ApiKey: key } : {}) }, body: JSON.stringify({ query, variables }) })).json();
    if (j.errors) throw new Error(j.errors[0].message);
    return j.data;
}

// Scenes with no performer, outside the folders in faceMatchSkipFolders
// (loop.config.json). since: an ISO date; only scenes added to Stash after it.
export async function targets(since = null) {
    const added = since ? `, created_at:{ value:"${new Date(since).toISOString()}", modifier:GREATER_THAN }` : '';
    const d = await gql(`{ findScenes(scene_filter:{ performer_count:{ value:0, modifier:EQUALS }${added} }, filter:{per_page:-1}) { scenes { id files { path } } } }`);
    const roots = await libraryRoots(CONFIG, q => gql(q));
    const skip = new Set(CONFIG.faceMatchSkipFolders);
    return d.findScenes.scenes.filter(s => !skip.has(folderFor(s.files[0]?.path || '', roots).toLowerCase())).map(s => s.id);
}

export async function identify(sceneId) {
    const paths = (await gql(`query($id:ID!){ findScene(id:$id){ paths { sprite vtt } } }`, { id: sceneId })).findScene.paths;
    if (!paths?.sprite) return { error: 'no sprite' };
    const local = (u) => u.replace(/^https?:\/\/[^/]+/, CONFIG.stashUrl);
    const sprite = await fetch(local(paths.sprite), { headers: key ? { ApiKey: key } : {} });
    const vtt = await fetch(local(paths.vtt || paths.sprite.replace(/_sprite\.jpg$/, '_thumbs.vtt')), { headers: key ? { ApiKey: key } : {} });
    if (!sprite.ok || !vtt.ok) return { error: `sprite ${sprite.status} vtt ${vtt.status}` };
    const up = async (blob, name) => {
        const fd = new FormData();
        fd.append('files', blob, name);
        const r = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
        if (!r.ok) throw new Error('upload ' + r.status);
        return (await r.json())[0];
    };
    const sp = await up(new Blob([await sprite.arrayBuffer()], { type: 'image/jpeg' }), 'sprite.jpg');
    const vp = await up(new Blob([await vtt.arrayBuffer()], { type: 'text/vtt' }), 'thumbs.vtt');
    const file = (p) => ({ path: p, meta: { _type: 'gradio.FileData' } });
    const r = await fetch(`${BASE}/call/identify_sprite_performers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [file(sp), file(vp), 20] }) });
    if (!r.ok) throw new Error('call ' + r.status);
    const { event_id } = await r.json();
    const text = await (await fetch(`${BASE}/call/identify_sprite_performers/${event_id}`)).text();
    let result = null;
    for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
            const d = JSON.parse(line.slice(6));
            if (d === null) continue;
            const v = Array.isArray(d) && d.length === 1 ? d[0] : d;
            if (v?.progress !== undefined) continue;
            result = v?.data ?? v;
        } catch { /* partial line */ }
    }
    return result;
}

// Quick check: the scene's cover picture only (Visage's single-image search).
// Returns the same shape as identify(): { performers: [{ id, name, confidence }] },
// keeping each performer's best confidence across the faces found.
export async function identifyCover(sceneId) {
    const paths = (await gql(`query($id:ID!){ findScene(id:$id){ paths { screenshot } } }`, { id: sceneId })).findScene.paths;
    if (!paths?.screenshot) return { error: 'no cover' };
    const img = await fetch(paths.screenshot.replace(/^https?:\/\/[^/]+/, CONFIG.stashUrl), { headers: key ? { ApiKey: key } : {} });
    if (!img.ok) return { error: `cover ${img.status}` };
    const fd = new FormData();
    fd.append('files', new Blob([await img.arrayBuffer()], { type: 'image/jpeg' }), 'cover.jpg');
    const upr = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
    if (!upr.ok) throw new Error('upload ' + upr.status);
    const p = (await upr.json())[0];
    const r = await fetch(`${BASE}/call/multiple_image_search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [{ path: p, meta: { _type: 'gradio.FileData' } }, 20] }) });
    if (!r.ok) throw new Error('call ' + r.status);
    const { event_id } = await r.json();
    const text = await (await fetch(`${BASE}/call/multiple_image_search/${event_id}`)).text();
    let faces = null;
    for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try { const d = JSON.parse(line.slice(6)); if (d !== null && d?.progress === undefined) faces = Array.isArray(d) && d.length === 1 && Array.isArray(d[0]) ? d[0] : d; } catch { /* partial */ }
    }
    if (!Array.isArray(faces)) return { performers: [] };
    const best = new Map();
    for (const f of faces) for (const p2 of (f?.performers || [])) {
        const prev = best.get(p2.id);
        if (!prev || (p2.confidence || 0) > prev.confidence) best.set(p2.id, { id: p2.id, name: p2.name, confidence: p2.confidence || 0 });
    }
    return { performers: [...best.values()] };
}

if (process.argv[2] === 'test') {
    const ids = await targets();
    fs.writeFileSync(path.join(HERE, 'visage-todo.json'), JSON.stringify(ids));
    console.log('targets', ids.length);
    console.log(JSON.stringify(await identify(ids[0]), null, 1).slice(0, 3000));
}
