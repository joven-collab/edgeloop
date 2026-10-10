// The Handy in script mode (HSSP, REST API v2): upload a funscript to Handy's
// script hosting, load it, then play / seek / stop it in sync with a video.
// Only the funscript's timing and positions leave the PC.

import { HANDY_API_BASE as API } from '../hardware/handy-protocol.js';

export const HOSTING = 'https://www.handyfeeling.com/api/hosting/v2';
export const HSSP_MODE = 1;

export function createHandy(connectionKey, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    let offset = 0;
    let loadedUrl = null;
    const uploads = new Map();

    const headers = () => ({
        'X-Connection-Key': connectionKey,
        'Content-Type': 'application/json',
        Accept: 'application/json'
    });

    async function call(path, method = 'GET', body) {
        const r = await fetchImpl(API + path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
        let j = null;
        try { j = await r.json(); } catch { /* empty body */ }
        if (!r.ok || j?.error || (typeof j?.result === 'number' && j.result < 0)) {
            const msg = j?.error?.message || j?.message || `HTTP ${r.status}`;
            throw new Error(`Handy ${method} ${path}: ${msg}`);
        }
        return j;
    }

    // Round-trip sampling; the fastest 80% of samples decide the offset.
    async function syncTime(samples = 8) {
        const got = [];
        for (let i = 0; i < samples; i++) {
            const t0 = now();
            try {
                const r = await fetchImpl(`${API}/servertime`);
                const st = (await r.json())?.serverTime;
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

    async function connect() {
        const c = await call('/connected');
        if (!c?.connected) throw new Error('The Handy is offline. Check it is on Wi-Fi and the connection key is right.');
        await call('/mode', 'PUT', { mode: HSSP_MODE });
        await syncTime();
        return true;
    }

    async function isConnected() {
        try { return Boolean((await call('/connected'))?.connected); } catch { return false; }
    }

    async function upload(cacheKey, funscript) {
        if (uploads.has(cacheKey)) return uploads.get(cacheKey);
        const form = new FormData();
        form.append('file', new Blob([JSON.stringify(funscript)], { type: 'application/json' }), 'script.funscript');
        const r = await fetchImpl(`${HOSTING}/upload`, { method: 'POST', body: form, credentials: 'omit' });
        const url = r.ok ? (await r.json())?.url : null;
        if (!url) throw new Error(`Script upload failed (HTTP ${r.status}).`);
        uploads.set(cacheKey, url);
        return url;
    }

    async function load(url) {
        if (loadedUrl === url) return;
        loadedUrl = null;
        await call('/hssp/setup', 'PUT', { url });
        loadedUrl = url;
    }

    async function play(startMs) {
        return call('/hssp/play', 'PUT', {
            startTime: Math.max(0, Math.round(startMs)),
            estimatedServerTime: serverTime()
        });
    }

    // The slider's stroke range, in percent (0 = bottom, 100 = top).
    async function setStroke(min, max) {
        const r = await call('/slide', 'PUT', { min: Math.round(min), max: Math.round(max) });
        return { min: r?.min ?? min, max: r?.max ?? max };
    }
    async function getStroke() {
        const r = await call('/slide');
        return Number.isFinite(r?.min) ? { min: r.min, max: r.max } : null;
    }

    async function stop() {
        return call('/hssp/stop', 'PUT');
    }

    // Last-chance stop when the page closes; keepalive lets it outlive the tab.
    function stopOnUnload() {
        try {
            fetchImpl(API + '/hssp/stop', { method: 'PUT', headers: headers(), keepalive: true });
        } catch { /* page is going away */ }
    }

    return { connect, isConnected, syncTime, upload, load, play, stop, stopOnUnload, setStroke, getStroke, get loadedUrl() { return loadedUrl; } };
}
