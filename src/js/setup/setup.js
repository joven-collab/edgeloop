// First-run setup: walks a new install through Stash, the library, The Handy
// (and its optional newer mode), a heart-rate strap and the sync test, testing
// each as it goes. Opens by itself until it is finished once; Settings in the
// hub can open it again. Everything it saves lands where the app already
// reads it: the browser's settings, .stash-key, .handy-app-id, loop.config.json.
import { connectBleHeartRate, disconnectBle } from '../hardware/ble.js';

const $ = (id) => document.getElementById(id);
const V2 = 'https://www.handyfeeling.com/api/handy/v2';
const V3 = 'https://www.handyfeeling.com/api/handy-rest/v3';
const KEY = 'handy_connection_key';
const APP_ID = 'handy_app_id';
const MODE = 'player_handy_mode';
const GUIDE = 'https://ohdoki.notion.site/Handy-API-v3-ea6c47749f854fbcabcc40c729ea6df4';
const SYNC_VIDEO = 'https://playground.handyfeeling.com/assets/sync_video_2021.mp4';
const SYNC_SCRIPT = 'https://sweettecheu.s3.eu-central-1.amazonaws.com/testsync/sync_video_2021.csv';

// h('p', { class: 'x' }, 'text', child...): text is always set as text.
function h(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null || v === false) continue;
        if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
    return e;
}
const a = (href, text) => h('a', { class: 'link', href, target: '_blank', rel: 'noopener noreferrer' }, text);
const ls = {
    get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private window */ } }
};
const post = async (path, body) => (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
function result(el, tone, ...text) { el.className = 'result ' + tone; el.replaceChildren(...text); }

let status = null;
const done = { handy: null, newer: null, hr: null };   // true / false / null (not tried)

async function refresh() {
    try { status = await (await fetch('api/setup')).json(); } catch { status = null; }
    return status;
}

// ---- the steps ---------------------------------------------------------------

const STEPS = [
    { id: 'welcome', label: 'Welcome', render: welcome },
    { id: 'stash', label: 'Stash', render: stashStep, ok: () => status?.stash?.ok },
    { id: 'library', label: 'Library', render: libraryStep, ok: () => status?.library?.scripted > 0 },
    { id: 'handy', label: 'The Handy', render: handyStep, ok: () => done.handy ?? (ls.get(KEY) ? null : false) },
    { id: 'newer', label: 'Newer mode', render: newerStep, ok: () => done.newer, optional: true },
    { id: 'hr', label: 'Heart rate', render: hrStep, ok: () => done.hr, optional: true },
    { id: 'sync', label: 'Sync test', render: syncStep, ok: () => (status?.synctest?.video && status?.synctest?.script) || null, optional: true },
    { id: 'done', label: 'Done', render: finish }
];
let at = 0;

function welcome(box) {
    box.append(
        h('h2', {}, 'Welcome to Loop'),
        h('p', {}, 'This takes a few minutes and checks each part as you go, so you know everything works before your first session.'),
        h('h3', {}, 'What you need'),
        h('ul', {},
            h('li', {}, h('b', {}, 'Stash'), ' running, with your videos and their funscripts in it. ', a('https://stashapp.cc/', 'Get Stash')),
            h('li', {}, h('b', {}, 'The Handy'), ' on Wi-Fi, and its connection key.'),
            h('li', {}, h('b', {}, 'Optional:'), ' a Bluetooth heart-rate chest strap for the heart-rate sessions, and Chrome or Edge to connect it.')),
        h('p', { class: 'muted' }, 'Nothing here leaves your computer except the checks sent to your Handy through Handy\'s own service. You can skip any step and come back from Settings.')
    );
}

function stashStep(box) {
    const s = status?.stash || {};
    const res = h('div', { class: 'result' });
    const url = h('input', { id: 'stashUrl', type: 'url', value: s.url || 'http://localhost:9999', spellcheck: 'false' });
    const key = h('input', { id: 'stashKey', type: 'password', placeholder: s.hasKey ? 'A key is saved. Leave empty to keep it.' : 'Only if your Stash has a password', autocomplete: 'off' });
    const show = (r) => {
        if (r.ok) result(res, 'good', `Connected to Stash${r.version ? ' ' + r.version : ''}.`);
        else if (r.needsKey) result(res, 'bad', 'Stash wants an API key. In Stash open Settings > Security, press Generate next to API Key, and paste it here.');
        else result(res, 'bad', (r.error || 'Stash is not reachable') + '. Is Stash running, and is the address right?');
    };
    const test = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        test.disabled = true;
        result(res, '', 'Checking…');
        const body = { url: url.value };
        if (key.value.trim()) body.key = key.value;
        const r = await post('api/setup/stash', body).catch(() => ({ ok: false, error: 'The Loop server did not answer' }));
        show(r);
        test.disabled = false;
        if (r.ok) { key.value = ''; await refresh(); paintRail(); }
    } }, 'Save and test');
    box.append(
        h('h2', {}, 'Connect to Stash'),
        h('p', {}, 'Loop reads your library from Stash: titles, performers, tags, covers and the scripts.'),
        h('div', { class: 'field' }, h('label', { for: 'stashUrl' }, 'Stash address'), url),
        h('div', { class: 'field' }, h('label', { for: 'stashKey' }, 'Stash API key'), key),
        h('div', { class: 'row' }, test),
        res
    );
    if (s.ok || s.needsKey || s.error) show(s);
}

function libraryStep(box) {
    const lib = status?.library;
    box.append(h('h2', {}, 'Your library'));
    if (!status?.stash?.ok) { box.append(h('p', { class: 'result bad' }, 'Connect to Stash first (the step before).')); return; }
    if (!lib || lib.error) { box.append(h('p', { class: 'result bad' }, 'Could not read the library: ' + (lib?.error || 'unknown error'))); return; }
    if (!lib.scripted) {
        box.append(
            h('p', { class: 'result bad' }, 'Stash has no videos with a script yet.'),
            h('p', {}, 'Put each funscript next to its video with the same name (', h('code', {}, 'Scene.mp4'), ' and ', h('code', {}, 'Scene.funscript'), '), then run ', h('b', {}, 'Scan'), ' in Stash (Settings > Tasks). Come back and press Check again.'),
            h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: async () => { await refresh(); show(); } }, 'Check again')));
        return;
    }
    const stat = (n, label) => h('div', { class: 'stat' }, h('b', {}, String(n)), h('span', { class: 'muted small' }, label));
    box.append(
        h('div', { class: 'stats' },
            stat(lib.scripted, 'videos with a script'),
            stat(lib.pools.regular, 'in heart-rate sessions'),
            stat(lib.pools.pmv, 'PMV tracks'),
            lib.pools.left ? stat(lib.pools.left, 'left out by your config') : null),
        h('p', {}, lib.folders.length > 1
            ? `Found ${lib.folders.length} folders (${lib.folders.slice(0, 6).map(f => f.name).join(', ')}${lib.folders.length > 6 ? ', …' : ''}). Each gets a chip in Browse.`
            : 'Your library is one folder, which works fine: Browse shows everything together.'),
        h('p', { class: 'muted' }, 'Videos tagged PMV, or in a folder with PMV in its name, play as PMV tracks: whole songs, never cut mid-track. To change which folders play where, see loop.config.example.json.')
    );
    const res = h('div', { class: 'result' });
    const btn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        btn.disabled = true;
        result(res, '', 'Analysing every script… The first time can take a few minutes for a big library.');
        try {
            const r = await (await fetch('api/library/refresh', { method: 'POST' })).json();
            if (r.error) throw new Error(r.error);
            result(res, 'good', `Ready: ${r.analyzed} scripts analysed${r.failed?.length ? `, ${r.failed.length} could not be read` : ''}.`);
            await refresh();
        } catch (e) { result(res, 'bad', 'Could not analyse: ' + (e.message || e)); }
        btn.disabled = false;
    } }, lib.indexed ? 'Re-analyse scripts' : 'Analyse scripts');
    box.append(
        h('h3', {}, 'Heart-rate sessions'),
        h('p', {}, 'Heart-rate sessions need each script analysed once, so they can pick calm or intense parts. ',
            lib.indexed ? `${lib.indexed} are analysed already.` : 'None are yet.'),
        h('div', { class: 'row' }, btn), res);
}

function handyStep(box) {
    const key = h('input', { id: 'handyKey', type: 'password', value: ls.get(KEY), autocomplete: 'off', spellcheck: 'false' });
    const res = h('div', { class: 'result' });
    const test = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        const k = key.value.trim();
        if (!k) { result(res, 'bad', 'Enter the connection key first.'); return; }
        test.disabled = true;
        result(res, '', 'Asking the Handy…');
        ls.set(KEY, k);
        try {
            const r = await fetch(`${V2}/connected`, { headers: { 'X-Connection-Key': k, Accept: 'application/json' } });
            const j = await r.json();
            done.handy = Boolean(j?.connected);
            if (done.handy) result(res, 'good', 'Your Handy answered. The key is saved.');
            else result(res, 'bad', 'The key is saved, but the Handy did not answer. Is it switched on and on Wi-Fi (its light shows the Wi-Fi state)? Then test again.');
        } catch {
            done.handy = false;
            result(res, 'bad', 'Could not reach Handy\'s service. Check your internet connection.');
        }
        test.disabled = false;
        paintRail();
    } }, 'Save and test');
    box.append(
        h('h2', {}, 'The Handy'),
        h('p', {}, 'Loop drives the Handy over Wi-Fi through Handy\'s own service, using your connection key. You find the key in the Handy app or at ', a('https://www.handyfeeling.com/', 'handyfeeling.com'), ' once the Handy is on Wi-Fi.'),
        h('div', { class: 'field' }, h('label', { for: 'handyKey' }, 'Connection key'), key),
        h('div', { class: 'row' }, test),
        res,
        h('p', { class: 'muted small' }, 'The key stays in this browser. Anyone with it can drive your Handy, so do not share it.'));
}

function newerStep(box) {
    const id = h('input', { id: 'appId', type: 'text', value: ls.get(APP_ID), placeholder: status?.appIdFile ? 'Saved in the .handy-app-id file' : 'Paste your Application ID', autocomplete: 'off', spellcheck: 'false' });
    const res = h('div', { class: 'result' });
    const test = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        const v = id.value.trim();
        const k = ls.get(KEY);
        if (!v && !status?.appIdFile) { result(res, 'bad', 'Paste your Application ID first.'); return; }
        test.disabled = true;
        result(res, '', 'Checking…');
        try {
            let appId = v;
            if (v) {
                const saved = await post('api/setup/app-id', { id: v });
                if (!saved.ok) throw new Error(saved.error);
                ls.set(APP_ID, v);
            } else appId = (await (await fetch('api/handy-app-id')).json()).id;
            const headers = { 'X-Api-Key': appId, 'X-Connection-Key': k, Accept: 'application/json' };
            const c = await fetch(`${V3}/connected`, { headers });
            if (c.status === 401 || c.status === 403) { done.newer = false; result(res, 'bad', 'Handy did not accept that Application ID. Copy it again from your developer account.'); return; }
            const cj = await c.json().catch(() => null);
            const on = (cj?.result ?? cj)?.connected;
            if (!k || !on) {
                ls.set(MODE, 'stream');
                done.newer = true;
                result(res, 'good', 'Application ID saved. ' + (k ? 'The Handy is offline right now, so its firmware is checked the next time it connects.' : 'Add the connection key (the step before) to check the Handy itself.'));
                return;
            }
            const ij = await (await fetch(`${V3}/info`, { headers })).json().catch(() => null);
            const info = ij?.result ?? ij ?? {};
            if (info.fw_status === 2) {
                ls.set(MODE, 'classic');
                done.newer = false;
                result(res, 'bad', `The Application ID works, but the Handy needs a firmware update for the newer mode (it has ${info.fw_version || 'an old version'}). Update it in the Handy app; until then Loop uses Classic mode.`);
                return;
            }
            ls.set(MODE, 'stream');
            done.newer = true;
            result(res, 'good', `Newer mode is on${info.fw_version ? ` (firmware ${info.fw_version})` : ''}.`);
        } catch (e) {
            done.newer = false;
            result(res, 'bad', 'Could not check: ' + (e.message || e));
        } finally {
            test.disabled = false;
            await refresh();
            paintRail();
        }
    } }, 'Save and test');
    const classic = h('button', { class: 'btn', type: 'button', onclick: () => {
        ls.set(MODE, 'classic');
        done.newer = null;
        result(res, 'good', 'Classic mode it is. You can add an Application ID later in a heart-rate session\'s Settings > Handy.');
        paintRail();
    } }, 'Use Classic mode');
    box.append(
        h('h2', {}, 'Newer mode (optional)'),
        h('p', {}, 'Everything works in ', h('b', {}, 'Classic mode'), ', which uploads each script to the Handy before it plays. ', h('b', {}, 'Newer mode'), ' streams the script instead:'),
        h('ul', {},
            h('li', {}, 'Starts, seeks and switches scenes at once, with no upload wait.'),
            h('li', {}, 'Smoother half speed and pace changes in the heart-rate sessions.'),
            h('li', {}, 'Needs Handy firmware 4 or newer.')),
        h('div', { class: 'note' },
            h('b', {}, 'To use it you need your own free Application ID from Handy.'), ' Loop cannot ship one: each ID belongs to one developer account.',
            h('ol', {},
                h('li', {}, 'Open Handy\'s ', a(GUIDE, 'developer guide'), ' and create a developer account (you may have to ask for an invite first).'),
                h('li', {}, 'In your account, issue an Application ID (API token).'),
                h('li', {}, 'Paste it below and press Save and test.'))),
        h('div', { class: 'field' }, h('label', { for: 'appId' }, 'Application ID'), id),
        h('div', { class: 'row' }, test, classic),
        res,
        h('p', { class: 'muted small' }, 'The ID is saved in this browser and in a .handy-app-id file in the Loop folder, which is never uploaded anywhere. If newer mode ever fails to start, Loop falls back to Classic by itself.'));
}

function hrStep(box) {
    const res = h('div', { class: 'result' });
    const supported = Boolean(navigator.bluetooth);
    let timer = 0;
    const test = h('button', { class: 'btn primary', type: 'button', disabled: !supported, onclick: async () => {
        test.disabled = true;
        result(res, '', 'Pick your strap in the browser\'s list…');
        let beats = 0;
        try {
            await connectBleHeartRate({
                onHrMeasurement: (bpm) => {
                    beats++;
                    done.hr = true;
                    result(res, 'good', `Your strap works: ${bpm} BPM.`);
                    paintRail();
                },
                onDisconnected: () => {}
            });
            result(res, '', 'Connected. Waiting for a pulse: wear the strap with wet pads…');
            clearTimeout(timer);
            timer = setTimeout(() => {
                disconnectBle({ silent: true });
                if (!beats) { done.hr = false; result(res, 'bad', 'Connected, but no pulse came in 20 seconds. Wet the pads, tighten the strap, and try again.'); paintRail(); }
            }, 20000);
        } catch (e) {
            done.hr = false;
            result(res, 'bad', e?.name === 'NotFoundError' ? 'No strap was picked.' : 'Could not connect: ' + (e.message || e));
            paintRail();
        }
        test.disabled = false;
    } }, 'Test my strap');
    box.append(
        h('h2', {}, 'Heart rate (optional)'),
        h('p', {}, 'Heart-rate sessions read a Bluetooth chest strap (Polar, Coospo, Garmin and most others that work with fitness apps) and slow the Handy down before you go over the edge. Browse and watch work without one.'),
        supported ? null : h('p', { class: 'result bad' }, 'This browser has no Bluetooth support. Use Chrome or Edge on a computer with Bluetooth for heart-rate sessions.'),
        h('div', { class: 'row' }, test),
        res,
        h('p', { class: 'muted small' }, 'This is only a test: the strap is let go after 20 seconds. You connect it again at the start of each heart-rate session.'));
}

function syncStep(box) {
    const st = status?.synctest || {};
    const ready = st.video && st.script;
    box.append(
        h('h2', {}, 'Sync test (optional)'),
        h('p', {}, 'Wi-Fi adds a small delay. The sync test plays a clip where you can see each stroke, so you can line the Handy up with the picture. The offset you set is used everywhere.'),
        ready
            ? h('p', { class: 'result good' }, 'The sync test files are in place.')
            : h('div', { class: 'note' }, 'Download Handy\'s ', a(SYNC_VIDEO, 'sync video'), ' and ', a(SYNC_SCRIPT, 'sync script'),
                ' into a folder named ', h('code', {}, 'Synctest'), ' inside the Loop folder, then press Check again.'),
        h('div', { class: 'row' },
            ready ? h('a', { class: 'btn primary', href: './#/calibrate' }, 'Open the sync test') : h('button', { class: 'btn', type: 'button', onclick: async () => { await refresh(); show(); } }, 'Check again')),
        h('p', { class: 'muted small' }, 'You can run it any time from Settings > Calibrate.'));
}

function finish(box) {
    const item = (state, text) => h('li', {}, h('span', { class: state === true ? 'y' : state === false ? 'x' : 'n' }, state === true ? '✓' : state === false ? '!' : '–'), h('span', {}, text));
    const lib = status?.library;
    const mode = ls.get(MODE) === 'classic' || !(ls.get(APP_ID) || status?.appIdFile) ? 'Classic mode' : 'Newer mode';
    const ready = status?.stash?.ok && lib?.scripted > 0 && ls.get(KEY);
    box.append(
        h('h2', {}, ready ? 'All set' : 'Almost there'),
        h('ul', { class: 'checklist' },
            item(status?.stash?.ok || false, status?.stash?.ok ? 'Stash is connected.' : 'Stash is not connected yet.'),
            item(lib?.scripted > 0 || false, lib?.scripted ? `${lib.scripted} videos with a script${lib.indexed ? `, ${lib.indexed} analysed for heart-rate sessions` : ' (not analysed yet)'}.` : 'No scripted videos found.'),
            item(done.handy ?? (ls.get(KEY) ? null : false), done.handy ? 'The Handy answered.' : ls.get(KEY) ? 'A Handy key is saved (not tested).' : 'No Handy key yet.'),
            item(done.newer ?? null, `The Handy uses ${mode}.`),
            item(done.hr ?? null, done.hr ? 'The heart-rate strap works.' : 'Heart-rate strap not tested.'),
            item(status?.synctest?.video && status?.synctest?.script ? true : null, status?.synctest?.video && status?.synctest?.script ? 'Sync test ready.' : 'Sync test files not downloaded.')),
        h('p', { class: 'muted' }, 'Anything left open can be done later: Settings in the hub opens this setup again.'));
}

// ---- shell -------------------------------------------------------------------

function paintRail() {
    $('rail').replaceChildren(...STEPS.map((s, i) => {
        const ok = s.ok ? s.ok() : null;
        const li = h('li', { class: [i === at ? 'on' : '', ok === true ? 'ok' : ok === false && !s.optional ? 'warn' : ''].join(' ').trim() },
            h('b', {}, ok === true ? '✓' : String(i + 1)), h('span', {}, s.label));
        li.addEventListener('click', () => go(i));
        return li;
    }));
}

function show() {
    const box = $('step');
    box.replaceChildren();
    STEPS[at].render(box);
    $('back').disabled = at === 0;
    $('next').textContent = at === STEPS.length - 1 ? 'Finish' : at === 0 ? 'Start' : STEPS[at].optional ? 'Next (or skip)' : 'Next';
    paintRail();
}

async function go(i) {
    at = Math.max(0, Math.min(STEPS.length - 1, i));
    if (['library', 'done', 'sync'].includes(STEPS[at].id)) await refresh();
    show();
    window.scrollTo(0, 0);
}

$('back').addEventListener('click', () => go(at - 1));
$('next').addEventListener('click', async () => {
    if (at < STEPS.length - 1) return go(at + 1);
    await post('api/setup/done', { done: true }).catch(() => {});
    location.href = './';
});
$('skipAll').addEventListener('click', async (e) => {
    e.preventDefault();
    await post('api/setup/done', { done: true }).catch(() => {});
    location.href = './';
});

// setup.html#newer opens one step directly.
at = Math.max(0, STEPS.findIndex(s => '#' + s.id === location.hash));
await refresh();
show();
