// Handy Newer Mode for Stash: a top-bar toggle between Stash's own Handy
// support ("Classic", Handy API v2, script upload) and the newer streaming
// mode ("Newer", Handy API v3 HSP, firmware 4): the script's points are sent
// straight into the device buffer, so starting, seeking and changing scenes
// is a flush and refill instead of an upload and download.
//
// In Newer mode Stash's built-in Handy control is silenced: its requests to
// the older Handy API are answered here with "not connected" and never reach
// the device, so only this plugin drives it. Stash's settings are not touched.
// Switching reloads the page.
(function () {
    'use strict';

    const API = 'https://www.handyfeeling.com/api/handy-rest/v3';
    const PLUGIN = 'handyNewer';
    const MODE_KEY = 'handyNewer.mode';          // 'newer' | 'classic'
    const SAVED_KEY = 'handyNewer.stashHandyKey'; // Stash's key while Newer is on
    const CHUNK = 100;
    const REFILL_MS = 2000;
    // Points kept queued ahead (about a minute or two of a busy script). The
    // device may offer room for far more, but filling it all would take many
    // requests, and a pause or seek has to wait for none of them.
    const AHEAD = 600;
    const SYNC_MS = 10000;

    const mode = () => localStorage.getItem(MODE_KEY) === 'newer' ? 'newer' : 'classic';

    // What Stash's own Handy client is told in Newer mode: everything worked,
    // and nothing reaches the device. (Answering "not connected" made Stash
    // show a constant connection error.)
    function quietReply(url) {
        const p = url.replace(/^.*handyfeeling\.com\/api\//, '').split('?')[0];
        if (p.startsWith('sync/upload')) return { url: 'https://www.handyfeeling.com/newer-mode-placeholder.csv' };
        if (p.endsWith('/connected')) return { connected: true };
        if (p.endsWith('/servertime')) return { serverTime: Date.now() };
        if (p.endsWith('/info')) return { fwVersion: '4.0.0', fwStatus: 0, hwVersion: 3, model: 'newer-mode', branch: 'plugin', sessionId: 'plugin' };
        if (p.endsWith('/hssp/setup')) return { result: 1 };
        if (p.endsWith('/mode') || p.endsWith('/status')) return { mode: 1, state: 3, result: 0 };
        if (p.endsWith('/hssp/state')) return { state: 3 };
        if (p.includes('/hstp/')) return { offset: 0, rtd: 0, time: Date.now(), result: 0 };
        return { result: 0 };
    }

    // Silence Stash's own Handy client (API v2, script upload, v1) in Newer
    // mode. It calls the global fetch, so wrapping it here catches every call.
    if (mode() === 'newer' && !window.__handyNewerFetch) {
        const realFetch = window.fetch.bind(window);
        window.__handyNewerFetch = true;
        window.fetch = (input, init) => {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (/handyfeeling\.com\/api\/(handy\/v2|sync|v1)\//.test(url)) {
                return Promise.resolve(new Response(JSON.stringify(quietReply(url)), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            }
            return realFetch(input, init);
        };
    }

    async function gql(query, variables) {
        const r = await fetch('/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
        const j = await r.json();
        if (j.errors) throw new Error(j.errors[0].message);
        return j.data;
    }

    // ---- settings ------------------------------------------------------------

    let cfg = null;
    async function loadConfig() {
        const d = await gql('{ configuration { interface { handyKey funscriptOffset } plugins } }');
        const mine = (d.configuration.plugins || {})[PLUGIN] || {};
        cfg = {
            stashKey: d.configuration.interface.handyKey || '',
            offset: Number(d.configuration.interface.funscriptOffset) || 0,
            connectionKey: String(mine.connectionKey || '').trim(),
            appId: String(mine.appId || '').trim()
        };
        return cfg;
    }

    async function setStashHandyKey(key) {
        await gql('mutation($k:String){ configureInterface(input:{ handyKey: $k }) { handyKey } }', { k: key });
    }

    // ---- toggle ---------------------------------------------------------------

    // The latest status is kept, so one set before the top bar exists (or
    // after Stash redraws it) still shows.
    let pill = null;
    let lastStatus = { text: '', bad: false };
    function status(text, bad) {
        lastStatus = { text: text || '', bad: Boolean(bad) };
        if (!pill || !pill.isConnected) return;
        pill.textContent = lastStatus.text;
        pill.classList.toggle('bad', lastStatus.bad);
    }

    async function toggle() {
        await loadConfig();
        if (mode() === 'classic') {
            if (!cfg.appId) { alert('Handy Newer Mode: add your Handy Application ID in Settings > Plugins > Handy Newer Mode first.'); return; }
            const key = cfg.connectionKey || cfg.stashKey;
            if (!key) { alert('Handy Newer Mode: add your Handy connection key in the plugin settings (or in Stash\'s Interface settings) first.'); return; }
            localStorage.setItem(MODE_KEY, 'newer');
        } else {
            // An earlier version cleared Stash's key; put it back if it did.
            const saved = localStorage.getItem(SAVED_KEY);
            if (saved && !cfg.stashKey) await setStashHandyKey(saved);
            localStorage.removeItem(SAVED_KEY);
            localStorage.setItem(MODE_KEY, 'classic');
            await stopDevice();
        }
        location.reload();
    }

    function addToggle() {
        if (document.getElementById('handy-newer-toggle')) return;
        const bar = document.querySelector('.navbar-buttons');
        if (!bar) return;
        const wrap = document.createElement('span');
        wrap.id = 'handy-newer-toggle';
        wrap.className = 'handy-newer';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-secondary handy-newer-btn' + (mode() === 'newer' ? ' on' : '');
        btn.textContent = mode() === 'newer' ? 'Handy: Newer' : 'Handy: Classic';
        btn.title = mode() === 'newer'
            ? 'The newer streaming mode drives the Handy. Click to go back to Stash\'s own (classic) Handy support.'
            : 'Stash\'s own Handy support is in use. Click to switch to the newer streaming mode (firmware 4).';
        btn.addEventListener('click', () => { toggle().catch(e => alert('Handy Newer Mode: ' + e.message)); });
        pill = document.createElement('span');
        pill.className = 'handy-newer-status';
        wrap.append(btn, pill);
        bar.prepend(wrap);
        status(lastStatus.text, lastStatus.bad);
    }

    // ---- the device (HSP streaming) -------------------------------------------

    let offsetMs = 0;             // client-server clock offset
    let maxPoints = 3000;
    let ready = false;
    let stream = null;            // { points, next, base }
    let refillTimer = 0;
    const scripts = new Map();    // sceneId -> sorted actions

    const headers = () => ({ 'X-Connection-Key': cfg.connectionKey || localStorage.getItem(SAVED_KEY) || cfg.stashKey, 'X-Api-Key': cfg.appId, 'Content-Type': 'application/json' });

    async function call(path, method = 'GET', body) {
        const r = await fetch(API + path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined, credentials: 'omit' });
        let j = null;
        try { j = await r.json(); } catch { /* plain-text body */ }
        if (r.status === 401) throw new Error('Application ID not accepted');
        // The Handy went offline: connect again on the next play.
        if (j?.error?.code === 1001) ready = false;
        if (!r.ok || j?.error) throw new Error(j?.error?.message || `HTTP ${r.status}`);
        return j?.result ?? j;
    }

    async function syncClock() {
        const got = [];
        for (let i = 0; i < 10; i++) {
            const t0 = Date.now();
            try {
                const st = (await (await fetch(API + '/servertime', { headers: { 'X-Api-Key': cfg.appId }, credentials: 'omit' })).json())?.server_time;
                const t1 = Date.now();
                if (Number.isFinite(st)) got.push({ rtd: t1 - t0, off: st + (t1 - t0) / 2 - t1 });
            } catch { /* skip */ }
        }
        if (!got.length) throw new Error('time server unreachable');
        got.sort((a, b) => a.rtd - b.rtd);
        const keep = got.slice(0, Math.ceil(got.length * 0.8));
        offsetMs = keep.reduce((s, x) => s + x.off, 0) / keep.length;
    }
    const serverTime = () => Math.round(Date.now() + offsetMs);

    // Connect when needed: at start, on play, and every 10 s while offline.
    // One attempt at a time, and not more often than every 3 s.
    let connecting = null;
    let connectNote = '';
    let lastTry = 0;
    function ensureConnected() {
        if (ready) return Promise.resolve(true);
        if (connecting) return connecting;
        if (Date.now() - lastTry < 3000) return Promise.resolve(false);
        lastTry = Date.now();
        connecting = connect().then(() => { connectNote = ''; return true; }, (e) => { connectNote = e.message === 'Handy offline' ? 'Handy offline: retrying' : e.message; status(connectNote, true); return false; })
            .finally(() => { connecting = null; });
        return connecting;
    }

    async function connect() {
        status('connecting…');
        const c = await call('/connected');
        if (!c?.connected) throw new Error('Handy offline');
        const info = await call('/info');
        if (info?.fw_status === 2) throw new Error(`firmware update needed (${info.fw_version})`);
        const st = await call('/hsp/setup', 'PUT', {});
        if (Number.isFinite(st?.max_points) && st.max_points > 0) maxPoints = st.max_points;
        await syncClock();
        ready = true;
        status('ready');
    }

    async function scriptFor(sceneId) {
        if (scripts.has(sceneId)) return scripts.get(sceneId);
        const r = await fetch(`/scene/${sceneId}/funscript`);
        if (!r.ok) return null;
        const j = await r.json();
        // As Stash does: "range" rescales positions to 0-100, "inverted" flips them.
        const range = Number(j.range) > 0 ? Number(j.range) : 100;
        const actions = (j.actions || []).filter(a => Number.isFinite(a.at) && Number.isFinite(a.pos))
            .map(a => { let pos = a.pos * 100 / range; if (j.inverted === true) pos = 100 - pos; return { at: a.at, pos: Math.max(0, Math.min(100, pos)) }; })
            .sort((a, b) => a.at - b.at);
        scripts.set(sceneId, actions);
        return actions;
    }

    function pointsFrom(actions, startMs) {
        let lo = 0, hi = actions.length - 1, first = 0;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (actions[mid].at <= startMs) { first = mid; lo = mid + 1; } else hi = mid - 1; }
        return { base: first, next: 0, points: actions.slice(first).map(a => ({ t: Math.max(0, Math.round(a.at)), x: Math.max(0, Math.min(100, Math.round(a.pos))) })) };
    }

    function chunk(s, flush) {
        const pts = s.points.slice(s.next, s.next + CHUNK);
        s.next += pts.length;
        return { points: pts, flush, tail_point_stream_index: Math.max(1, s.base + s.next) };
    }

    async function topUp() {
        const s = stream;
        // One sender at a time, so points always arrive in order.
        if (!s || s.sending || s.next >= s.points.length) return;
        s.sending = true;
        try { await topUpNow(s); } finally { s.sending = false; }
    }

    async function topUpNow(s) {
        let st;
        try { st = await call('/hsp/state'); } catch { return; }
        // Points still queued on the device. The buffer drops its oldest
        // points as new ones arrive, so this is counted inside the buffer,
        // never from where the stream started.
        const queued = (st?.points ?? 0) - 1 - (st?.current_point ?? 0);
        if (Number.isFinite(queued) && queued > Math.min(maxPoints, AHEAD) / 2) return;
        for (let i = 0; i < 3 && stream === s && s.next < s.points.length; i++) {
            try { await call('/hsp/add', 'PUT', chunk(s, false)); } catch { return; }
        }
    }

    async function playFrom(actions, ms) {
        const s = pointsFrom(actions, ms);
        stream = s;
        clearInterval(refillTimer);
        await call('/hsp/play', 'PUT', { start_time: Math.max(0, Math.round(ms)), server_time: serverTime(), playback_rate: 1, pause_on_starving: false, add: chunk(s, true) });
        // The rest is filled in the background, so this returns as soon as the
        // device is playing; a pause or seek (stream changes) stops the filling.
        if (stream !== s) return;
        refillTimer = setInterval(topUp, REFILL_MS);
        (async () => {
            s.sending = true;
            const goal = Math.min(s.points.length, Math.min(maxPoints, AHEAD));
            try {
                while (stream === s && s.next < goal) await call('/hsp/add', 'PUT', chunk(s, false));
            } catch { /* the next top-up retries */ } finally { s.sending = false; }
        })();
    }

    async function stopDevice() {
        stream = null;
        clearInterval(refillTimer);
        if (!cfg?.appId) return;
        try { await call('/hsp/stop', 'PUT'); } catch { /* already stopped */ }
    }

    // ---- following Stash's player ----------------------------------------------

    let video = null;
    let sceneId = null;
    let actions = null;
    let busy = false;
    let again = false;
    let syncTimer = 0;

    const sceneFromUrl = () => (location.pathname.match(/^\/scenes\/(\d+)/) || [])[1] || null;

    // One command at a time; each run reads the player's state at that moment.
    async function sync() {
        if (busy) { again = true; return; }
        busy = true;
        try {
            do {
                again = false;
                if (!video || !actions) break;
                if (!ready) {
                    if (video.paused) break;
                    if (!(await ensureConnected())) break;
                }
                const playing = !video.paused && !video.seeking && !video.ended && video.readyState >= 3;
                if (playing) {
                    await playFrom(actions, video.currentTime * 1000 + cfg.offset);
                    status('synced');
                } else {
                    await stopDevice();
                    status(video.paused ? 'paused' : 'buffering');
                }
            } while (again);
        } catch (e) {
            status(e.message, true);
        } finally {
            busy = false;
        }
    }

    const EVENTS = ['play', 'playing', 'pause', 'seeking', 'seeked', 'waiting', 'ended', 'ratechange'];

    // Returns true when a different player element was picked up.
    function attach(v) {
        if (video === v) return false;
        if (video) EVENTS.forEach(ev => video.removeEventListener(ev, sync));
        video = v;
        if (video) EVENTS.forEach(ev => video.addEventListener(ev, sync));
        return true;
    }

    async function onPage() {
        const id = sceneFromUrl();
        if (id !== sceneId) {
            sceneId = id;
            actions = null;
            await stopDevice();
            if (id) {
                status('loading script…');
                try {
                    actions = await scriptFor(id);
                    if (!actions?.length) status('no script', true);
                    else status(ready ? 'ready' : (connectNote || 'connecting…'), !ready);
                } catch (e) { status('script: ' + e.message, true); }
            } else status(ready ? 'ready' : '');
        }
        // The scene's main player, never a preview or marker clip.
        const changed = attach(id ? (document.querySelector('.video-js video.vjs-tech') || document.querySelector('#VideoJsPlayer video') || document.querySelector('.video-js video')) : null);
        // Only a newly found player that is already running needs a sync here;
        // after that the player's own events drive every command.
        if (changed && id && video && !video.paused) sync();
    }

    async function startNewer() {
        await loadConfig();
        if (!cfg.appId) { status('no App ID', true); return; }
        await ensureConnected();
        setInterval(() => { if (!ready) ensureConnected().then(ok => { if (ok && video && !video.paused) sync(); }); }, 10000);
        clearInterval(syncTimer);
        syncTimer = setInterval(() => {
            if (!ready || !stream || !video || video.paused) return;
            call('/hsp/synctime', 'PUT', { current_time: Math.round(video.currentTime * 1000 + cfg.offset), server_time: serverTime(), filter: 0.5 }).catch(() => {});
        }, SYNC_MS);
        setInterval(() => { onPage().catch(() => {}); }, 1000);
        onPage().catch(() => {});
        window.addEventListener('pagehide', () => {
            try { fetch(API + '/hsp/stop', { method: 'PUT', headers: headers(), keepalive: true, credentials: 'omit' }); } catch { /* leaving */ }
        });
    }

    // For troubleshooting from the browser console: __handyNewer.state
    window.__handyNewer = { get state() { return { mode: mode(), ready, sceneId, hasVideo: Boolean(video), actions: actions ? actions.length : null, streaming: Boolean(stream), busy, maxPoints, status: lastStatus.text }; } };

    new MutationObserver(addToggle).observe(document.body, { childList: true, subtree: true });
    addToggle();
    if (mode() === 'newer') startNewer().catch(e => status(e.message, true));
})();
