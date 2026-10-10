// EdgeLoop local server: serves the app, relays a fixed set of Stash reads
// with the API key attached server-side, and keeps the library index.
// Listens on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { syncLibrary, loadIndex, fetchScript } from './library.js';
import { applyEvents, emptyLearning } from '../src/js/player/learning.js';
import { parseThumbsVtt } from '../src/js/player/thumbs.js';
import { loadReview, localPerformers, applyReview } from './visage-review.js';
import { hubScenes } from './hub.js';
import { createThumbs } from './thumbs.js';
import { loadConfig } from './config.js';
import { setupStatus, saveStash, saveAppId, markDone, setupDone, fromThisApp } from './setup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.EDGELOOP_PORT) || 8420;
const CONFIG = loadConfig(ROOT);
const KEY_FILE = path.join(ROOT, '.stash-key');

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.csv': 'text/csv; charset=utf-8',
    '.funscript': 'application/json; charset=utf-8'
};

function stashKey() {
    try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; }
}

const thumbs = createThumbs({ root: ROOT, stashUrl: () => stash.url, headers: () => stash.headers() });

const stash = {
    url: CONFIG.stashUrl,
    cfg: CONFIG,
    headers: () => { const k = stashKey(); return k ? { ApiKey: k } : {}; }
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// Only these Stash reads are relayed; the page never sees the key or a raw
// GraphQL endpoint.
const RELAY = /^\/stash\/scene\/(\d+)\/(stream|funscript|interactive_heatmap|screenshot|preview)$/;
// Scrubber sprite sheets are addressed by the scene's file hash.
const SPRITE = /^\/stash\/scene\/([0-9a-f]{8,64})_sprite\.jpg$/;
// Performer pictures, for the adventure cards.
const PERFORMER_IMG = /^\/stash\/performer\/(\d+)\/image$/;

async function relay(req, res, id, kind, upstreamPath = `/scene/${id}/${kind}`) {
    const headers = stash.headers();
    if (req.headers.range) headers.Range = req.headers.range;
    let upstream;
    try {
        upstream = await fetch(`${stash.url}${upstreamPath}`, { headers, redirect: 'manual' });
    } catch {
        return send(res, 502, { error: 'Stash is not reachable at ' + stash.url });
    }
    const pass = {};
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
        const v = upstream.headers.get(h);
        if (v) pass[h] = v;
    }
    if (kind !== 'stream' && kind !== 'preview' && upstream.ok) pass['cache-control'] = 'private, max-age=86400';
    res.writeHead(upstream.status, pass);
    if (!upstream.body) return res.end();
    const body = Readable.fromWeb(upstream.body);
    req.on('close', () => body.destroy());
    body.on('error', () => res.destroy());
    body.pipe(res);
}

let syncing = null;

// Stash's scrubber preview: a sprite sheet plus a WebVTT index of which tile
// covers which time range. Returned as plain cues with a relayed sprite URL.
async function sceneThumbs(id) {
    const r = await fetch(`${stash.url}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...stash.headers() },
        body: JSON.stringify({ query: 'query($id: ID!) { findScene(id: $id) { paths { sprite vtt } } }', variables: { id } })
    });
    const paths = (await r.json())?.data?.findScene?.paths;
    const hash = String(paths?.sprite || '').match(/\/scene\/([0-9a-f]{8,64})_sprite\.jpg/)?.[1];
    if (!hash || !paths?.vtt) return { sprite: null, cues: [] };
    const v = await fetch(`${stash.url}/scene/${hash}_thumbs.vtt`, { headers: stash.headers() });
    if (!v.ok) return { sprite: null, cues: [] };
    return { sprite: `stash/scene/${hash}_sprite.jpg`, cues: parseThumbsVtt(await v.text()) };
}

const LEARNING_FILE = path.join(ROOT, 'data', 'learning.json');

function loadLearning() {
    try {
        const d = JSON.parse(fs.readFileSync(LEARNING_FILE, 'utf8'));
        if (d?.scenes && d?.levels) return d;
    } catch { /* first run */ }
    return emptyLearning();
}

function saveLearning(d) {
    fs.mkdirSync(path.dirname(LEARNING_FILE), { recursive: true });
    fs.writeFileSync(LEARNING_FILE + '.tmp', JSON.stringify(d));
    fs.renameSync(LEARNING_FILE + '.tmp', LEARNING_FILE);
}

function readBody(req, limit = 256 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function handleApi(req, res, url) {
    // First-run setup (setup.html).
    if (url.pathname === '/api/setup/state' && req.method === 'GET') {
        return send(res, 200, { done: setupDone(ROOT), stashUrl: stash.url });
    }
    if (url.pathname === '/api/setup' && req.method === 'GET') {
        return send(res, 200, await setupStatus({ root: ROOT, stash, hubScenes }));
    }
    if (url.pathname.startsWith('/api/setup/') && req.method === 'POST') {
        if (!fromThisApp(req, PORT)) return send(res, 403, { error: 'Only the app itself can change its setup.' });
        let body;
        try { body = JSON.parse(await readBody(req, 16 * 1024)); } catch { return send(res, 400, { error: 'bad body' }); }
        if (url.pathname === '/api/setup/stash') return send(res, 200, await saveStash({ root: ROOT, stash }, body));
        if (url.pathname === '/api/setup/app-id') return send(res, 200, saveAppId(ROOT, body.id));
        if (url.pathname === '/api/setup/done') return send(res, 200, markDone(ROOT, body.done !== false));
        return send(res, 404, { error: 'unknown endpoint' });
    }
    if (url.pathname === '/api/status') {
        let stashOk = false;
        try {
            const r = await fetch(`${stash.url}/graphql`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...stash.headers() },
                body: JSON.stringify({ query: '{ version { version } }' })
            });
            stashOk = r.ok;
        } catch { /* reported below */ }
        return send(res, 200, { stash: stashOk, hasKey: Boolean(stashKey()), syncing: Boolean(syncing) });
    }
    // The Handy Application ID is not a secret (Handy made it for browser
    // code); it lives in a gitignored file and is handed to this page only.
    if (url.pathname === '/api/handy-app-id' && req.method === 'GET') {
        let id = '';
        try { id = fs.readFileSync(path.join(ROOT, '.handy-app-id'), 'utf8').trim(); } catch { /* none saved */ }
        return send(res, 200, { id });
    }
    if (url.pathname === '/api/library' && req.method === 'GET') {
        return send(res, 200, loadIndex(ROOT));
    }
    if (url.pathname === '/api/library/refresh' && req.method === 'POST') {
        if (!syncing) {
            syncing = syncLibrary(ROOT, stash, { full: url.searchParams.get('full') === '1' })
                .finally(() => { syncing = null; });
        }
        try { return send(res, 200, await syncing); } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
    }
    const th = url.pathname.match(/^\/api\/scene\/(\d+)\/thumbs$/);
    if (th) {
        try { return send(res, 200, await sceneThumbs(th[1])); } catch { return send(res, 200, { sprite: null, cues: [] }); }
    }
    const t = url.pathname.match(/^\/api\/scene\/(\d+)\/title$/);
    if (t) {
        try {
            const r = await fetch(`${stash.url}/graphql`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...stash.headers() },
                body: JSON.stringify({ query: 'query($id: ID!) { findScene(id: $id) { title files { basename } } }', variables: { id: t[1] } })
            });
            const s = (await r.json())?.data?.findScene;
            const title = s?.title || (s?.files?.[0]?.basename || '').replace(/\.[^.]+$/, '');
            return send(res, 200, { title });
        } catch { return send(res, 200, { title: '' }); }
    }
    // Session recordings (pulse, drive and events, second by second), one
    // file per session in data/sessions. Re-sent while the session runs, so
    // a later save of the same id replaces the earlier one.
    if (url.pathname === '/api/sessions') {
        const dir = path.join(ROOT, 'data', 'sessions');
        if (req.method === 'POST') {
            let log;
            try { log = JSON.parse(await readBody(req, 8 * 1024 * 1024)); } catch { return send(res, 400, { error: 'bad body' }); }
            if (!/^\d{10,16}$/.test(String(log?.id)) || !Array.isArray(log.samples)) return send(res, 400, { error: 'bad session' });
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `${log.id}.json`);
            fs.writeFileSync(file + '.tmp', JSON.stringify(log));
            fs.renameSync(file + '.tmp', file);
            return send(res, 200, { ok: true });
        }
        if (req.method === 'GET') {
            let list = [];
            try {
                list = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).map(f => {
                    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
                    return { id: j.id, startedAt: j.startedAt, seconds: j.seconds, mode: j.meta?.mode, edges: j.events.filter(e => e[1] === 'edge').length, panics: j.events.filter(e => e[1] === 'panic').length };
                }).sort((a, b) => b.id.localeCompare(a.id));
            } catch { /* none yet */ }
            return send(res, 200, list);
        }
    }
    // Visage matches waiting for a yes (review.html).
    if (url.pathname === '/api/visage-review' && req.method === 'GET') {
        const items = loadReview(ROOT).items.filter(i => !i.done);
        let local = {};
        try { local = await localPerformers(stash); } catch { /* photos just will not show */ }
        return send(res, 200, { items, local });
    }
    if (url.pathname === '/api/visage-review/apply' && req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad body' }); }
        return send(res, 200, await applyReview(ROOT, stash, body));
    }
    // The sync test (Calibrate): the first video and script in the Synctest folder.
    if (url.pathname === '/api/synctest' && req.method === 'GET') {
        let files = [];
        try { files = fs.readdirSync(path.join(ROOT, 'Synctest')); } catch { /* no folder */ }
        const video = files.find(f => /\.(mp4|webm|mkv)$/i.test(f));
        const script = files.find(f => /\.(csv|funscript)$/i.test(f));
        return send(res, 200, { video: video ? `Synctest/${encodeURIComponent(video)}` : null, script: script ? `Synctest/${encodeURIComponent(script)}` : null });
    }
    // The hub's library feed (every scripted scene, from Stash).
    if (url.pathname === '/api/hub/scenes' && req.method === 'GET') {
        try { return send(res, 200, { ...await hubScenes(stash, { refresh: url.searchParams.has('refresh') }), thumbGen: thumbs.generation() }); }
        catch (e) { return send(res, 502, { error: 'Stash: ' + (e.message || e) }); }
    }
    // Settings page: the small pictures' state, and a full rebuild.
    if (url.pathname === '/api/thumbs' && req.method === 'GET') return send(res, 200, thumbs.status());
    if (url.pathname === '/api/thumbs/rebuild' && req.method === 'POST') {
        if (thumbs.status().running) return send(res, 409, { error: 'Already building' });
        thumbs.clear();
        warmThumbs();
        return send(res, 200, thumbs.status());
    }
    if (url.pathname === '/api/learning') {
        if (req.method === 'GET') return send(res, 200, loadLearning());
        if (req.method === 'POST') {
            let events;
            try { events = JSON.parse(await readBody(req)).events; } catch { return send(res, 400, { error: 'bad body' }); }
            const d = applyEvents(loadLearning(), events);
            saveLearning(d);
            return send(res, 200, { ok: true, scenes: Object.keys(d.scenes).length });
        }
    }
    const m = url.pathname.match(/^\/api\/script\/(\d+)$/);
    if (m) {
        try {
            const variant = url.searchParams.get('variant') === 'half' ? 'half' : 'full';
            return send(res, 200, await fetchScript(stash, m[1], variant));
        } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
    }
    return send(res, 404, { error: 'unknown endpoint' });
}

function serveStatic(res, url, req = null) {
    let rel = decodeURIComponent(url.pathname);
    // The hub is the front page; the original EdgeLoop page stays at /index.html.
    if (rel === '/') rel = '/hub.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, '.' + rel);
    const blocked = !file.startsWith(ROOT + path.sep) || /[\\/]\.|[\\/](server|data|tools)[\\/]|^[\\/]loop\.config\.json$/i.test(file.slice(ROOT.length));
    if (blocked) return send(res, 404, 'Not found', 'text/plain');
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
        const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        // Byte ranges, so local videos (the sync test) can be seeked.
        const m = /^bytes=(\d*)-(\d*)$/.exec(req?.headers?.range || '');
        if (m && (m[1] || m[2])) {
            const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
            const end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
            if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
            res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
            fs.createReadStream(file, { start, end }).pipe(res);
            return;
        }
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
        fs.createReadStream(file).pipe(res);
    });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
        const th = url.pathname.match(/^\/thumb\/(scene|performer)\/(\d+)$/);
        if (th && req.method === 'GET') {
            try {
                const file = await thumbs.get(th[1], th[2], Number(url.searchParams.get('w')) || 480, url.searchParams.get('v') || '');
                res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=2592000, immutable' });
                return fs.createReadStream(file).pipe(res);
            } catch {
                // No small copy possible: fall back to the full picture.
                return await relay(req, res, th[2], th[1] === 'scene' ? 'screenshot' : null, th[1] === 'scene' ? `/scene/${th[2]}/screenshot` : `/performer/${th[2]}/image`);
            }
        }
        const r = url.pathname.match(RELAY);
        if (r && req.method === 'GET') return await relay(req, res, r[1], r[2]);
        const sp = url.pathname.match(SPRITE);
        if (sp && req.method === 'GET') return await relay(req, res, null, null, `/scene/${sp[1]}_sprite.jpg`);
        const pi = url.pathname.match(PERFORMER_IMG);
        if (pi && req.method === 'GET') return await relay(req, res, null, null, `/performer/${pi[1]}/image`);
        if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
        return serveStatic(res, url, req);
    } catch (e) {
        if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
        else res.destroy();
    }
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.log(`EdgeLoop is already running on port ${PORT}.`);
        process.exit(0);
    }
    throw e;
});

// Make every missing small picture for the hub (scenes and performers).
async function warmThumbs() {
    if (thumbs.status().running) return;
    try {
        const { scenes } = await hubScenes(stash);
        const items = scenes.map(s => ({ kind: 'scene', id: s.id, width: 480, v: s.v }));
        const people = new Map();
        for (const s of scenes) for (const p of s.performers) if (p.gender !== 'MALE') people.set(p.id, p.v);
        for (const [id, v] of people) items.push({ kind: 'performer', id, width: 320, v });
        const made = await thumbs.warm(items);
        if (made) console.log(`Thumbnails: ${made} made`);
    } catch { /* Stash not up yet; pictures are made on demand */ }
}

server.listen(PORT, '127.0.0.1', () => {
    console.log(`EdgeLoop at http://localhost:${PORT}/  (Stash: ${stash.url})`);
    // Build the hub's small pictures in the background, a little after start.
    setTimeout(warmThumbs, 8000);
});
