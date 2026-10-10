// Loop hub: browse every scripted scene from Stash's metadata and watch with
// The Handy in its newer streaming mode (classic as the fallback). No heart
// rate needed here; the heart-rate sessions are one click away.
import { createHandyLink } from './handy-link.js';
import { cueAt } from '../player/thumbs.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const PAGE = 60;
// Tags named like a library folder: every scene in that folder carries them,
// so they are useless for "similar". Filled from the library on load.
let FOLDER_TAGS = new Set();

let scenes = [];
let byId = new Map();
const filters = { q: '', folder: '', performer: null, tag: null, only4k: false, durMin: 0, durMax: 10 };
// Length slider stops, in minutes: 0 = no lower limit, the last = no upper limit (1h+).
const DUR_STOPS = [0, 1, 2, 3, 5, 10, 15, 20, 30, 45, 60];
let reversed = false;
let sort = 'added';
let shuffleSeed = Math.random();
let shown = 0;
let list = [];

const fmt = (sec) => {
    sec = Math.floor(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
};
// Small cached WebP copies made by the server (see server/thumbs.js).
// thumbGen changes when the pictures are rebuilt, so the browser fetches new ones.
let thumbGen = 0;
const shot = (id, w = 480) => `thumb/scene/${id}?w=${w}&g=${thumbGen}`;
const heat = (id) => `stash/scene/${id}/interactive_heatmap`;
const res = (h) => (h >= 2000 ? '4K' : h >= 1400 ? '1440p' : h >= 1000 ? '1080p' : h >= 700 ? '720p' : '');

// ---- data ----------------------------------------------------------------------

let syncedAt = null;

async function load(refresh = false) {
    $('count').textContent = 'Loading your library…';
    try {
        const r = await fetch('api/hub/scenes' + (refresh ? '?refresh=1' : ''));
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        scenes = d.scenes;
        thumbGen = d.thumbGen || 0;
        syncedAt = d.syncedAt;
        byId = new Map(scenes.map(s => [s.id, s]));
        FOLDER_TAGS = new Set(scenes.map(s => (s.folder || '').toLowerCase()).filter(Boolean));
    } catch (e) {
        $('count').textContent = 'Could not load the library: ' + (e.message || e) + ' (is Stash running?)';
        return;
    }
    renderFolders();
    route();
}

// ---- browse --------------------------------------------------------------------

function renderFolders() {
    const counts = {};
    for (const s of scenes) counts[s.folder] = (counts[s.folder] || 0) + 1;
    // Biggest folder first; a library kept in one folder shows no folder chips.
    const names = Object.keys(counts).filter(Boolean).sort((a, b) => counts[b] - counts[a]);
    const chip = (value, label, n) => {
        const c = el('span', 'chip' + (filters.folder === value ? ' on' : ''), label);
        if (n != null) c.append(el('span', 'n', String(n)));
        c.addEventListener('click', () => { filters.folder = filters.folder === value ? '' : value; renderFolders(); renderGrid(); });
        return c;
    };
    // Short folder names read as abbreviations: "pmv" shows as PMV.
    const label = (f) => (f.length <= 3 ? f.toUpperCase() : f);
    $('folders').replaceChildren(chip('', 'All', scenes.length), ...(names.length > 1 ? names : []).map(f => chip(f, label(f), counts[f])));
}

function renderFilters() {
    const chips = [];
    if (filters.performer) {
        const c = el('span', 'chip', filters.performer.name);
        c.addEventListener('click', () => { filters.performer = null; renderGrid(); });
        chips.push(c);
    }
    if (filters.tag) {
        const c = el('span', 'chip', '#' + filters.tag);
        c.addEventListener('click', () => { filters.tag = null; renderGrid(); });
        chips.push(c);
    }
    $('filters').replaceChildren(...chips);
}

function matches(s) {
    if (filters.folder && s.folder !== filters.folder) return false;
    if (filters.only4k && !(s.height >= 2000)) return false;
    const mins = s.duration / 60;
    if (filters.durMin > 0 && mins < DUR_STOPS[filters.durMin]) return false;
    if (filters.durMax < DUR_STOPS.length - 1 && mins > DUR_STOPS[filters.durMax]) return false;
    if (filters.performer && !s.performers.some(p => p.id === filters.performer.id)) return false;
    if (filters.tag && !s.tags.includes(filters.tag)) return false;
    const q = filters.q.trim().toLowerCase();
    if (!q) return true;
    return q.split(/\s+/).every(w => s.title.toLowerCase().includes(w) || (s.studio || '').toLowerCase().includes(w)
        || s.performers.some(p => p.name.toLowerCase().includes(w)) || s.tags.some(t => t.toLowerCase().includes(w)));
}

function seeded(id) {
    // Stable random order until the next shuffle.
    let h = 2166136261 ^ Math.floor(shuffleSeed * 1e9);
    for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return (h >>> 0) / 4294967296;
}

function sorted(arr) {
    const by = {
        added: (a, b) => String(b.added).localeCompare(String(a.added)),
        random: (a, b) => seeded(a.id) - seeded(b.id),
        plays: (a, b) => b.plays - a.plays,
        unplayed: (a, b) => a.plays - b.plays || seeded(a.id) - seeded(b.id),
        long: (a, b) => b.duration - a.duration,
        short: (a, b) => a.duration - b.duration,
        fast: (a, b) => (b.speed ?? -1) - (a.speed ?? -1),
        slow: (a, b) => (a.speed ?? 1e9) - (b.speed ?? 1e9)
    }[sort];
    const out = [...arr].sort(by);
    return reversed ? out.reverse() : out;
}

function renderGrid() {
    renderFilters();
    list = sorted(scenes.filter(matches));
    shown = 0;
    $('grid').replaceChildren();
    $('count').textContent = `${list.length} of ${scenes.length} scripted scenes`;
    more();
}

function more() {
    const next = list.slice(shown, shown + PAGE);
    shown += next.length;
    $('grid').append(...next.map(card));
}

function card(s) {
    const a = el('a', 'card');
    a.href = `#/watch/${s.id}`;
    const t = el('div', 'thumb');
    // A real <img>, so the browser loads it lazily just ahead of the scroll.
    const pic = el('img', 'timg');
    pic.loading = 'lazy';
    pic.decoding = 'async';
    pic.alt = '';
    pic.src = shot(s.id);
    t.append(pic);
    t.append(el('span', 'badge dur', fmt(s.duration)));
    if (res(s.height)) t.append(el('span', 'badge res', res(s.height)));
    if (s.markers.length) t.append(el('span', 'badge mk', `${s.markers.length} parts`));
    // Hover preview: Stash's short preview clip.
    let timer = 0;
    a.addEventListener('mouseenter', () => { timer = setTimeout(() => { const v = el('video'); v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true; v.src = `stash/scene/${s.id}/preview`; t.append(v); }, 350); });
    a.addEventListener('mouseleave', () => { clearTimeout(timer); t.querySelector('video')?.remove(); });
    const h = el('img', 'heatbar');
    h.loading = 'lazy';
    h.alt = '';
    h.src = heat(s.id);
    const body = el('div', 'body');
    body.append(el('div', 't', s.title));
    const p = el('div', 'p');
    const people = s.performers.filter(x => x.gender !== 'MALE');
    if (people.length) {
        people.slice(0, 3).forEach((x, i) => {
            if (i) p.append(', ');
            const link = el('a', null, x.name);
            link.href = '#/';
            link.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); filterPerformer(x); });
            p.append(link);
        });
    } else p.textContent = s.studio || s.folder;
    body.append(p);
    a.append(t, h, body);
    return a;
}

function filterPerformer(p) {
    filters.performer = { id: p.id, name: p.name };
    location.hash = '#/';
    renderGrid();
}

function filterTag(tag) {
    filters.tag = tag;
    location.hash = '#/';
    renderGrid();
}

// ---- watch ---------------------------------------------------------------------

const link = createHandyLink({
    onState: ({ text, tone }) => {
        for (const id of ['handyState', 'syncState']) {
            $(id).textContent = text;
            $(id).className = 'pill' + (tone ? ' ' + tone : '');
        }
    }
});
link.attach($('video'));
$('offset').textContent = String(link.offset);

let watching = null;

function similar(cur, n) {
    const perf = new Set(cur.performers.map(p => p.id));
    const tags = new Set(cur.tags.filter(t => !FOLDER_TAGS.has(t.toLowerCase())));
    const score = (s) => 4 * s.performers.filter(p => perf.has(p.id)).length
        + (cur.studio && s.studio === cur.studio ? 2 : 0)
        + 0.5 * s.tags.filter(t => tags.has(t)).length
        + Math.random() * 2;
    return scenes.filter(s => s.id !== cur.id).map(s => ({ s, k: score(s) })).sort((a, b) => b.k - a.k).slice(0, n).map(x => x.s);
}

function renderSide(cur) {
    // Half from the same performer(s) when there are any, the rest similar
    // scenes (studio, shared tags) by others.
    const perf = new Set(cur.performers.filter(p => p.gender !== 'MALE').map(p => p.id));
    const same = perf.size ? scenes.filter(s => s.id !== cur.id && s.performers.some(p => perf.has(p.id)))
        .map(s => ({ s, k: Math.random() })).sort((a, b) => a.k - b.k).slice(0, 3).map(x => x.s) : [];
    const taken = new Set([cur.id, ...same.map(s => s.id)]);
    // Ranked over the whole library, so a performer with many scenes cannot
    // crowd out every "similar" pick.
    const others = similar(cur, scenes.length).filter(s => !taken.has(s.id) && !s.performers.some(p => perf.has(p.id))).slice(0, 6 - same.length);
    const tile = (s) => {
        const t = el('a', 'tile');
        t.href = `#/watch/${s.id}`;
        t.style.backgroundImage = `url("${shot(s.id)}")`;
        t.append(el('span', 'tdur', fmt(s.duration)));
        const text = el('div', 'ttext');
        text.append(el('div', 'tt', s.title));
        const who = s.performers.filter(x => x.gender !== 'MALE').map(x => x.name).slice(0, 2).join(', ');
        if (who) text.append(el('div', 'tw', who));
        const h = el('img', 'theat');
        h.alt = '';
        h.src = heat(s.id);
        t.append(text, h);
        return t;
    };
    const parts = [];
    if (same.length) parts.push(el('div', 'side-label', 'Same performer'), ...same.map(tile));
    if (others.length) parts.push(el('div', 'side-label', 'Similar'), ...others.map(tile));
    $('sideList').replaceChildren(...parts);
}

function openWatch(id) {
    const s = byId.get(id);
    if (!s) { location.hash = '#/'; return; }
    $('browse').classList.add('hidden');
    $('watch').classList.remove('hidden');
    if (watching === id) return;
    watching = id;
    const v = $('video');
    v.src = `stash/scene/${id}/stream`;
    $('heatImg').src = heat(id);
    $('title').textContent = s.title;
    const who = $('who');
    who.replaceChildren();
    const people = s.performers.filter(x => x.gender !== 'MALE');
    people.forEach((p, i) => {
        if (i) who.append(', ');
        const a = el('a', null, p.name);
        a.href = '#/';
        a.addEventListener('click', (e) => { e.preventDefault(); filterPerformer(p); });
        who.append(a);
    });
    if (s.studio && !people.some(p => p.name === s.studio)) who.append((people.length ? ' · ' : '') + s.studio);
    $('markers').replaceChildren(...s.markers.map(m => {
        const c = el('span', 'chip', `${m.name || m.title} · ${fmt(m.at)}`);
        c.addEventListener('click', () => { v.currentTime = m.at; v.play().catch(() => {}); });
        return c;
    }));
    // Tags: on hover over the title, and clickable from the browse page.
    $('title').title = s.tags.filter(t => !FOLDER_TAGS.has(t.toLowerCase())).join(', ');
    loadThumbs(id);
    renderSide(s);
    link.setScene(id);
    $('halfBtn').classList.remove('on');
    document.title = s.title + ' · Loop';
    v.play().catch(() => {});
}

function closeWatch() {
    if (!watching) return;
    watching = null;
    const v = $('video');
    v.pause();
    v.removeAttribute('src');
    v.load();
    link.leave();
    document.title = 'Loop Hub';
}

// ---- the control strip: play, time, the heatmap seek bar with previews ------

const video = $('video');
const VOL_KEY = 'hub_volume';
video.volume = Math.max(0, Math.min(1, Number(localStorage.getItem(VOL_KEY) ?? 1)));
$('vol').value = String(video.volume);
$('vol').addEventListener('input', () => { video.volume = Number($('vol').value); video.muted = false; localStorage.setItem(VOL_KEY, $('vol').value); });

const togglePlay = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
$('playBtn').addEventListener('click', togglePlay);
video.addEventListener('click', togglePlay);
video.addEventListener('dblclick', () => toggleFullscreen());
const renderTime = () => {
    $('time').textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
    $('played').style.width = video.duration ? (100 * video.currentTime / video.duration) + '%' : '0';
};
video.addEventListener('timeupdate', renderTime);
video.addEventListener('loadedmetadata', renderTime);
for (const ev of ['play', 'pause', 'ended']) video.addEventListener(ev, () => { $('playBtn').textContent = video.paused ? '▶' : '❚❚'; });

function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else $('stage').requestFullscreen().catch(() => {});
}
$('fsBtn').addEventListener('click', toggleFullscreen);

// Half speed: the half-speed version of the script, in sync with the video.
async function toggleHalf() {
    const on = await link.setHalf(!link.half);
    $('halfBtn').classList.toggle('on', on);
}
$('halfBtn').addEventListener('click', toggleHalf);

// Stroke range: two handles on one track; the Handy scales every stroke into it.
function renderStroke(r) {
    $('strokeMin').value = String(r.min);
    $('strokeMax').value = String(r.max);
    $('strokeVal').textContent = `${r.min}–${r.max}%`;
    $('dual').style.setProperty('--track', `linear-gradient(to right, rgba(255,255,255,0.15) ${r.min}%, var(--accent) ${r.min}%, var(--accent) ${r.max}%, rgba(255,255,255,0.15) ${r.max}%)`);
}
function strokeInput(e) {
    let min = Number($('strokeMin').value), max = Number($('strokeMax').value);
    // The handles cannot cross: the one being moved stops at the other.
    if (min > max - 10) { if (e.target.id === 'strokeMin') min = max - 10; else max = min + 10; }
    renderStroke(link.setStroke(min, max));
}
$('strokeMin').addEventListener('input', strokeInput);
$('strokeMax').addEventListener('input', strokeInput);
link.onStroke(renderStroke);
renderStroke(link.stroke || { min: 0, max: 100 });

$('seek').addEventListener('click', (e) => {
    if (!video.duration) return;
    const r = $('seek').getBoundingClientRect();
    video.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * video.duration;
});

// Stash's scrubber sprites: a picture of the moment under the mouse.
const PREVIEW_SCALE = 1.5;
let thumbs = { sprite: null, cues: [], sheetW: 0, sheetH: 0, sceneId: null };
function loadThumbs(sceneId) {
    thumbs = { sprite: null, cues: [], sheetW: 0, sheetH: 0, sceneId };
    fetch(`api/scene/${sceneId}/thumbs`).then(r => r.json()).then(({ sprite, cues }) => {
        if (thumbs.sceneId !== sceneId || !sprite || !cues?.length) return;
        const img = new Image();
        img.onload = () => { if (thumbs.sceneId === sceneId) thumbs = { sprite, cues, sheetW: img.naturalWidth, sheetH: img.naturalHeight, sceneId }; };
        img.src = sprite;
    }).catch(() => {});
}
$('seek').addEventListener('mousemove', (e) => {
    if (!video.duration) return;
    const seekBox = $('seek').getBoundingClientRect();
    const box = $('controls').getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - seekBox.left) / seekBox.width)) * video.duration;
    const img = $('previewImg');
    const cue = thumbs.sprite ? cueAt(thumbs.cues, t) : null;
    let width = 60;
    if (cue) {
        width = cue.w * PREVIEW_SCALE;
        img.style.width = `${width}px`;
        img.style.height = `${cue.h * PREVIEW_SCALE}px`;
        img.style.backgroundImage = `url("${thumbs.sprite}")`;
        img.style.backgroundSize = `${thumbs.sheetW * PREVIEW_SCALE}px ${thumbs.sheetH * PREVIEW_SCALE}px`;
        img.style.backgroundPosition = `-${cue.x * PREVIEW_SCALE}px -${cue.y * PREVIEW_SCALE}px`;
    } else img.removeAttribute('style');
    $('previewTime').textContent = fmt(t);
    const left = Math.max(4, Math.min(box.width - width - 4, e.clientX - box.left - width / 2));
    const p = $('preview');
    p.style.left = `${left}px`;
    p.style.width = `${width}px`;
    p.style.bottom = `${box.bottom - seekBox.top + 8}px`;
    p.classList.remove('hidden');
});
$('seek').addEventListener('mouseleave', () => $('preview').classList.add('hidden'));
$('shuffleBtn').addEventListener('click', () => { const s = byId.get(watching); if (s) renderSide(s); });
$('offMinus').addEventListener('click', () => { $('offset').textContent = String(link.nudgeOffset(-50)); });
$('offPlus').addEventListener('click', () => { $('offset').textContent = String(link.nudgeOffset(50)); });

// ---- settings ----------------------------------------------------------------

let settingsTimer = 0;
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

async function showThumbStatus() {
    try {
        const t = await (await fetch('api/thumbs')).json();
        const building = t.running && t.total;
        $('thumbInfo').textContent = building
            ? `Building… ${t.done} of ${t.total}`
            : `${t.files} pictures ready (${mb(t.bytes)})`;
        $('thumbBar').style.width = building ? (100 * t.done / t.total).toFixed(1) + '%' : '0';
        $('thumbRebuild').disabled = !!t.running;
        // A rebuild changes the generation; pick it up so grids load the new copies.
        if (t.generation !== thumbGen) { thumbGen = t.generation; $('grid').replaceChildren(); $('pGrid').replaceChildren(); }
    } catch { $('thumbInfo').textContent = 'Server not reachable'; }
}

function openSettings() {
    $('libInfo').textContent = `${scenes.length} scripted scenes` + (syncedAt ? `, read ${new Date(syncedAt).toLocaleTimeString()}` : '');
    showThumbStatus();
    clearInterval(settingsTimer);
    settingsTimer = setInterval(showThumbStatus, 1500);
}
function closeSettings() { clearInterval(settingsTimer); settingsTimer = 0; }

$('thumbRebuild').addEventListener('click', async () => {
    if (!confirm('Throw away all the small pictures and make them again from Stash? This takes a few minutes.')) return;
    $('thumbRebuild').disabled = true;
    await fetch('api/thumbs/rebuild', { method: 'POST' }).catch(() => {});
    showThumbStatus();
});
$('libRefresh').addEventListener('click', async () => {
    $('libRefresh').disabled = true;
    $('libInfo').textContent = 'Reading…';
    await load(true);
    $('grid').replaceChildren(); $('pGrid').replaceChildren();
    $('libRefresh').disabled = false;
    openSettings();
});

// ---- routing and keys ----------------------------------------------------------

function showView(name) {
    for (const v of ['browse', 'performers', 'calibrate', 'settings', 'watch']) $(v).classList.toggle('hidden', v !== name);
    document.querySelectorAll('.topbar [data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === (name === 'calibrate' ? 'settings' : name)));
}

function route() {
    const m = location.hash.match(/^#\/watch\/(\d+)/);
    if (m) { closeCalibrate(); showView('watch'); openWatch(m[1]); return; }
    closeWatch();
    if (location.hash.startsWith('#/performers')) { closeCalibrate(); showView('performers'); renderPerformers(); return; }
    if (location.hash.startsWith('#/calibrate')) { showView('calibrate'); openCalibrate(); return; }
    closeCalibrate();
    if (location.hash.startsWith('#/settings')) { showView('settings'); openSettings(); return; }
    closeSettings();
    showView('browse');
    if (!$('grid').childElementCount) renderGrid();
}

window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => link.stopOnUnload());

let typing = 0;
$('search').addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => { filters.q = $('search').value; renderGrid(); }, 150);
});
$('sort').addEventListener('change', () => { sort = $('sort').value; if (sort === 'random') shuffleSeed = Math.random(); renderGrid(); });

// More cards as the end comes into view (and on scroll, as a fallback).
window.addEventListener('scroll', () => { if (shown < list.length && window.innerHeight + window.scrollY > document.body.scrollHeight - 1200) more(); }, { passive: true });
new IntersectionObserver((entries) => { if (entries.some(e => e.isIntersecting) && shown < list.length) more(); }, { rootMargin: '1600px' }).observe($('more'));

document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (!watching) return;
    const v = $('video');
    if (e.target === v) return;   // the player's own keys
    if (e.code === 'Space') { e.preventDefault(); if (v.paused) v.play().catch(() => {}); else v.pause(); }
    else if (e.code === 'BracketLeft') $('offset').textContent = String(link.nudgeOffset(-50));
    else if (e.code === 'BracketRight') $('offset').textContent = String(link.nudgeOffset(50));
    else if (e.code === 'KeyF') toggleFullscreen();
    else if (e.code === 'KeyH') toggleHalf();
    else if (e.code === 'ArrowRight') { e.preventDefault(); v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 10); }
    else if (e.code === 'Escape' && !document.fullscreenElement) location.hash = '#/';
});

// A new install goes through setup.html first (once; Settings opens it again).
fetch('api/setup/state').then(r => r.json()).then(s => {
    if (s && s.done === false) location.replace('setup.html');
    else if (s?.stashUrl) $('openStash').href = s.stashUrl + '/';
}).catch(() => {});
load();

// ---- browse controls -------------------------------------------------------------

let durTimer = 0;
function durLabel() {
    const lo = filters.durMin, hi = filters.durMax, last = DUR_STOPS.length - 1;
    if (lo === 0 && hi === last) return 'any';
    const m = (i) => i === last ? '1h+' : DUR_STOPS[i] + 'm';
    if (lo === 0) return 'up to ' + m(hi);
    if (hi === last) return m(lo) + ' and up';
    return m(lo) + ' – ' + m(hi);
}
function renderDur() {
    const last = DUR_STOPS.length - 1;
    $('durMin').value = String(filters.durMin);
    $('durMax').value = String(filters.durMax);
    $('durVal').textContent = durLabel();
    const a = 100 * filters.durMin / last, b = 100 * filters.durMax / last;
    $('durDual').style.setProperty('--track', 'linear-gradient(to right, rgba(255,255,255,0.15) ' + a + '%, var(--accent) ' + a + '%, var(--accent) ' + b + '%, rgba(255,255,255,0.15) ' + b + '%)');
}
function durInput(e) {
    let lo = Number($('durMin').value), hi = Number($('durMax').value);
    if (lo > hi) { if (e.target.id === 'durMin') lo = hi; else hi = lo; }
    filters.durMin = lo;
    filters.durMax = hi;
    renderDur();
    clearTimeout(durTimer);
    durTimer = setTimeout(renderGrid, 120);
}
$('durMin').addEventListener('input', durInput);
$('durMax').addEventListener('input', durInput);
renderDur();
// A chip like the folder ones: lights up while on.
$('only4k').addEventListener('click', () => {
    filters.only4k = !filters.only4k;
    $('only4k').classList.toggle('on', filters.only4k);
    $('only4k').setAttribute('aria-pressed', String(filters.only4k));
    renderGrid();
});
$('dirBtn').addEventListener('click', () => { reversed = !reversed; $('dirBtn').textContent = reversed ? '↑' : '↓'; renderGrid(); });

// ---- performers ----------------------------------------------------------------------

let performerList = null;
function buildPerformers() {
    const map = new Map();
    for (const sc of scenes) for (const p of sc.performers) {
        if (p.gender === 'MALE') continue;
        const e = map.get(p.id) || { id: p.id, name: p.name, scenes: 0, latest: '' };
        e.scenes++;
        if (String(sc.added) > e.latest) e.latest = String(sc.added);
        map.set(p.id, e);
    }
    performerList = [...map.values()];
}
function renderPerformers() {
    if (!scenes.length) return;
    if (!performerList) buildPerformers();
    const q = $('pSearch').value.trim().toLowerCase();
    const by = {
        scenes: (a, b) => b.scenes - a.scenes || a.name.localeCompare(b.name),
        name: (a, b) => a.name.localeCompare(b.name),
        recent: (a, b) => b.latest.localeCompare(a.latest)
    }[$('pSort').value];
    const shownList = performerList.filter(p => !q || p.name.toLowerCase().includes(q)).sort(by);
    $('pCount').textContent = shownList.length + ' performers in your scripted scenes';
    $('pGrid').replaceChildren(...shownList.map(p => {
        const a = el('a', 'pcard');
        a.href = '#/';
        a.addEventListener('click', (e) => { e.preventDefault(); filterPerformer(p); });
        const img = el('div', 'pimg');
        img.style.backgroundImage = 'url("thumb/performer/' + p.id + '?w=320&g=' + thumbGen + '")';
        a.append(img, el('div', 'pname', p.name), el('div', 'pmeta', p.scenes + (p.scenes === 1 ? ' scene' : ' scenes')));
        return a;
    }));
}
$('pSearch').addEventListener('input', () => renderPerformers());
$('pSort').addEventListener('change', () => renderPerformers());

// ---- calibrate: the sync test ---------------------------------------------------------

let calOn = false;
function parseScript(name, text) {
    if (/\.funscript$/i.test(name)) return JSON.parse(text).actions || [];
    return text.split(/\r?\n/)
        .filter(l => l && !l.startsWith('#'))
        .map(l => l.split(','))
        .filter(p => p.length >= 2)
        .map(([at, pos]) => ({ at: Number(at), pos: Number(pos) }))
        .filter(a => Number.isFinite(a.at) && Number.isFinite(a.pos));
}
async function openCalibrate() {
    if (calOn) return;
    calOn = true;
    const v = $('calVideo');
    renderCalOffset();
    link.attach(v);
    let test = {};
    try { test = await (await fetch('api/synctest')).json(); } catch { /* shown below */ }
    if (!test.video || !test.script) {
        // The Handy's own sync test, as published by Sweet Tech.
        const a = (href, text) => { const e = el('a', null, text); e.href = href; e.target = '_blank'; e.rel = 'noopener noreferrer'; return e; };
        $('calNote').replaceChildren('Download the Handy sync test ',
            a('https://playground.handyfeeling.com/assets/sync_video_2021.mp4', 'video'), ' and ',
            a('https://sweettecheu.s3.eu-central-1.amazonaws.com/testsync/sync_video_2021.csv', 'script'),
            ' into the Synctest folder (next to the server folder), then reload. Any video with its .csv or .funscript works too.');
        return;
    }
    const actions = parseScript(test.script, await (await fetch(test.script)).text());
    $('calNote').textContent = decodeURIComponent(test.video.split('/').pop()) + ' · ' + actions.length + ' points';
    v.src = test.video;
    v.loop = true;
    link.setLocal('synctest', { actions });
}
function closeCalibrate() {
    if (!calOn) return;
    calOn = false;
    const v = $('calVideo');
    v.pause();
    v.removeAttribute('src');
    v.load();
    link.leave();
    link.attach($('video'));
}
function renderCalOffset() {
    $('calOffset').textContent = (link.offset > 0 ? '+' : '') + link.offset;
    $('calSlider').value = String(link.offset);
    $('offset').textContent = String(link.offset);
}
$('calSlider').addEventListener('input', () => { link.nudgeOffset(Number($('calSlider').value) - link.offset); renderCalOffset(); });
document.querySelectorAll('.cal-row [data-d]').forEach(b => b.addEventListener('click', () => {
    const d = b.dataset.d;
    link.nudgeOffset(d === 'reset' ? -link.offset : Number(d));
    renderCalOffset();
}));
$('calPlay').addEventListener('click', () => { const v = $('calVideo'); if (v.paused) v.play().catch(() => {}); else v.pause(); });
$('calRestart').addEventListener('click', () => { const v = $('calVideo'); v.currentTime = 0; v.play().catch(() => {}); });
$('calVideo').addEventListener('click', () => $('calPlay').click());
for (const ev of ['play', 'pause']) $('calVideo').addEventListener(ev, () => { $('calPlay').textContent = $('calVideo').paused ? 'Play' : 'Pause'; });
