// The hub's link to The Handy: the same drivers as the heart-rate player
// (newer streaming mode, classic script upload as the fallback) and the same
// saved settings (connection key, Wi-Fi mode, Application ID, script offset).
// It follows one <video>: play and seek start the Handy at the video's time,
// pause / buffering / end stop it, and the newer mode is eased back onto the
// video clock every 10 s. One command at a time, so a burst of player events
// collapses into the one that matters.
import { createHandy } from '../player/handy-hssp.js';
import { createHandyV3 } from '../player/handy-hsp.js';
import { normalizeSlideRange } from '../hardware/handy-protocol.js';

const OFFSET_KEY = 'player_script_offset_ms';
const STROKE_KEY = 'hub_stroke';    // { min, max } in percent, applied on connect
const EVENTS = ['play', 'playing', 'pause', 'seeking', 'seeked', 'waiting', 'ended'];

export function createHandyLink({ onState = () => {} } = {}) {
    let handy = null;
    let connecting = null;
    let kind = null;
    let video = null;
    let token = null;          // the loaded script, for the scene playing
    let sceneId = null;
    let busy = false;
    let again = false;
    let offsetMs = Number(localStorage.getItem(OFFSET_KEY)) || 0;
    let syncTimer = 0;
    const localScripts = new Map();
    let variant = 'full';      // 'half': every other stroke merged, still on the video's clock
    let stroke = null;
    try { stroke = JSON.parse(localStorage.getItem(STROKE_KEY) || 'null'); } catch { stroke = null; }
    let strokeTimer = 0;
    const onStroke = [];
    const say = (text, tone = '') => onState({ text, tone, kind });

    async function appId() {
        const own = localStorage.getItem('handy_app_id');
        if (own) return own;
        try { return (await (await fetch('api/handy-app-id')).json()).id || ''; } catch { return ''; }
    }

    // Newer mode when chosen (the default) and an Application ID is known;
    // classic otherwise, or when the newer one cannot start.
    function connect() {
        if (handy) return Promise.resolve(handy);
        if (connecting) return connecting;
        connecting = (async () => {
            const key = localStorage.getItem('handy_connection_key');
            if (!key) { say('No Handy key: add it in Heart-rate sessions > Settings > Handy', 'bad'); throw new Error('no key'); }
            say('Handy: connecting…');
            const id = await appId();
            if (localStorage.getItem('player_handy_mode') !== 'classic' && id) {
                const h = createHandyV3(key, id);
                try {
                    await h.connect();
                    handy = h;
                    kind = 'newer';
                    say(`Handy: newer mode${h.info?.fw_version ? ' · fw ' + h.info.fw_version : ''}`, 'good');
                    return handy;
                } catch (e) {
                    if (/offline/i.test(e.message)) { say('Handy offline', 'bad'); throw e; }
                }
            }
            const h = createHandy(key);
            try {
                await h.connect();
            } catch (e) {
                say(/offline/i.test(e.message) ? 'Handy offline' : 'Handy: ' + e.message, 'bad');
                throw e;
            }
            handy = h;
            kind = 'classic';
            say('Handy: classic mode', 'good');
            return handy;
        })().then(async (h) => {
            // The stroke range you chose last time, or the device's own.
            try {
                if (stroke) stroke = await h.setStroke(stroke.min, stroke.max);
                else stroke = await h.getStroke();
                onStroke.forEach(fn => fn(stroke));
            } catch { /* the range is a nicety; playback goes on */ }
            return h;
        }).finally(() => { connecting = null; });
        return connecting;
    }

    async function prepare(id) {
        if (sceneId === id && token) return;
        sceneId = id;
        token = null;
        const h = await connect();
        const v = variant;
        // A script given directly (the sync test), else the scene's from Stash.
        const script = localScripts.has(id) ? localScripts.get(id)
            : await (await fetch(`api/script/${id}${v === 'half' ? '?variant=half' : ''}`)).json();
        if (!script?.actions?.length) throw new Error('this scene has no script');
        if (sceneId !== id || variant !== v) return;
        token = await h.upload(`hub:${id}:${v}`, script);
        await h.load(token);
    }

    async function sync() {
        if (busy) { again = true; return; }
        busy = true;
        try {
            do {
                again = false;
                if (!video || !sceneId) break;
                const playing = !video.paused && !video.seeking && !video.ended && video.readyState >= 3;
                if (playing) {
                    try { await prepare(sceneId); } catch (e) { if (e.message !== 'no key') say(e.message, 'bad'); break; }
                    if (handy.loadedUrl !== token) await handy.load(token);
                    await handy.play(video.currentTime * 1000 + offsetMs);
                    say(`Synced${variant === 'half' ? ' · half speed' : ''} · ${kind} mode`, 'good');
                } else if (handy) {
                    await handy.stop();
                    say(video.ended ? 'Scene over' : video.paused ? 'Paused' : 'Buffering…');
                }
            } while (again);
        } catch (e) {
            say(e.message || String(e), 'bad');
        } finally {
            busy = false;
        }
    }

    function attach(el) {
        if (video) EVENTS.forEach(ev => video.removeEventListener(ev, sync));
        video = el;
        if (video) EVENTS.forEach(ev => video.addEventListener(ev, sync));
        clearInterval(syncTimer);
        syncTimer = setInterval(() => {
            if (!handy?.syncVideo || !video || video.paused || busy) return;
            handy.syncVideo(video.currentTime * 1000 + offsetMs).catch(() => {});
        }, 10000);
    }

    return {
        attach,
        // A new scene: the script is fetched now so pressing play is quick.
        async setScene(id) {
            sceneId = id;
            token = null;
            variant = 'full';   // each scene starts at full speed
            if (handy) { try { await handy.stop(); } catch { /* already stopped */ } }
            prepare(id).catch(e => { if (e.message !== 'no key') say(e.message, 'bad'); });
        },
        // Play a script that is not a Stash scene (the sync test): `key` names
        // it, `funscript` is { actions: [{ at, pos }] }.
        async setLocal(key, funscript) {
            localScripts.set(key, funscript);
            return this.setScene(key);
        },
        async leave() {
            sceneId = null;
            token = null;
            if (handy) { try { await handy.stop(); } catch { /* already stopped */ } }
        },
        stopOnUnload() { handy?.stopOnUnload(); },
        connect: () => connect().catch(() => null),
        get offset() { return offsetMs; },
        nudgeOffset(delta) {
            offsetMs = Math.max(-1000, Math.min(1000, offsetMs + delta));
            localStorage.setItem(OFFSET_KEY, String(offsetMs));
            sync();
            return offsetMs;
        },
        get kind() { return kind; },
        // Half speed: the half-speed version of the script, picked up at the
        // video's current time (a flush and refill in the newer mode).
        get half() { return variant === 'half'; },
        async setHalf(on) {
            variant = on ? 'half' : 'full';
            token = null;
            if (sceneId) { try { await prepare(sceneId); } catch { /* reported by sync */ } }
            sync();
            return variant === 'half';
        },
        // Stroke range in percent. Sent after a short pause while dragging.
        get stroke() { return stroke; },
        onStroke(fn) { onStroke.push(fn); if (stroke) fn(stroke); },
        setStroke(min, max) {
            const r = normalizeSlideRange(min, max);
            stroke = r;
            localStorage.setItem(STROKE_KEY, JSON.stringify(r));
            clearTimeout(strokeTimer);
            strokeTimer = setTimeout(async () => {
                if (!handy) return;
                try { stroke = await handy.setStroke(r.min, r.max); onStroke.forEach(fn => fn(stroke)); }
                catch (e) { say('Stroke range: ' + e.message, 'bad'); }
            }, 250);
            return r;
        }
    };
}
