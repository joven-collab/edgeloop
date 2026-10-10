// The Handy on the newer interface (REST API v3, firmware 4): the streaming
// protocol (HSP). Nothing is uploaded: the player keeps each script here and
// streams its points straight into the device's buffer, so a new scene, a
// jump or a half-speed switch is a flush and a refill instead of an upload
// and a download. Same surface as handy-hssp.js, so the player can use either.
//
// Only point timing and positions leave the PC, as with the classic mode.

export const API_V3 = 'https://www.handyfeeling.com/api/handy-rest/v3';
export const CHUNK = 100;          // most points one add call may carry
export const REFILL_MS = 2000;     // how often the buffer is topped up
export const LOW_WATER = 0.5;      // refill once less than this share is ahead
// Points kept queued ahead. Firmware 4.2 offers room for 100,000, but filling
// that would take hundreds of requests, and a pause or seek must not wait.
export const AHEAD = 600;

// Points from just before `startMs` onward, as the device wants them.
export function pointsFrom(actions, startMs) {
    let lo = 0, hi = actions.length - 1, first = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (actions[mid].at <= startMs) { first = mid; lo = mid + 1; } else hi = mid - 1; }
    return { first, points: actions.slice(first).map(a => ({ t: Math.max(0, Math.round(a.at)), x: Math.max(0, Math.min(100, Math.round(a.pos))) })) };
}

export function createHandyV3(connectionKey, appId, { fetchImpl = fetch, now = () => Date.now(), setTimer = setInterval, clearTimer = clearInterval } = {}) {
    let offset = 0;
    let loadedUrl = null;
    let maxPoints = 3000;
    let stream = null;        // { points, next } of the script being played
    let refill = 0;
    let rate = 1;
    const scripts = new Map();

    const headers = () => ({
        'X-Connection-Key': connectionKey,
        'X-Api-Key': appId,
        'Content-Type': 'application/json',
        Accept: 'application/json'
    });

    async function call(path, method = 'GET', body) {
        const r = await fetchImpl(API_V3 + path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
        let j = null;
        try { j = await r.json(); } catch { /* empty or plain-text body */ }
        if (r.status === 401) throw new Error('The Handy service did not accept the Application ID (Settings, Handy tab).');
        if (!r.ok || j?.error) throw new Error(`Handy ${method} ${path}: ${j?.error?.message || `HTTP ${r.status}`}`);
        return j?.result ?? j;
    }

    async function syncTime(samples = 10) {
        const got = [];
        for (let i = 0; i < samples; i++) {
            const t0 = now();
            try {
                const r = await fetchImpl(`${API_V3}/servertime`, { headers: { 'X-Api-Key': appId } });
                const st = (await r.json())?.server_time;
                const t1 = now();
                if (Number.isFinite(st)) got.push({ rtd: t1 - t0, offset: st + (t1 - t0) / 2 - t1 });
            } catch { /* skip sample */ }
        }
        if (!got.length) throw new Error('Could not reach the Handy time server.');
        got.sort((a, b) => a.rtd - b.rtd);
        const keep = got.slice(0, Math.max(1, Math.ceil(got.length * 0.8)));
        offset = keep.reduce((s, x) => s + x.offset, 0) / keep.length;
        return offset;
    }

    const serverTime = () => Math.round(now() + offset);

    let info = null;
    async function connect() {
        const c = await call('/connected');
        if (!c?.connected) throw new Error('The Handy is offline. Check it is on Wi-Fi and the connection key is right.');
        info = await call('/info');
        if (info?.fw_status === 2) throw new Error(`The Handy needs a firmware update for the newer mode (it has ${info.fw_version}).`);
        const state = await call('/hsp/setup', 'PUT', {});
        if (Number.isFinite(state?.max_points) && state.max_points > 0) maxPoints = state.max_points;
        await syncTime();
        return true;
    }

    async function isConnected() {
        try { return Boolean((await call('/connected'))?.connected); } catch { return false; }
    }

    // Kept here, not uploaded. The returned token stands in for the classic
    // mode's hosted URL.
    async function upload(cacheKey, funscript) {
        const token = 'local:' + cacheKey;
        if (!scripts.has(token)) scripts.set(token, (funscript.actions || []).slice().sort((a, b) => a.at - b.at));
        return token;
    }

    async function load(token) {
        if (!scripts.has(token)) throw new Error('Script not prepared.');
        loadedUrl = token;
    }

    function add(points, flush) {
        const chunk = points.points.slice(points.next, points.next + CHUNK);
        points.next += chunk.length;
        return { points: chunk, flush, tail_point_stream_index: Math.max(1, points.base + points.next) };
    }

    // One sender at a time, so points always arrive in order.
    async function topUp() {
        const s = stream;
        if (!s || s.sending || s.next >= s.points.length) return;
        s.sending = true;
        try { await topUpNow(s); } finally { s.sending = false; }
    }

    async function topUpNow(s) {
        let state;
        try { state = await call('/hsp/state'); } catch { return; }
        // Points still queued on the device, counted inside its buffer (it
        // drops its oldest points as new ones arrive).
        const queued = (state?.points ?? 0) - 1 - (state?.current_point ?? 0);
        if (Number.isFinite(queued) && queued > Math.floor(Math.min(maxPoints, AHEAD) * LOW_WATER)) return;
        for (let i = 0; i < 3 && stream === s && s.next < s.points.length; i++) {
            try { await call('/hsp/add', 'PUT', add(s, false)); } catch { return; }
        }
    }

    // Flush, load the first chunk inside the play call itself (quickest start),
    // then fill the rest of the buffer and keep it topped up while it plays.
    async function play(startMs) {
        const actions = scripts.get(loadedUrl);
        if (!actions) throw new Error('No script loaded.');
        const from = Math.max(0, Math.round(startMs));
        const { first, points } = pointsFrom(actions, from);
        const s = { points, next: 0, base: first };
        stream = s;
        clearTimer(refill);
        const result = await call('/hsp/play', 'PUT', {
            start_time: from,
            server_time: serverTime(),
            playback_rate: rate,
            pause_on_starving: false,
            add: add(s, true)
        });
        // The rest fills in the background: play returns as soon as the device
        // runs, and a stop or new play (stream changes) ends the filling.
        if (stream !== s) return result;
        refill = setTimer(topUp, REFILL_MS);
        s.filled = (async () => {
            s.sending = true;
            const goal = Math.min(points.length, Math.min(maxPoints, AHEAD));
            try {
                while (stream === s && s.next < goal) await call('/hsp/add', 'PUT', add(s, false));
            } catch { /* the next top-up retries */ } finally { s.sending = false; }
        })();
        return result;
    }

    async function stop() {
        stream = null;
        clearTimer(refill);
        return call('/hsp/stop', 'PUT');
    }

    // Keep the device on the video's clock; small drifts are eased in.
    async function syncVideo(currentMs) {
        if (!stream) return;
        return call('/hsp/synctime', 'PUT', { current_time: Math.max(0, Math.round(currentMs)), server_time: serverTime(), filter: 0.5 });
    }

    // The slider's stroke range, in percent (0 = bottom, 100 = top). Every
    // stroke is scaled into it by the device itself.
    async function setStroke(min, max) {
        const r = await call('/slider/stroke', 'PUT', { min: min / 100, max: max / 100 });
        return { min: Math.round((r?.min ?? min / 100) * 100), max: Math.round((r?.max ?? max / 100) * 100) };
    }
    async function getStroke() {
        const r = await call('/slider/stroke');
        return Number.isFinite(r?.min) ? { min: Math.round(r.min * 100), max: Math.round(r.max * 100) } : null;
    }

    // Playback speed for content with no picture to stay in sync with.
    async function setRate(r) {
        rate = Math.max(0.25, Math.min(3, r));
        if (stream) return call('/hsp/playbackrate', 'PUT', { playback_rate: rate });
    }

    function stopOnUnload() {
        try { fetchImpl(API_V3 + '/hsp/stop', { method: 'PUT', headers: headers(), keepalive: true }); } catch { /* page is going away */ }
    }

    return {
        kind: 'stream', connect, isConnected, syncTime, upload, load, play, stop, stopOnUnload, syncVideo, setRate, setStroke, getStroke,
        get loadedUrl() { return loadedUrl; },
        get info() { return info; },
        get maxPoints() { return maxPoints; },
        // Tests: wait for the background fill of the current stream.
        settled() { return stream?.filled || Promise.resolve(); }
    };
}
