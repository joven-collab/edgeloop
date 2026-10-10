import { createHandy } from './handy-hssp.js';
import { createHandyV3 } from './handy-hsp.js';
import { buildCards, profileScenes, autoPick, chapterLength } from './adventure.js';
import { feelBpm, freshness, isLow, suggestClimaxFromFeel } from './feel.js';
import { createSessionLog } from './session-log.js';
import { peakBefore, suggestFromFinishes } from './calibration.js';
import { writeField } from './player-settings.js';
import { createDirector, chooseScene, chooseWindow, bandProgress, targetLevel, windowIndexAt, fastForwardWindow, panicCanResume, suggestCeilingAfterPanic, chooseTrack } from './director.js';
import { WINDOW_MS, decodeLevels, tierForLevel } from '../library/script-analysis.js';
import { connectBleHeartRate, disconnectBle } from '../hardware/ble.js';
import { createHrWatchdog, clampStaleSeconds } from '../hr-watchdog.js';
import { computeEffectiveCeiling, sanitizeSessionLimits } from '../session-rules.js';
import { resolveEdgeTriggerHr, hasReleasedEdge, clampEdgeHoldPercent, resolveCeilingBehaviour, EDGE_RELEASE_BPM } from '../engine.js';
import { adjustLevels, makeVisit, sceneWeight, suggestEarlierWarning, chooseDwellMs } from './learning.js';
import { createGoals, goalsMet } from './session-goals.js';
import { ScriptClock } from './script-clock.js';
import { cueAt } from './thumbs.js';
import { createLeveler, LEVELER } from './audio-leveler.js';
import { lookaheadBpm, micEnvelope, driveHr, EARLY, instantHr, rmssd, hrvBaseline, hrvBpm } from './early-warning.js';
import { byKey, readField } from './player-settings.js';
import { mountSettingsPanel } from './settings-panel.js';
import { startMicMonitor, stopMicMonitor, voiceBandLevel, micBoostFromLevel, clampMicGate, clampMicBoostBpm } from '../voice.js';

const $ = (id) => document.getElementById(id);
const videoEl = $('video');
// The media clock the player follows: the <video> element, or in Script-only
// mode a silent ScriptClock with the same surface.
let video = videoEl;
let scriptClock = null;
const OFFSET_KEY = 'player_script_offset_ms';
const RECENT = 120;

// ---- EdgeLoop settings (read-only here) -----------------------------------

function readSettings() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem('edgeloop_advanced_settings') || '{}') || {}; } catch { raw = {}; }
    const limits = sanitizeSessionLimits(raw);
    return {
        minHr: limits.minHr,
        maxHr: limits.maxHr,
        edgeHoldPercent: clampEdgeHoldPercent(raw.edgeHoldPercent),
        ceilingBehaviour: resolveCeilingBehaviour(raw.ceilingBehaviour),
        staleSeconds: clampStaleSeconds(raw.hrStaleSeconds),
        autoResume: raw.hrAutoResume !== false,
        learnedOffset: raw.learningProfile?.suggestedMaxHrOffset || 0,
        adaptiveDecay: raw.adaptiveDecay !== false,
        decayEdgeCount: raw.decayEdgeCount ?? 2,
        decayBpm: raw.decayBpm ?? 2,
        decayFloor: raw.decayFloor ?? 105
    };
}

const settings = readSettings();

// ---- state -----------------------------------------------------------------

let library = [];
let pool = null;
let scene = null;
let levels = [];
let handy = null;
let ready = false;          // a scene is loaded and the video can play
let busy = false;           // a load / switch is in flight
let scriptStopped = false;  // Full Stop edge: video plays, script does not
let safetyPaused = false;   // watchdog stopped everything
let variant = 'full';
let edges = 0;
let offsetMs = Number(localStorage.getItem(OFFSET_KEY)) || 0;
let hudOn = localStorage.getItem('player_hud') !== 'off';
let panic = null;           // { since, hr, calmSince }
let sessionStart = 0;
const hrTrail = [];         // last 30 s of readings, for the panic log
let actions = [];           // the loaded scene's full-speed strokes
const LEAD_IN_MS = 1000;
// Recently played scene ids, kept across sessions so a new session does not
// serve the same videos again.
const recent = (() => { try { const r = JSON.parse(localStorage.getItem('player_recent') || '[]'); return Array.isArray(r) ? r.slice(-RECENT) : []; } catch { return []; } })();
let mode = null;           // 'dynamic' | 'full' | 'pmv'
let goals = null;
let finishUnlocked = false;
let finishing = false;
let learnedData = { scenes: {}, levels: {} };
let performers = {};        // Stash performer profiles, by id
let warnAt = Number(localStorage.getItem('player_warn_at')) || 0.9;
// Director knobs from Settings.
const pref = (key) => readField(localStorage, byKey[key]);
function directorOptions() {
    return {
        warnAt,
        deadGraceMs: pref('player_dead_grace_s') * 1000,
        halfOffAfterMs: pref('player_half_off_s') * 1000,
        newSceneOnRelease: pref('player_new_clip_pct') / 100
    };
}
let director = createDirector(directorOptions());

// ---- learning --------------------------------------------------------------

let pendingEvents = [];
let visit = null;           // the window being watched now
let sceneStartedAt = 0;

function learn(event) {
    if (event) pendingEvents.push(event);
}

function flushLearning(beacon = false) {
    if (!pendingEvents.length) return;
    const body = JSON.stringify({ events: pendingEvents });
    pendingEvents = [];
    if (beacon && navigator.sendBeacon) navigator.sendBeacon('api/learning', new Blob([body], { type: 'application/json' }));
    else fetch('api/learning', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
}

setInterval(() => flushLearning(), 30000);

function closeVisit(now) {
    if (!visit) return;
    learn(makeVisit({ ...visit, endHr: hr, endAt: now }));
    visit = null;
}

// Called every tick while playing: a new window, scene or speed closes the
// previous stay and opens a new one.
function trackVisit(now) {
    // Manual arousal is not a pulse, so it teaches the learning nothing.
    if (hrSource === 'manual') { visit = null; return; }
    const index = windowIndexAt(video.currentTime * 1000);
    if (visit && visit.sceneId === scene.id && visit.index === index && visit.half === (variant === 'half')) {
        if (director.edged || scriptStopped || finishing) visit.edged = true;
        return;
    }
    closeVisit(now);
    visit = { sceneId: scene.id, index, level: scene.baseLevels[index] ?? -1, startHr: hr, startAt: now, half: variant === 'half', edged: director.edged || scriptStopped || finishing };
}

function leavingScene(now, skipped) {
    closeVisit(now);
    if (!scene) return;
    if (skipped) learn({ type: 'skip', sceneId: scene.id });
    else if (now - sceneStartedAt >= 60000) learn({ type: 'play', sceneId: scene.id });
}

let hr = null;
let hrSource = null; // 'ble' | 'manual'
const watchdog = createHrWatchdog({ staleMs: settings.staleSeconds * 1000, autoResume: settings.autoResume });

function fmt(sec) {
    if (!Number.isFinite(sec)) return '0:00';
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60) % 60;
    const h = Math.floor(sec / 3600);
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

function status(text, isError = false) {
    $('status').textContent = text;
    $('status').style.color = isError ? '#f87171' : '';
    if (isError) console.error(text);
}

function doing(text) {
    $('doing').textContent = text || '';
}

function showHud() {
    $('hud').classList.toggle('hidden', !hudOn || !pool);
    $('infoBtn').classList.toggle('on', hudOn);
}

function toggleHud() {
    hudOn = !hudOn;
    localStorage.setItem('player_hud', hudOn ? 'on' : 'off');
    showHud();
}

// ---- stroke timing -----------------------------------------------------------

function lastAtOrBefore(ms) {
    let lo = 0, hi = actions.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (actions[mid].at <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
}

// Moving = between two points at different positions. Otherwise report how
// long the stroker has been still and how soon it moves again.
function motionAt(ms) {
    if (!actions.length) return { idleMs: 0, nextActionInMs: 0 };
    const i = lastAtOrBefore(ms);
    if (i < 0) return { idleMs: 0, nextActionInMs: actions[0].at - ms };
    const nxt = actions[i + 1];
    if (nxt && nxt.pos !== actions[i].pos) return { idleMs: 0, nextActionInMs: 0 };
    let k = i;
    while (k > 0 && actions[k - 1].pos === actions[k].pos) k--;
    let m = i + 1;
    while (m < actions.length && actions[m].pos === actions[m - 1].pos) m++;
    return {
        idleMs: ms - actions[k].at,
        nextActionInMs: m < actions.length ? Math.max(0, actions[m - 1].at - ms) : Infinity
    };
}

// Already moving at the section start: begin right there. Starting in a
// still stretch: skip ahead to a second before the strokes pick up.
function startMsFor(index) {
    const from = index * WINDOW_MS;
    const m = motionAt(from);
    if (m.idleMs === 0 || m.nextActionInMs <= LEAD_IN_MS || !Number.isFinite(m.nextActionInMs)) return from;
    return from + m.nextActionInMs - LEAD_IN_MS;
}

function alertBox(text) {
    $('alert').textContent = text || '';
    $('alert').classList.toggle('hidden', !text);
}

function ceiling() {
    const c = computeEffectiveCeiling({
        minHr: settings.minHr,
        maxHr: settings.maxHr,
        learnedOffset: settings.learnedOffset,
        adaptiveDecay: settings.adaptiveDecay,
        edges,
        decayEdgeCount: settings.decayEdgeCount,
        decayBpm: settings.decayBpm,
        decayFloor: settings.decayFloor
    });
    return { minHr: c.minHr, maxHr: c.maxHr, trigger: resolveEdgeTriggerHr(c.maxHr, settings.edgeHoldPercent, c.minHr) };
}

// ---- heart rate ------------------------------------------------------------

// What the monitor is actually sending, so "Waiting for a pulse" can say why.
let packetsSeen = 0;
let beats = [];             // last minute of beat intervals { t, rr }, for the live signals
let hrvReadings = [];       // this session's RMSSD readings, for its own baseline
let rrPending = [];         // beat-to-beat intervals since the last recorded second
let lastContact = null;
let lastRejected = null;

function onHr(bpm, parsed) {
    const now = Date.now();
    if (hrSource === 'ble') {
        packetsSeen++;
        if (parsed?.rrIntervalsMs?.length) {
            rrPending.push(...parsed.rrIntervalsMs);
            for (const rr of parsed.rrIntervalsMs) beats.push({ t: now, rr });
            while (beats.length && now - beats[0].t > 60000) beats.shift();
        }
        if (rrPending.length > 60) rrPending.splice(0, rrPending.length - 60);
        lastContact = parsed?.sensorContact ?? null;
    }
    const accepted = watchdog.recordPacket(now, bpm, parsed?.sensorContact ?? null);
    if (!accepted && hrSource === 'ble') {
        lastRejected = { bpm, contact: parsed?.sensorContact ?? null };
        if (!pool) $('startStatus').textContent = `The monitor is sending ${bpm} BPM${lastRejected.contact === false ? ' and reports no skin contact' : ''}: wet the pads and tighten the strap so it can read you.`;
    } else if (accepted && hrSource === 'ble' && !pool && /Waiting for a pulse|monitor is sending/i.test($('startStatus').textContent)) {
        $('startStatus').textContent = 'Pulse found. Pick a mode to start.';
    }
    if (accepted) {
        hr = bpm;
        hrTrail.push({ t: now, hr: bpm });
        while (hrTrail.length && now - hrTrail[0].t > 30000) hrTrail.shift();
    }
    renderHr();
}

function renderHr() {
    const c = ceiling();
    const manual = hrSource === 'manual';
    $('startHr').textContent = manual ? (arousal === 0 ? 'Edge' : arousal) : (hr ?? '--');
    $('startUnit').textContent = manual ? (arousal === 0 ? '' : 'arousal') : 'BPM';
    $('hrWrap').classList.toggle('hidden', manual);
    $('arousalWrap').classList.toggle('hidden', !manual);
    $('arousal').textContent = arousal === 0 ? 'edge' : String(arousal);
    $('hr').textContent = hr ?? '--';
    $('trigger').textContent = c.trigger;
    updateModeButtons();
}

// ---- manual arousal (no monitor) ---------------------------------------------
// 1 warm-up ... 5 sweet spot ... 9 pure bliss; 0 = edge. Each level stands in
// for a heart-rate reading, so every rule downstream (cap, mood, half speed,
// edges, goals) works unchanged. 9 sits just under the half-speed line; 0 sits
// over the pullback mark, and any 1-9 afterwards releases it.
const AROUSAL_TOP = 0.85;
let arousal = 3;

function arousalToHr(level) {
    const c = ceiling();
    if (level === 0) return c.trigger + 2;
    const p = ((level - 1) / 8) * AROUSAL_TOP;
    return Math.round(c.minHr + p * (c.trigger - c.minHr));
}

function setArousal(level) {
    arousal = level;
    onHr(arousalToHr(level));
    if (pool) doing(level === 0 ? 'Edge (0)' : `Arousal ${level}`);
}

function useManual() {
    hrSource = 'manual';
    disconnectBle({ silent: true });
    watchdog.reset(Date.now());
    setArousal(arousal);
    $('startStatus').textContent = 'Manual: number pad 1-9 sets arousal, 0 is an edge, . is panic.';
}

// Manual mode re-sends its level every second, like a real strap, so the
// signal watchdog stays satisfied and ceiling changes are picked up.
setInterval(() => { if (hrSource === 'manual') onHr(arousalToHr(arousal)); }, 1000);

// After a drop the strap is retried for about three minutes before giving
// up; then the Reconnect button (or Connect heart rate) links the same strap
// again without the chooser. Shift+click Connect heart rate to pick another.
const BLE_RETRY_MS = [1000, 2000, 3000, 5000, 5000, 10000, 10000, 10000, 15000, 15000, 15000, 20000, 20000, 20000, 30000];
let bleDevice = null;

function showReconnect(on) {
    $('reconnectBtn').classList.toggle('hidden', !on);
}

async function connectBle(e) {
    const reuse = bleDevice && !e?.shiftKey;
    $('startStatus').textContent = reuse ? 'Reconnecting your monitor…' : 'Pick your heart-rate monitor…';
    try {
        bleDevice = await connectBleHeartRate({
            device: reuse ? bleDevice : null,
            reconnectDelaysMs: BLE_RETRY_MS,
            onHrMeasurement: onHr,
            onDisconnected: () => {
                status('Heart-rate monitor lost. Press Reconnect monitor.', true);
                logEvent('monitor-lost');
                showReconnect(true);
                if (!pool) $('startStatus').textContent = 'Monitor lost. Press Connect heart rate to link it again.';
            },
            onReconnecting: (n, max) => { status(`Monitor dropped: reconnecting (${n}/${max})…`, true); if (n === 1) logEvent('monitor-drop'); },
            onReconnected: () => { status('Monitor reconnected'); logEvent('monitor-back'); showReconnect(false); }
        });
        showReconnect(false);
        hrSource = 'ble';
        watchdog.reset(Date.now());
        packetsSeen = 0;
        lastRejected = null;
        $('startStatus').textContent = 'Monitor connected. Waiting for a pulse…';
        // Nothing at all after a while: the link is up but the strap is silent.
        setTimeout(() => {
            if (hrSource === 'ble' && !packetsSeen && !pool) $('startStatus').textContent = 'Connected, but the monitor has sent nothing yet. Wear the strap with wet pads; if it stays silent, close any phone app using it and reconnect.';
        }, 10000);
    } catch (e) {
        const msg = String(e?.message || e);
        $('startStatus').textContent = /connection attempt failed|gatt|network/i.test(msg)
            ? 'Monitor paired but would not connect. Wear the strap (moisten the pads), close any phone app using it, remove it from Windows Bluetooth settings if it is paired there, then try again.'
            : 'Monitor: ' + msg;
    }
}

// ---- catching edges sooner -------------------------------------------------
// Lookahead projects a fast-climbing pulse a few seconds ahead; the microphone
// adds a few BPM for sustained loud breathing or voice (the Handy's hum sits
// below the voice band and is ignored). Both only ADD to the rate the director
// acts on, so they can only calm things down or call an edge sooner. The
// readout, learning data and panic resume keep using the measured pulse.

let lookaheadOn = localStorage.getItem('player_lookahead') !== 'off';
const earlySettings = { ...EARLY, lookaheadS: pref('player_lookahead_s'), maxLookaheadBpm: pref('player_lookahead_max') };
let micGate = clampMicGate(Number(localStorage.getItem('player_mic_gate') || 40));
let micStrength = clampMicBoostBpm(Number(localStorage.getItem('player_mic_boost') || 10));
const micState = {};
let micEnv = 0;
let lastDrive = { hr: null, rising: 0, mic: 0 };

function micBoostNow() {
    if (!$('micToggle').checked || !micState.micAnalyser) return 0;
    return micBoostFromLevel(Math.round(micEnv), micGate, micStrength);
}

// The rate the director acts on right now.
function drive(now = Date.now()) {
    if (hr === null) return { hr: null, rising: 0, mic: 0 };
    const c = ceiling();
    // Beat timing: the instant rate runs a few beats ahead of the strap's
    // averaged BPM, and collapsed variability near the top flags "close".
    const beat = hrSource === 'ble' ? instantHr(beats, now) : null;
    const base = Number.isFinite(beat) && beat > hr ? beat : hr;
    const hrv = hrSource === 'ble' ? hrvBpm({ current: rmssd(beats, now), baseline: hrvBaseline(hrvReadings), hr: base, minHr: c.minHr, triggerHr: c.trigger }) : 0;
    const rising = lookaheadOn && hrSource === 'ble'
        ? lookaheadBpm({ trail: hrTrail, now, hr, minHr: c.minHr, triggerHr: c.trigger }, earlySettings)
        : 0;
    const mic = micBoostNow();
    const feelExtra = hrSource === 'ble' ? feelBpm({ rating: feel, hr: base, minHr: c.minHr, triggerHr: c.trigger, now }) : 0;
    return { hr: driveHr({ hr: base, lookahead: rising, mic: mic + feelExtra + hrv }), rising, mic, feel: feelExtra, hrv, beat: base > hr ? base - hr : 0 };
}

async function startMic() {
    $('micNote').textContent = 'Asking for the microphone…';
    try {
        await startMicMonitor(micState, {
            onLost: (why) => { micEnv = 0; $('micNote').textContent = why; status('Mic: ' + why, true); }
        });
        micEnv = 0;
        $('micNote').textContent = 'Set the gate just above the room and the video sound. The bar turns orange when it counts.';
    } catch (e) {
        $('micToggle').checked = false;
        localStorage.setItem('player_mic', 'off');
        $('micNote').textContent = 'Microphone: ' + (e.message || e);
        $('micSetup').classList.remove('hidden');
    }
}

function renderMicSetup() {
    $('micSetup').classList.toggle('hidden', !$('micToggle').checked && !$('micNote').textContent.startsWith('Microphone:'));
    $('micGate').value = String(micGate);
    $('micGateVal').textContent = String(micGate);
    $('micBoost').value = String(micStrength);
    $('micBoostVal').textContent = micStrength ? `+${micStrength}` : 'off';
    $('micGateMark').style.left = micGate + '%';
}

setInterval(() => {
    const a = micState.micAnalyser;
    if (!a) return;
    const bytes = new Uint8Array(a.frequencyBinCount);
    a.getByteFrequencyData(bytes);
    micEnv = micEnvelope(micEnv, voiceBandLevel(bytes, micState.micAudioCtx?.sampleRate, a.fftSize), 0.1);
    if (!$('start').classList.contains('hidden')) {
        $('micLevel').style.width = Math.min(100, micEnv) + '%';
        $('micLevel').classList.toggle('over', micEnv > micGate);
    }
}, 100);

$('lookaheadToggle').checked = lookaheadOn;
$('lookaheadToggle').addEventListener('change', () => {
    lookaheadOn = $('lookaheadToggle').checked;
    localStorage.setItem('player_lookahead', lookaheadOn ? 'on' : 'off');
});

$('micToggle').checked = localStorage.getItem('player_mic') === 'on';
$('micToggle').addEventListener('change', () => {
    const on = $('micToggle').checked;
    localStorage.setItem('player_mic', on ? 'on' : 'off');
    $('micNote').textContent = '';
    if (on) startMic(); else { stopMicMonitor(micState); micEnv = 0; }
    renderMicSetup();
});
$('micGate').addEventListener('input', () => {
    micGate = clampMicGate(Number($('micGate').value));
    localStorage.setItem('player_mic_gate', String(micGate));
    renderMicSetup();
});
$('micBoost').addEventListener('input', () => {
    micStrength = clampMicBoostBpm(Number($('micBoost').value));
    localStorage.setItem('player_mic_boost', String(micStrength));
    renderMicSetup();
});
renderMicSetup();
// Remembered as on: reopen the microphone (the permission is kept), and wake
// the audio context on the first click or key press if the browser held it.
if ($('micToggle').checked) {
    startMic();
    const wake = () => { micState.micAudioCtx?.resume?.().catch(() => {}); };
    document.addEventListener('pointerdown', wake, { once: true });
    document.addEventListener('keydown', wake, { once: true });
}

// ---- library ---------------------------------------------------------------

// Every page load and every Exit checks Stash for new, changed or removed
// scenes (about 0.2 s when nothing changed). `full` re-analyses everything.
async function loadLibrary(refresh = false, { full = false } = {}) {
    $('startStatus').textContent = full ? 'Rebuilding the whole library…' : refresh ? 'Checking Stash for changes…' : 'Loading library…';
    let changes = '';
    try {
        if (refresh) {
            // A failed check falls back to the saved index rather than
            // blocking the start screen.
            try {
                const r = await fetch('api/library/refresh' + (full ? '?full=1' : ''), { method: 'POST' });
                const j = await r.json();
                if (!r.ok) throw new Error(j.error);
                if (j.analyzed || j.removed) changes = `Library updated: ${j.analyzed} new or changed, ${j.removed} removed. `;
            } catch {
                changes = 'Could not reach Stash; using the saved library. ';
            }
        }
        let idx = await (await fetch('api/library')).json();
        if (!idx.syncedAt) {
            await fetch('api/library/refresh', { method: 'POST' });
            idx = await (await fetch('api/library')).json();
        }
        let learned = { scenes: {}, levels: {} };
        try { learned = await (await fetch('api/learning')).json(); } catch { /* start fresh */ }
        learnedData = learned?.scenes ? learned : { scenes: {}, levels: {} };
        library = Object.values(idx.scenes || {}).map(s => {
            const baseLevels = decodeLevels(s.levels);
            const stats = learned.scenes?.[s.id];
            return { ...s, baseLevels, levelArray: adjustLevels(baseLevels, stats, learned.levels), weight: sceneWeight(stats) };
        });
        offerEarlierWarning();
        offerFeelClimax();
        const count = (p) => library.filter(s => s.pool === p).length;
        $('countDynamic').textContent = count('regular') + ' videos';
        $('countRegular').textContent = count('regular') + ' videos';
        $('countPmv').textContent = count('pmv') + ' videos';
        $('countScript').textContent = library.length + ' scripts';
        profileScenes(library);
        performers = idx.performers || {};
        $('countAdventure').textContent = count('regular') + ' videos · ' + Object.keys(performers).length + ' performers';
        $('startStatus').textContent = changes + (!localStorage.getItem('handy_connection_key') && !noHandy()
            ? 'No Handy key saved yet. Open Settings, Handy tab, or turn on No Handy.'
            : hr === null ? 'Connect your heart rate, then pick a mode.' : 'Pick a mode to start.');
    } catch (e) {
        $('startStatus').textContent = 'Library error: ' + (e.message || e) + ' (is Stash running?)';
    }
    const c = ceiling();
    $('limits').textContent = `Resting ${c.minHr} · Climax ${settings.maxHr} · pullback at ${c.trigger} BPM · at the ceiling: ${settings.ceilingBehaviour === 'stop' ? 'Full Stop' : 'Crawl'}`;
    renderHr();
}

function updateModeButtons() {
    const ok = (noHandy() || Boolean(localStorage.getItem('handy_connection_key'))) && hr !== null && library.length > 0;
    document.querySelectorAll('.mode').forEach(b => { if (!pool) b.disabled = !ok; });
}

function currentTarget() {
    const c = ceiling();
    if (hr === null) return 3;
    return director.target(bandProgress(drive().hr, c.minHr, c.trigger));
}

// ---- Handy sync ------------------------------------------------------------
// One request at a time; each run reads the state at that moment, so a burst
// of events collapses into a single correct command.

let syncRunning = false;
const EDGE_ACTIONS = ['edge-stop', 'crawl', 'cooldown'];
let pendingEdge = null;     // an edge found while a switch was in progress
let edgeHold = false;       // keeps the Handy stopped until that edge is applied
let syncAgain = false;

async function sync() {
    if (syncRunning) { syncAgain = true; return; }
    syncRunning = true;
    try {
        do {
            syncAgain = false;
            if (!handy || !ready) break;
            const playing = !video.paused && !video.seeking && !video.ended && video.readyState >= 3;
            if (playing && !scriptStopped && !safetyPaused && !edgeHold) {
                await handy.play(video.currentTime * 1000 + offsetMs);
                status(handy.kind === 'none' ? 'No Handy: nothing moves' : variant === 'half' ? 'Half speed' : 'Synced');
            } else {
                await handy.stop();
                if (scriptStopped) status('Edge: script stopped');
                else status(video.paused ? 'Paused' : 'Buffering…');
            }
        } while (syncAgain);
    } catch (e) {
        status(e.message || String(e), true);
    } finally {
        syncRunning = false;
    }
}

// A video that runs out counts as a finished play, not a skip.
function onMediaEnded() {
    if (!ready) return;
    if (mode === 'adventure') { showCards('Scene over: what next?'); return; }
    doing(mode === 'pmv' ? 'Track finished: next track' : mode === 'script' ? 'Script finished: next script' : 'Video finished: next video');
    director.setHalf(false);
    if (!panic) scriptStopped = false;
    loadNear(currentTarget(), 'full');
}

function onMediaError() {
    if (!ready) return;
    status('This video could not be played; skipping.', true);
    setTimeout(skip, 1500);
}

// ---- scripts and scenes ----------------------------------------------------

async function prepareScript(sc, v) {
    const script = await (await fetch(`api/script/${sc.id}${v === 'half' ? '?variant=half' : ''}`)).json();
    if (!script.actions?.length) throw new Error('empty script');
    if (v === 'full') actions = script.actions;
    const url = await handy.upload(`${sc.id}:${sc.updatedAt}:${v}`, script);
    await handy.load(url);
}

let loadToken = 0;

// Dynamic: how long this clip gets, weighted by what the data says about it.
function dwellFor(sc, index) {
    return chooseDwellMs({
        sceneStats: learnedData.scenes?.[sc.id],
        windowIndex: index,
        level: sc.baseLevels?.[index],
        levelStats: learnedData.levels
    });
}

async function loadScene(sc, index, v = 'full', { skipped = false, fromMs = null } = {}) {
    const token = ++loadToken;
    busy = true;
    ready = false;
    leavingScene(Date.now(), skipped);
    sceneStartedAt = Date.now();
    logEvent('scene', { id: sc.id, index });
    scene = sc;
    levels = sc.levelArray;
    variant = v;
    recent.push(sc.id);
    while (recent.length > RECENT) recent.shift();
    try { localStorage.setItem('player_recent', JSON.stringify(recent)); } catch { /* not critical */ }
    video.pause();
    try { await handy.stop(); } catch { /* already stopped */ }
    status('Loading…');
    $('heatmap').src = `stash/scene/${sc.id}/interactive_heatmap`;
    loadThumbs(sc.id);
    $('sceneTitle').textContent = '';
    fetch(`api/scene/${sc.id}/title`).then(r => r.json()).then(({ title }) => {
        if (scene?.id === sc.id) { $('sceneTitle').textContent = title || ''; $('sceneTitle').title = title || ''; }
    }).catch(() => {});
    try {
        actions = [];
        if (v === 'half') {
            const full = await (await fetch(`api/script/${sc.id}`)).json();
            actions = full.actions || [];
        }
        await prepareScript(sc, v);
    } catch (e) {
        if (token === loadToken) { status('Script failed: ' + (e.message || e), true); busy = false; }
        return;
    }
    if (token !== loadToken) return;
    if (video.isClock) video.duration = (sc.durationMs || 0) / 1000;
    video.src = `stash/scene/${sc.id}/stream`;
    await new Promise((res) => video.addEventListener('loadedmetadata', res, { once: true }));
    if (token !== loadToken) return;
    // Regular plays from the very start (dead intro included) unless told
    // where to begin; the other modes start at the chosen section.
    const startMs = fromMs !== null ? fromMs : (mode === 'full' ? 0 : startMsFor(index));
    video.currentTime = startMs / 1000;
    if (mode === 'pmv' && !(await armHandyFor(startMs, token))) return;
    if (token !== loadToken) return;
    ready = true;
    busy = false;
    director.moved(Date.now(), { halfOn: v === 'half', newScene: true, dwell: dwellFor(sc, index) });
    renderBadges();
    try { await video.play(); } catch { status('Press Play to start.'); }
}

// PMV strokes are cut to the music from the first beat, so the video waits
// for the Handy: it must report as connected, the video must be buffered, and
// the Handy must confirm it has started before the picture moves.
async function armHandyFor(startMs, token) {
    let waited = false;
    while (!(await handy.isConnected())) {
        if (token !== loadToken) return false;
        if (!waited) { status('Waiting for the Handy…', true); doing('Waiting for the Handy to connect'); waited = true; }
        await new Promise(r => setTimeout(r, 1000));
    }
    if (token !== loadToken) return false;
    if (video.readyState < 3) {
        status('Buffering…');
        await new Promise(r => { video.addEventListener('canplay', r, { once: true }); setTimeout(r, 10000); });
    }
    if (token !== loadToken) return false;
    try { await handy.play(startMs + offsetMs); } catch (e) { status(e.message || String(e), true); }
    if (waited) doing('Handy connected: starting the track');
    return true;
}

async function switchVariant(v) {
    if (!scene || variant === v) return;
    busy = true;
    try {
        await prepareScript(scene, v);
        variant = v;
        renderBadges();
        await sync();
    } catch (e) {
        status('Half-speed switch failed: ' + (e.message || e), true);
    } finally {
        busy = false;
    }
}

async function jumpTo(index, v) {
    if (v && v !== variant) await switchVariant(v);
    video.currentTime = startMsFor(index) / 1000;
    director.moved(Date.now(), { dwell: dwellFor(scene, index) });
}

// The later part of a video, for finishing: a window near `target` in the
// last 30%, else the start of that stretch.
function tailIndex(levelsOf, target) {
    const from = Math.floor(levelsOf.length * 0.7);
    return chooseWindow(levelsOf, target, { minIndex: from }) ?? Math.min(from, Math.max(0, levelsOf.length - 2));
}

// Dynamic cuts to a matching section; Regular and PMV pick whole videos.
function loadNear(target, v = 'full', opts = {}) {
    const choose = mode === 'dynamic' ? chooseScene : chooseTrack;
    const pick = choose(library, { pool, target, recent, excludeId: scene?.id });
    if (!pick) { status('No videos in this pool.', true); busy = false; return; }
    if (finishing && mode !== 'pmv') {
        const i = tailIndex(pick.scene.levelArray, target);
        loadScene(pick.scene, i, v, { ...opts, fromMs: i * WINDOW_MS });
        return;
    }
    loadScene(pick.scene, pick.index, v, opts);
}

// Skip: another video at about the intensity playing now; half speed ends.
function skip() {
    if (mode === 'adventure') { showCards('Skipped: pick another'); return; }
    doing('Skipped: similar intensity');
    const here = levels[windowIndexAt(video.currentTime * 1000)];
    const target = Number.isInteger(here) && here >= 0 ? here : currentTarget();
    director.setHalf(false);
    if (!panic) scriptStopped = false;
    loadNear(target, 'full', { skipped: true });
}

// ---- director loop ---------------------------------------------------------

// The pullback is immediate, but an edge only COUNTS (ceiling decay, goals,
// the recording) once the pulse has held at the mark for a couple of seconds,
// so a single spike from the strap is not an edge.
const EDGE_HOLD_MS = 2000;
let edgeCheck = null;      // { since }
function countEdgeIfHeld() {
    edgeCheck = { since: Date.now() };
}
function watchEdgeHold(now, driveHr, triggerHr) {
    if (!edgeCheck) return;
    if (!(driveHr >= triggerHr)) { edgeCheck = null; logEvent('edge-spike', { hr }); return; }
    if (now - edgeCheck.since >= EDGE_HOLD_MS) { edgeCheck = null; edges++; logEvent('edge-counted', { hr, edges }); }
}

async function apply(action) {
    switch (action.type) {
        case 'edge-stop':
            doing('Edge: script stopped until you come down');
            countEdgeIfHeld();
            scriptStopped = true;
            await sync();
            break;
        case 'crawl':
            countEdgeIfHeld();
            if (action.index === null) {
                doing(mode === 'pmv' ? 'Edge: half speed, the music keeps going' : 'Edge: half speed until you come down');
                await switchVariant('half');
                break;
            }
            doing('Edge: crawling in a slow section');
            await jumpTo(action.index, 'half');
            break;
        case 'jump':
            doing(action.why || ('Moving to a ' + tierForLevel(levels[action.index]) + ' section'));
            scriptStopped = false;
            await jumpTo(action.index, action.half ? 'half' : 'full');
            break;
        case 'scene':
            doing(action.why || 'New video, ' + tierForLevel(action.target));
            scriptStopped = false;
            loadNear(action.target, action.half ? 'half' : 'full');
            break;
        case 'cooldown':
            countEdgeIfHeld();
            scriptStopped = true;
            doing('Cool-down: script off for the rest of this track (N to skip)');
            await sync();
            break;
        case 'note':
            doing(action.why);
            break;
        case 'half':
            doing(action.why || (finishing ? 'Finish' : action.on ? 'Near the edge: half speed' : 'Calmed down: full speed'));
            await switchVariant(action.on ? 'half' : 'full');
            break;
        case 'resume':
            doing('Back from the edge');
            scriptStopped = false;
            await sync();
            break;
    }
}

function renderBadges() {
    $('halfBtn').classList.toggle('on', variant === 'half');
    $('panicBtn').textContent = panic ? 'RESUME' : 'PANIC';
    $('halfBadge').classList.toggle('hidden', variant !== 'half');
    $('edgeBadge').classList.toggle('hidden', !director.edged);
    $('risingBadge').textContent = `RISING +${lastDrive.rising}`;
    $('risingBadge').classList.toggle('hidden', !lastDrive.rising);
    $('micBadge').textContent = `MIC +${lastDrive.mic}`;
    $('micBadge').classList.toggle('hidden', !lastDrive.mic);
    $('hrvBadge').textContent = `RHYTHM +${lastDrive.hrv || 0}`;
    $('hrvBadge').classList.toggle('hidden', !lastDrive.hrv);
    $('feelBadge').textContent = `FEEL +${lastDrive.feel || 0}`;
    $('feelBadge').classList.toggle('hidden', !lastDrive.feel || feel?.level === 0);
    const fresh = hrSource === 'ble' ? freshness(feel, Date.now()) : 0;
    $('feelWrap').classList.toggle('hidden', !fresh);
    $('feelWrap').style.opacity = String(0.35 + 0.65 * fresh);
    if (feel) $('feel').textContent = feel.level === 0 ? 'close' : String(feel.level);
    $('goal').textContent = goalText();
}

async function tick() {
    if (!pool) return;
    const now = Date.now();
    const verdict = watchdog.evaluate(now);
    if (verdict.tripped) {
        safetyPaused = true;
        video.pause();
        handy?.stop().catch(() => {});
        alertBox('No heart-rate signal: everything stopped.');
    }
    if (verdict.recovered) {
        alertBox('');
        if (verdict.shouldResume && safetyPaused) { safetyPaused = false; video.play().catch(() => {}); }
    }
    checkGoals();
    // A tab left in the background: browsers slow its timers down (to once a
    // minute after a while), so the heart-rate checks would lag behind the
    // Handy. After three minutes hidden, everything pauses.
    if (hiddenSince && now - hiddenSince > HIDDEN_PAUSE_MS && !safetyPaused && !video.paused) {
        safetyPaused = true;
        video.pause();
        handy?.stop().catch(() => {});
        alertBox('Paused: this tab was in the background for 3 minutes, where the browser slows the heart-rate checks. Press play to go on.');
        logEvent('hidden-pause');
    }
    if (safetyPaused || verdict.status === 'stale') return;
    if (panic) { if (!busy) watchPanic(now); renderBadges(); return; }
    if (!ready || video.paused || hr === null) { renderBadges(); return; }
    // A scene load or half-speed switch in progress must never hide an edge
    // (a recorded session lost one exactly that way): the director still
    // runs; an edge stops the Handy at once and is applied when the switch ends.
    const onlyEdges = busy;
    if (!onlyEdges && pendingEdge) {
        const action = pendingEdge;
        pendingEdge = null;
        busy = true;
        try { await apply(action); } finally { edgeHold = false; if (action.type !== 'scene') busy = false; }
        renderBadges();
        return;
    }
    if (!onlyEdges) trackVisit(now);

    const c = ceiling();
    $('trigger').textContent = c.trigger;
    const d = drive(now);
    lastDrive = d;
    watchEdgeHold(now, d.hr, c.trigger);
    const action = director.tick({
        now,
        hr: d.hr,
        minHr: c.minHr,
        triggerHr: c.trigger,
        released: hasReleasedEdge(d.hr, c.maxHr, c.trigger),
        ceilingBehaviour: settings.ceilingBehaviour,
        levels,
        positionMs: video.currentTime * 1000,
        ...motionAt(video.currentTime * 1000)
    });
    renderBadges();
    if (!action) return;
    if (onlyEdges) {
        if (!EDGE_ACTIONS.includes(action.type)) return;
        edgeHold = true;
        pendingEdge = action;
        handy?.stop().catch(() => {});
        status('Edge: stopping');
        logEvent('edge', { how: action.type, hr, drive: d.hr, rising: d.rising, mic: d.mic, feel: d.feel, during: 'switch' });
        return;
    }
    logEvent(['edge-stop', 'crawl', 'cooldown'].includes(action.type) ? 'edge' : action.type,
        ['edge-stop', 'crawl', 'cooldown'].includes(action.type) ? { how: action.type, hr, drive: d.hr, rising: d.rising, mic: d.mic, feel: d.feel } : (action.why || null));
    busy = true;
    try { await apply(action); } finally { if (action.type !== 'scene') busy = false; }
    // Say so when lookahead or the mic called the edge before the pulse got there.
    if (['edge-stop', 'crawl', 'cooldown'].includes(action.type) && hr < c.trigger) {
        const why = [d.rising && 'rising pulse', d.beat && 'beat timing', d.hrv && 'heart rhythm', d.mic && 'mic', d.feel && 'your rating'].filter(Boolean).join(' + ');
        if (why) $('doing').textContent += ` · caught early (${why})`;
    }
    renderBadges();
}

setInterval(tick, 1000);

// ---- fast forward, half, panic ------------------------------------------------

function heatCap() {
    const c = ceiling();
    const p = hr === null ? 0.5 : bandProgress(drive().hr, c.minHr, c.trigger);
    return { p, maxLevel: p >= warnAt ? 1 : Math.min(5, targetLevel(p, warnAt) + 1) };
}

async function fastForward() {
    if (!ready || busy) return;
    const { p, maxLevel } = heatCap();
    const i = fastForwardWindow(levels, windowIndexAt(video.currentTime * 1000), { maxLevel, tierOf: tierForLevel });
    if (i === null) {
        doing('Fast forward: nothing left here, new video');
        busy = true;
        loadNear(targetLevel(p, warnAt), variant);
        return;
    }
    busy = true;
    try {
        doing('Fast forward: ' + tierForLevel(levels[i]) + ' section');
        await jumpTo(i);
    } finally {
        busy = false;
    }
}

async function toggleHalf() {
    logEvent('half-you', variant !== 'half');
    if (!ready || busy) return;
    const on = variant !== 'half';
    director.setHalf(on);
    doing(on ? 'Half speed (you)' : 'Full speed (you)');
    await switchVariant(on ? 'half' : 'full');
    renderBadges();
}

function logPanic(entry) {
    let log = [];
    try { log = JSON.parse(localStorage.getItem('player_panics') || '[]'); } catch { log = []; }
    log.push(entry);
    localStorage.setItem('player_panics', JSON.stringify(log.slice(-200)));
}

function startPanic() {
    logEvent('panic', { hr });
    const now = Date.now();
    const c = ceiling();
    panic = { since: now, hr: hr ?? c.trigger, calmSince: null };
    scriptStopped = true;
    handy?.stop().catch(() => {});
    sync();
    doing('PANIC: script stopped, video keeps going');
    const first = hrTrail[0];
    closeVisit(now);
    learn({ type: 'panic', sceneId: scene?.id, index: windowIndexAt(video.currentTime * 1000) });
    logPanic({
        at: new Date(now).toISOString(),
        hr: panic.hr,
        trigger: c.trigger,
        typedMax: settings.maxHr,
        risingBpmPer10s: first && now > first.t ? Math.round(((panic.hr - first.hr) * 10000) / (now - first.t)) : null,
        sceneId: scene?.id ?? null,
        tier: tierForLevel(levels[windowIndexAt(video.currentTime * 1000)] ?? -1),
        half: variant === 'half',
        sessionMinutes: Math.round((now - sessionStart) / 60000)
    });
    $('panicText').textContent = `Script stopped at ${panic.hr} BPM. It comes back once you are down and steady.`;
    const suggest = suggestCeilingAfterPanic({ panicHr: panic.hr, minHr: settings.minHr, maxHr: settings.maxHr });
    $('panicAsk').classList.toggle('hidden', suggest === null);
    $('panicButtons').classList.toggle('hidden', suggest === null);
    $('panicSuggest').textContent = suggest ?? '';
    $('panicNow').textContent = settings.maxHr;
    $('panicBox').dataset.suggest = suggest ?? '';
    $('panicBox').classList.remove('hidden');
    renderBadges();
}

function answerPanic(yes) {
    const suggest = Number($('panicBox').dataset.suggest);
    if (yes && Number.isFinite(suggest) && suggest > 0) {
        let raw = {};
        try { raw = JSON.parse(localStorage.getItem('edgeloop_advanced_settings') || '{}') || {}; } catch { raw = {}; }
        raw.maxHr = suggest;
        const checked = sanitizeSessionLimits(raw);
        if (checked.maxHr === suggest) {
            localStorage.setItem('edgeloop_advanced_settings', JSON.stringify(raw));
            settings.maxHr = suggest;
            doing(`Climax HR lowered to ${suggest}`);
            $('trigger').textContent = ceiling().trigger;
        } else {
            doing('Could not lower the ceiling that far');
        }
    }
    $('panicAsk').classList.add('hidden');
    $('panicButtons').classList.add('hidden');
}

function watchPanic(now) {
    if (hr === null) return;
    const c = ceiling();
    const releaseHr = c.trigger - EDGE_RELEASE_BPM;
    const line = Math.min(panic.hr - 8, releaseHr);
    panic.calmSince = hr <= line ? (panic.calmSince ?? now) : null;
    const left = panic.calmSince === null ? null : Math.max(0, Math.ceil((10000 - (now - panic.calmSince)) / 1000));
    doing(left === null ? `PANIC: waiting for your pulse to drop below ${line + 1}` : `PANIC: steady, resuming in about ${left}s`);
    if (panicCanResume({ hr, panicHr: panic.hr, releaseHr, since: panic.since, calmSince: panic.calmSince, now })) endPanic();
}

async function endPanic() {
    logEvent('panic-end', { hr });
    if (!panic) return;
    panic = null;
    $('panicBox').classList.add('hidden');
    busy = true;
    try {
        const slow = mode !== 'dynamic' ? null : chooseWindow(levels, 1, { avoid: windowIndexAt(video.currentTime * 1000), maxLevel: 2 });
        scriptStopped = false;
        director.moved(Date.now(), { halfOn: true });
        if (slow !== null) await jumpTo(slow, 'half');
        else { await switchVariant('half'); await sync(); }
        doing('Back after panic: slow, half speed');
    } finally {
        busy = false;
        renderBadges();
    }
}

// A missed edge (M or Space) needs the same instant stop as panic; it is
// marked first so the recording tells the two apart.
function markMissed() {
    logEvent('missed', { hr });
    if (ready && !panic) startPanic();
    doing('Marked a missed edge: script stopped');
}

function togglePanic() {
    if (!ready) return;
    if (panic) endPanic(); else startPanic();
}

// ---- start -----------------------------------------------------------------

function readGoalInputs() {
    return {
        minMinutes: $('goalMin').value,
        maxMinutes: $('goalMax').value,
        minEdges: $('goalEdges').value
    };
}

function renderFinish() {
    const btn = $('finishBtn');
    btn.disabled = !finishUnlocked || finishing;
    btn.classList.toggle('ready', finishUnlocked && !finishing);
    btn.textContent = finishing ? 'Finishing' : 'Finish';
}

function checkGoals() {
    if (finishUnlocked || !goals) return;
    if (goalsMet(goals, { elapsedMs: Date.now() - sessionStart, edges })) {
        finishUnlocked = true;
        if (!goals.continual) doing('Finish unlocked');
    }
    renderFinish();
}

function goalText() {
    if (!goals || goals.continual || finishing) return '';
    return goals.edges !== null ? `edges ${Math.min(edges, goals.edges)}/${goals.edges}` : '';
}

async function startFinish() {
    if (!ready || !finishUnlocked || finishing) return;
    logEvent('finish');
    finishing = true;
    director.finish();
    if (panic) { panic = null; $('panicBox').classList.add('hidden'); }
    scriptStopped = false;
    doing('Finish');
    renderFinish();
    busy = true;
    try {
        if (variant === 'half') await switchVariant('full');
        if (mode === 'adventure') { await sync(); showCards('Finish: how does it end?'); return; }
        // Regular and Dynamic lean on the ending parts of videos.
        if (mode !== 'pmv') {
            const here = windowIndexAt(video.currentTime * 1000);
            const tailFrom = Math.floor(levels.length * 0.7);
            if (here < tailFrom) await jumpTo(tailIndex(levels, director.target(0)));
        }
        await sync();
    } finally {
        busy = false;
        renderBadges();
    }
}

async function startMode(m) {
    const key = localStorage.getItem('handy_connection_key');
    if ((!key && !noHandy()) || hr === null) return;
    // Still inside the click, so the browser allows audio processing to start.
    if (m !== 'script' && localStorage.getItem('player_normalize') === 'on') setNormalize(true, false);
    if ($('micToggle').checked) {
        if (micState.micAnalyser) micState.micAudioCtx?.resume?.().catch(() => {});
        else startMic();
    }
    mode = m;
    pool = m === 'pmv' ? 'pmv' : m === 'script' ? 'any' : 'regular';
    // Script only drives the Handy from any script with no picture: a silent
    // clock replaces the video and the director runs as in Dynamic.
    if (m === 'script') {
        if (!scriptClock) { scriptClock = new ScriptClock(); bindMedia(scriptClock); }
        video = scriptClock;
    } else {
        video = videoEl;
    }
    document.body.classList.toggle('script-only', m === 'script');
    calibrating = $('calibToggle').checked;
    director = createDirector({ ...directorOptions(), mode: m === 'script' ? 'dynamic' : m === 'adventure' ? 'full' : m, noEdges: calibrating });
    goals = createGoals(readGoalInputs());
    finishUnlocked = goals.continual;
    finishing = false;
    edges = 0;
    localStorage.setItem('player_goals', JSON.stringify(readGoalInputs()));
    $('startStatus').textContent = 'Connecting to The Handy…';
    document.querySelectorAll('.mode').forEach(b => { b.disabled = true; });
    try {
        handy = noHandy() ? createNoHandy() : await connectHandy(key);
    } catch (e) {
        pool = null;
        $('startStatus').textContent = e.message || String(e);
        updateModeButtons();
        return;
    }
    $('start').classList.add('hidden');
    $('bar').classList.remove('hidden');
    showHud();
    sessionStart = Date.now();
    markLive();
    hrvReadings = [];
    const cc = ceiling();
    sessionLog = createSessionLog({ mode: m, hrSource, handy: handy.kind || 'classic', minHr: cc.minHr, maxHr: settings.maxHr, trigger: cc.trigger, warnAt, ceilingBehaviour: settings.ceilingBehaviour, lookahead: lookaheadOn, mic: $('micToggle').checked }, sessionStart);
    doing('Starting');
    renderFinish();
    checkGoals();
    showOffset();
    if (calibrating) alertBox('Calibration run: no pullbacks. Press Finished (X) when you finish. Panic still works.');
    if (m === 'adventure') { adv = { chapter: 0, endsAt: Infinity }; showCards('How do you want to start?'); return; }
    if ($('warmupToggle').checked) warmupStart();
    else loadNear(currentTarget());
}

// No Handy: every mode runs as usual (heart rate, edges, goals, cards) with a
// stand-in that accepts every command and moves nothing. For watching, or
// trying things out, with the device away.
const noHandy = () => $('noHandyToggle').checked;
function createNoHandy() {
    const ok = async () => true;
    return {
        kind: 'none', connect: ok, isConnected: ok, syncTime: ok, play: ok, stop: ok, stopOnUnload() {},
        upload: async (k) => 'none:' + k, load: ok, get loadedUrl() { return null; }
    };
}
$('noHandyToggle').checked = localStorage.getItem('player_no_handy') === 'on';
$('noHandyToggle').addEventListener('change', () => {
    localStorage.setItem('player_no_handy', noHandy() ? 'on' : 'off');
    updateModeButtons();
    if (!pool) loadLibrary();
});

// Newer mode when it is chosen and an Application ID is known; the classic
// mode otherwise, or when the newer one cannot start.
let serverAppId = '';
fetch('api/handy-app-id').then(r => r.json()).then(j => { serverAppId = j.id || ''; }).catch(() => {});
const appId = () => localStorage.getItem('handy_app_id') || serverAppId;

async function connectHandy(key) {
    if (pref('player_handy_mode') === 'stream' && appId()) {
        const h = createHandyV3(key, appId());
        try {
            await h.connect();
            status(`Handy: newer mode${h.info?.fw_version ? ' (firmware ' + h.info.fw_version + ')' : ''}`);
            return h;
        } catch (e) {
            status('Newer mode unavailable (' + (e.message || e) + '): using classic', true);
        }
    }
    const h = createHandy(key);
    await h.connect();
    return h;
}

// The newer mode eases the device back onto the video clock now and then.
setInterval(() => {
    if (!handy?.syncVideo || !ready || busy || scriptStopped || safetyPaused || video.paused) return;
    handy.syncVideo(video.currentTime * 1000 + offsetMs).catch(() => {});
}, 10000);

// ---- controls --------------------------------------------------------------

function togglePlay() {
    if (!ready) return;
    if (safetyPaused) { safetyPaused = false; alertBox(''); }
    if (video.paused) video.play(); else video.pause();
}

// Esc / Exit: stop everything and go back to the start screen. The heart-rate
// monitor stays connected so a new session can start straight away.
async function exitToStart() {
    if (!pool) return;
    loadToken++;
    const h = handy;
    handy = null;
    ready = false;
    video.pause();
    try { await h?.stop(); } catch { h?.stopOnUnload(); }
    leavingScene(Date.now(), false);
    flushLearning();
    video.removeAttribute('src');
    video.load();
    video = videoEl;
    document.body.classList.remove('script-only');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    pool = null;
    scene = null;
    levels = [];
    actions = [];
    busy = false;
    scriptStopped = false;
    safetyPaused = false;
    panic = null;
    variant = 'full';
    edges = 0;
    mode = null;
    goals = null;
    finishUnlocked = false;
    finishing = false;
    lastDrive = { hr: null, rising: 0, mic: 0 };
    clearLive();
    pendingEdge = null;
    edgeHold = false;
    saveSessionLog();
    sessionLog = null;
    hideCards();
    adv = null;
    calibrating = false;
    $('calibBox').classList.add('hidden');
    feel = null;
    feelLeaning = false;
    director.setLean(0);
    director = createDirector(directorOptions());
    renderFinish();
    for (const id of ['bar', 'hud', 'panicBox', 'alert']) $(id).classList.add('hidden');
    $('start').classList.remove('hidden');
    $('startStatus').textContent = 'Session ended. Pick a mode to start again.';
    loadLibrary(true);
    updateModeButtons();
}

function showOffset() {
    $('offset').textContent = `offset ${offsetMs > 0 ? '+' : ''}${offsetMs} ms`;
}

function nudgeOffset(delta) {
    offsetMs = Math.max(-1000, Math.min(1000, offsetMs + delta));
    localStorage.setItem(OFFSET_KEY, String(offsetMs));
    showOffset();
    sync();
}

$('bleBtn').addEventListener('click', connectBle);
$('reconnectBtn').addEventListener('click', () => connectBle());
$('manualBtn').addEventListener('click', useManual);
$('playBtn').addEventListener('click', togglePlay);
videoEl.addEventListener('click', togglePlay);
$('nextBtn').addEventListener('click', skip);
$('stopBtn').addEventListener('click', exitToStart);
$('refreshBtn').addEventListener('click', (e) => loadLibrary(true, { full: e.shiftKey }));

// Warm-up: the first video comes from the slower ones (Stash speed under 200,
// or the script's own median when Stash has none) and starts at its first
// stroke. After that the director runs as usual.
const WARMUP_MAX_SPEED = 200;
$('warmupToggle').checked = localStorage.getItem('player_warmup') === 'on';
$('warmupToggle').addEventListener('change', () => {
    localStorage.setItem('player_warmup', $('warmupToggle').checked ? 'on' : 'off');
});

function warmupStart() {
    const slow = library.filter(s => (s.stashSpeed ?? s.liveMedianSpeed ?? Infinity) < WARMUP_MAX_SPEED);
    const pick = chooseTrack(slow, { pool, target: currentTarget(), recent });
    if (!pick) { doing('No slower videos found: starting normally'); loadNear(currentTarget()); return; }
    doing('Warm-up: a slower video to start');
    loadScene(pick.scene, pick.index, 'full');
}
$('infoBtn').addEventListener('click', toggleHud);
$('ffBtn').addEventListener('click', fastForward);
$('halfBtn').addEventListener('click', toggleHalf);

// Script only: Faster / Slower shift the pace; the director cuts on its next tick.
function nudgePace(delta) {
    if (mode !== 'script' || !ready) return;
    const p = director.nudge(delta);
    doing(p > 0 ? `Faster (pace +${p})` : p < 0 ? `Slower (pace ${p})` : 'Pace back to normal');
}
$('fasterBtn').addEventListener('click', () => nudgePace(1));
$('slowerBtn').addEventListener('click', () => nudgePace(-1));
$('panicBtn').addEventListener('click', togglePanic);
$('panicYes').addEventListener('click', () => answerPanic(true));
$('panicNo').addEventListener('click', () => answerPanic(false));
document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => startMode(b.dataset.mode)));
$('finishBtn').addEventListener('click', startFinish);
try {
    const g = JSON.parse(localStorage.getItem('player_goals') || '{}');
    $('goalMin').value = g.minMinutes ?? '';
    $('goalMax').value = g.maxMinutes ?? '';
    $('goalEdges').value = g.minEdges ?? '';
} catch { /* first visit */ }

// ---- scrubber preview (Stash sprite sheets) ------------------------------------

const PREVIEW_SCALE = 1.5;
let thumbs = { sprite: null, cues: [], sheetW: 0, sheetH: 0, sceneId: null };

function loadThumbs(sceneId) {
    thumbs = { sprite: null, cues: [], sheetW: 0, sheetH: 0, sceneId };
    fetch(`api/scene/${sceneId}/thumbs`).then(r => r.json()).then(({ sprite, cues }) => {
        if (thumbs.sceneId !== sceneId || !sprite || !cues?.length) return;
        const img = new Image();
        img.onload = () => {
            if (thumbs.sceneId !== sceneId) return;
            thumbs = { sprite, cues, sheetW: img.naturalWidth, sheetH: img.naturalHeight, sceneId };
        };
        img.src = sprite;
    }).catch(() => {});
}

function showPreview(e) {
    if (!ready || !video.duration) return;
    const seekBox = $('seek').getBoundingClientRect();
    const barBox = $('bar').getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - seekBox.left) / seekBox.width));
    const t = frac * video.duration;
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
    } else {
        img.removeAttribute('style');
    }
    $('previewTime').textContent = fmt(t);
    const x = e.clientX - barBox.left;
    const left = Math.max(4, Math.min(barBox.width - width - 4, x - width / 2));
    const preview = $('preview');
    preview.style.left = `${left}px`;
    preview.style.width = `${width}px`;
    preview.style.bottom = `${barBox.bottom - seekBox.top + 8}px`;
    preview.classList.remove('hidden');
}

$('seek').addEventListener('mousemove', showPreview);
$('seek').addEventListener('mouseleave', () => $('preview').classList.add('hidden'));

$('seek').addEventListener('click', (e) => {
    if (!ready || !video.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    video.currentTime = ((e.clientX - r.left) / r.width) * video.duration;
    director.moved(Date.now());
});

document.addEventListener('keydown', (e) => {
    // Settings open: Esc closes it, panic still works, nothing else fires.
    if (settingsPanel.isOpen) {
        if (e.code === 'Escape') { e.preventDefault(); settingsPanel.close(); return; }
        if (pool && (e.code === 'AltRight' || (hrSource === 'manual' && e.code === 'NumpadDecimal'))) { e.preventDefault(); if (!e.repeat) togglePanic(); }
        return;
    }
    if (e.code === 'KeyS' && !(e.target instanceof HTMLInputElement)) { settingsPanel.open(); return; }
    // Manual arousal: number pad (or number row) 1-9, 0 = edge. Works on the
    // start screen too, except while typing in a goal box.
    // Number pad . (next to 0) is Panic in manual mode.
    // Heart-rate mode: the number pad rates how you feel (0 = pull back now).
    if (hrSource === 'ble' && pool && /^Numpad[0-9]$/.test(e.code)) {
        e.preventDefault();
        if (!e.repeat) setFeel(Number(e.code.slice(-1)));
        return;
    }
    if ((hrSource === 'manual' || hrSource === 'ble') && pool && e.code === 'NumpadDecimal') {
        e.preventDefault();
        if (!e.repeat) togglePanic();
        return;
    }
    if (hrSource === 'manual' && /^(Numpad|Digit)[0-9]$/.test(e.code) && !(e.target instanceof HTMLInputElement && e.target.type === 'number')) {
        e.preventDefault();
        if (!e.repeat) setArousal(Number(e.code.slice(-1)));
        return;
    }
    if (!pool) return;
    // Panic works whatever has focus, and never doubles as a button press.
    if (e.code === 'AltRight' || e.code === 'KeyP') {
        e.preventDefault();
        if (!e.repeat) togglePanic();
        return;
    }
    // Space is the big easy key for a missed edge: same as M (mark + stop).
    if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) markMissed();
        return;
    }
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === 'Escape') exitToStart();
    else if (e.code === 'KeyN') skip();
    else if (e.code === 'KeyX') markFinished();
    else if (e.code === 'KeyM' && !e.repeat) markMissed();
    else if (e.code === 'KeyI') toggleHud();
    else if (e.code === 'KeyH') toggleHalf();
    else if (e.code === 'ArrowUp' || e.code === 'NumpadAdd') { e.preventDefault(); nudgePace(1); }
    else if (e.code === 'ArrowDown' || e.code === 'NumpadSubtract') { e.preventDefault(); nudgePace(-1); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); fastForward(); }
    else if (e.code === 'BracketLeft') nudgeOffset(-50);
    else if (e.code === 'BracketRight') nudgeOffset(50);
    else if (e.code === 'KeyF') toggleFullscreen();
    else if (e.code === 'KeyV') setNormalize(!leveler.enabled);
});

function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
}
$('fullBtn').addEventListener('click', toggleFullscreen);

// Normalize: live volume leveling, remembered between sessions. It is switched
// on from a click (the mode button or this one) because browsers only start
// audio processing on a user gesture.
const levelerSettings = { ...LEVELER, targetDb: pref('player_norm_target') };
const leveler = createLeveler(videoEl, levelerSettings);

// While on, the button shows the adjustment being applied right now.
function renderNormalize() {
    $('normBtn').classList.toggle('on', leveler.enabled);
    if (!leveler.enabled) { $('normBtn').textContent = 'Normalize'; return; }
    const db = Math.round(leveler.gainDb);
    $('normBtn').textContent = `Normalize ${db > 0 ? '+' : db < 0 ? '−' : '±'}${Math.abs(db)} dB`;
}
setInterval(() => { if (leveler.enabled) renderNormalize(); }, 500);

function setNormalize(on, remember = true) {
    leveler.set(on);
    if (remember) localStorage.setItem('player_normalize', leveler.enabled ? 'on' : 'off');
    renderNormalize();
}

$('normBtn').addEventListener('click', () => setNormalize(!leveler.enabled));
videoEl.addEventListener('play', () => leveler.resume());
document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('fs', Boolean(document.fullscreenElement));
    $('fullBtn').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
});

function onMediaTime() {
    $('time').textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
    if (video.duration) $('played').style.width = (100 * video.currentTime / video.duration) + '%';
    const level = levels[windowIndexAt(video.currentTime * 1000)];
    const tier = level === undefined ? '' : tierForLevel(level);
    $('tier').textContent = tier;
    $('tier').className = 'tier ' + tier;
}

// Bar and cursor fade after 3 s without the mouse.
let idleTimer = 0;
function wake() {
    $('bar').classList.remove('faded');
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (!pool || video.paused || mode === 'script') return;
        // Only the cursor hides; the control bar stays (it no longer covers the video).
        document.body.classList.add('idle');
    }, 3000);
}
document.addEventListener('mousemove', wake);
// The video fills the space between the top bar and the control bar.
new ResizeObserver(() => {
    const h = $('bar').classList.contains('hidden') ? 0 : Math.ceil($('bar').getBoundingClientRect().height);
    document.body.style.setProperty('--bar-h', h + 'px');
}).observe($('bar'));
new MutationObserver(() => {
    const h = $('bar').classList.contains('hidden') ? 0 : Math.ceil($('bar').getBoundingClientRect().height);
    document.body.style.setProperty('--bar-h', h + 'px');
}).observe($('bar'), { attributes: true, attributeFilter: ['class'] });
document.addEventListener('keydown', wake);
// Everything the player listens for on its media clock, attached to the
// <video> element at load and to the ScriptClock when Script-only starts.
function bindMedia(el) {
    for (const ev of ['playing', 'seeked', 'pause', 'waiting', 'seeking']) el.addEventListener(ev, sync);
    el.addEventListener('ended', onMediaEnded);
    el.addEventListener('error', onMediaError);
    el.addEventListener('timeupdate', onMediaTime);
    el.addEventListener('play', () => { $('playBtn').textContent = 'Pause'; });
    el.addEventListener('pause', () => { $('playBtn').textContent = 'Play'; });
    el.addEventListener('pause', wake);
}
bindMedia(videoEl);

window.addEventListener('pagehide', () => {
    if (pool) markLive(true);
    saveSessionLog(true);
    handy?.stopOnUnload();
    leavingScene(Date.now(), false);
    flushLearning(true);
});

// Start screen: offer an earlier half-speed line when panics say so.
function offerEarlierWarning() {
    let panics = [];
    try { panics = JSON.parse(localStorage.getItem('player_panics') || '[]'); } catch { panics = []; }
    const next = suggestEarlierWarning(panics, warnAt);
    const dismissedAt = Number(localStorage.getItem('player_warn_dismissed_count')) || 0;
    if (next === null || panics.length <= dismissedAt) return;
    $('learnText').textContent = `Most of your recent panics came while your pulse was climbing fast. Switch to half speed earlier, at ${Math.round(next * 100)}% of the way to your pullback point instead of ${Math.round(warnAt * 100)}%?`;
    $('learnAsk').classList.remove('hidden');
    $('learnYes').onclick = () => {
        warnAt = next;
        localStorage.setItem('player_warn_at', String(next));
        director.configure({ warnAt: next });
        $('learnAsk').classList.add('hidden');
        $('startStatus').textContent = `Half speed now starts at ${Math.round(next * 100)}%.`;
    };
    $('learnNo').onclick = () => {
        localStorage.setItem('player_warn_dismissed_count', String(panics.length));
        $('learnAsk').classList.add('hidden');
    };
}

loadLibrary(true);

// ---- settings ----------------------------------------------------------------
// Every change applies straight away, mid-session included.

function applySetting(key, value) {
    if (byKey[key]?.store === 'el') {
        Object.assign(settings, readSettings());
        watchdog.configure({ staleMs: settings.staleSeconds * 1000, autoResume: settings.autoResume });
        const c = ceiling();
        $('limits').textContent = `Resting ${c.minHr} · Climax ${settings.maxHr} · pullback at ${c.trigger} BPM · at the ceiling: ${settings.ceilingBehaviour === 'stop' ? 'Full Stop' : 'Crawl'}`;
        renderHr();
        return;
    }
    switch (key) {
        case 'player_warn_at': warnAt = value / 100; director.configure({ warnAt }); break;
        case 'player_dead_grace_s':
        case 'player_half_off_s':
        case 'player_new_clip_pct': director.configure(directorOptions()); break;
        case 'player_lookahead': lookaheadOn = value; $('lookaheadToggle').checked = value; break;
        case 'player_lookahead_s': earlySettings.lookaheadS = value; break;
        case 'player_lookahead_max': earlySettings.maxLookaheadBpm = value; break;
        case 'player_mic':
            if ($('micToggle').checked !== value) { $('micToggle').checked = value; $('micToggle').dispatchEvent(new Event('change')); }
            break;
        case 'player_mic_gate': micGate = value; renderMicSetup(); break;
        case 'player_mic_boost': micStrength = value; renderMicSetup(); break;
        case 'player_normalize': if (leveler.enabled !== value) setNormalize(value); break;
        case 'player_norm_target': levelerSettings.targetDb = value; break;
        case 'player_script_offset_ms': offsetMs = value; showOffset(); if (ready) sync(); break;
        case 'player_hud': hudOn = value; showHud(); break;
        case 'handy_connection_key': updateModeButtons(); if (!pool) loadLibrary(); break;
    }
}

const settingsPanel = mountSettingsPanel({
    onChange: applySetting,
    testHandy: async (key) => {
        try { return await createHandy(key).isConnected(); } catch { return false; }
    },
    handyInfo: async (key) => {
        if (!appId()) return null;
        try {
            const h = createHandyV3(key, appId());
            if (!(await h.isConnected())) return null;
            const r = await fetch('https://www.handyfeeling.com/api/handy-rest/v3/info', { headers: { 'X-Connection-Key': key, 'X-Api-Key': appId() } });
            return (await r.json())?.result ?? null;
        } catch { return null; }
    }
});
$('settingsBtn').addEventListener('click', () => settingsPanel.open());
$('barSettingsBtn').addEventListener('click', () => settingsPanel.open());
for (const id of ['lookaheadToggle', 'micToggle', 'warmupToggle']) $(id).addEventListener('change', () => settingsPanel.refresh());

// ---- adventure ---------------------------------------------------------------
// After each chapter (2.5-4 min), a scene ending, Next or Finish, three cards
// are offered over the playing video. Click one; after 15 s the heart rate
// (or arousal level) picks the one that fits best. Edges, panic and half speed
// work as in Regular: in place, never jumping away mid-chapter.

const PICK_SECONDS = 15;
let adv = null;             // { chapter, endsAt, cards, deadline }
let cardTimer = 0;

function cardImage(c) {
    return c.performerId ? `stash/performer/${c.performerId}/image` : `stash/scene/${c.sceneId}/screenshot`;
}

function showCards(heading) {
    if (!adv || !pool) return;
    const offer = buildCards({ scenes: library, performers, current: scene, chapter: adv.chapter, finishing, target: currentTarget(), recent });
    if (!offer.cards.length) { doing('No cards to offer: next video'); loadNear(currentTarget()); return; }
    adv.cards = offer.cards;
    adv.deadline = Date.now() + PICK_SECONDS * 1000;
    adv.endsAt = Infinity;
    const suggested = autoPick(offer.cards, currentTarget());
    $('cardsStage').textContent = heading + ' · ' + offer.label;
    $('cardsRow').replaceChildren(...offer.cards.map((c, i) => {
        const b = document.createElement('button');
        b.className = 'card ' + c.kind + (i === suggested ? ' suggested' : '');
        const img = document.createElement('div');
        img.className = 'card-img';
        img.style.backgroundImage = `url("${cardImage(c)}")`;
        const body = document.createElement('div');
        body.className = 'card-body';
        const t = document.createElement('div');
        t.className = 'card-title';
        t.textContent = c.title;
        const h = document.createElement('div');
        h.className = 'card-hint';
        h.textContent = c.kind === 'mystery' ? c.hint : [c.kind === 'stay' ? null : c.performerName, c.hint].filter(Boolean).join(' · ');
        const tags = document.createElement('div');
        tags.className = 'card-tags';
        if (c.kind !== 'mystery') for (const l of c.labels) { const x = document.createElement('span'); x.textContent = l; tags.append(x); }
        body.append(t, h, tags);
        b.append(img, body);
        b.addEventListener('click', (e) => { e.stopPropagation(); pickCard(i, 'you'); });
        return b;
    }));
    $('cards').classList.remove('hidden');
    doing('Choose what comes next');
    clearInterval(cardTimer);
    cardTimer = setInterval(cardTick, 250);
    cardTick();
}

function cardTick() {
    if (!adv?.cards) return;
    // The clock waits while a panic is on.
    if (panic) { adv.deadline += 250; $('cardsTimer').textContent = 'paused'; return; }
    const left = Math.max(0, Math.ceil((adv.deadline - Date.now()) / 1000));
    $('cardsTimer').textContent = `${left}s, then your ${hrSource === 'manual' ? 'arousal level' : 'pulse'} picks`;
    if (left <= 0) pickCard(autoPick(adv.cards, currentTarget()), 'auto');
}

function hideCards() {
    clearInterval(cardTimer);
    $('cards').classList.add('hidden');
    if (adv) adv.cards = null;
}

function pickCard(i, who) {
    const c = adv?.cards?.[i];
    if (!c) return;
    const sc = library.find(s => s.id === c.sceneId);
    hideCards();
    if (!sc) { loadNear(currentTarget()); return; }
    adv.chapter++;
    adv.endsAt = Date.now() + chapterLength();
    doing((who === 'auto' ? 'Picked for you: ' : '') + c.title);
    director.setHalf(false);
    if (!panic) scriptStopped = false;
    loadScene(sc, c.index, 'full', { fromMs: c.fromMs ?? (finishing ? c.index * WINDOW_MS : null) });
}

// Chapter over: offer cards, unless an edge, a panic or a load is in progress.
setInterval(() => {
    if (mode !== 'adventure' || !adv || adv.cards || !ready || busy || panic || video.paused) return;
    if (director.edged || scriptStopped) { adv.endsAt = Math.max(adv.endsAt, Date.now() + 20000); return; }
    if (Date.now() >= adv.endsAt) showCards('Chapter over');
}, 1000);

// ---- how I feel (heart-rate mode) ---------------------------------------------
// Number pad 1-9 rates how close you feel, 0 = pull back now. A third opinion
// after the pulse and the mic: it adds a little while fresh (see feel.js),
// a low rating leans the next choices a step hotter (still under the pulse
// cap), and every rating is kept with the pulse at that moment so the player
// can learn where "close" really sits for you.

const FEEL_LOG = 'player_feel_log';
let feel = null;            // { level, at }
let feelLeaning = false;

function setFeel(level) {
    const now = Date.now();
    feel = { level, at: now };
    logEvent(level === 0 || level >= 8 ? 'feel-close' : 'feel', { level, hr });
    let log = [];
    try { log = JSON.parse(localStorage.getItem(FEEL_LOG) || '[]'); } catch { log = []; }
    if (hr !== null) log.push({ level, hr, session: sessionStart, t: now });
    try { localStorage.setItem(FEEL_LOG, JSON.stringify(log.slice(-400))); } catch { /* not critical */ }
    doing(level === 0 ? 'You: close, pulling back' : `You feel ${level}`);
    updateLean(now);
    renderBadges();
}

function updateLean(now) {
    const low = isLow(feel, now);
    if (low !== feelLeaning) { feelLeaning = low; director.setLean(low ? 1 : 0); }
}
setInterval(() => { if (pool && hrSource === 'ble') updateLean(Date.now()); }, 5000);

function offerFeelClimax() {
    let log = [];
    try { log = JSON.parse(localStorage.getItem(FEEL_LOG) || '[]'); } catch { log = []; }
    const s = suggestClimaxFromFeel(log, { maxHr: settings.maxHr, minHr: settings.minHr });
    const seen = Number(localStorage.getItem('player_feel_dismissed_count')) || 0;
    if (!s || log.length <= seen || !$('learnAsk').classList.contains('hidden')) return;
    $('learnText').textContent = `When you rate yourself close (8, 9 or 0), your pulse is usually around ${s.median} BPM (${s.count} ratings). Set Climax HR to ${s.suggested} instead of ${settings.maxHr}?`;
    $('learnAsk').classList.remove('hidden');
    $('learnYes').onclick = () => {
        let raw = {};
        try { raw = JSON.parse(localStorage.getItem('edgeloop_advanced_settings') || '{}') || {}; } catch { raw = {}; }
        raw.maxHr = s.suggested;
        if (sanitizeSessionLimits(raw).maxHr === s.suggested) {
            localStorage.setItem('edgeloop_advanced_settings', JSON.stringify(raw));
            applySetting('maxHr', s.suggested);
            $('startStatus').textContent = `Climax HR is now ${s.suggested}.`;
        }
        localStorage.setItem('player_feel_dismissed_count', String(log.length));
        $('learnAsk').classList.add('hidden');
    };
    $('learnNo').onclick = () => {
        localStorage.setItem('player_feel_dismissed_count', String(log.length));
        $('learnAsk').classList.add('hidden');
    };
}

// Variability baseline: an RMSSD reading every 5 s through the session.
setInterval(() => {
    if (!pool || hrSource !== 'ble') return;
    const r = rmssd(beats, Date.now());
    if (Number.isFinite(r)) { hrvReadings.push(r); if (hrvReadings.length > 720) hrvReadings.shift(); }
}, 5000);

// ---- session recording -------------------------------------------------------
// One row a second (pulse, the rate acted on, what added to it, intensity,
// state) plus every event, saved to data/sessions on this PC every 30 s and
// at the end. Read afterwards to see why an edge was or was not caught.

let sessionLog = null;

function logEvent(type, detail = null) {
    sessionLog?.event(Date.now(), type, detail);
}

setInterval(() => {
    if (!sessionLog || !pool) return;
    const d = hr === null ? { hr: null, rising: 0, mic: 0, feel: 0 } : drive();
    sessionLog.sample(Date.now(), {
        hr, drive: d.hr, rising: d.rising || 0, mic: d.mic || 0, feel: freshness(feel, Date.now()) ? feel.level : null,
        level: levels[windowIndexAt(video.currentTime * 1000)] ?? null,
        half: variant === 'half' ? 1 : 0, edged: director.edged ? 1 : 0, stopped: scriptStopped ? 1 : 0, paused: video.paused ? 1 : 0,
        rr: rrPending.length ? rrPending.splice(0) : null,
        beat: d.beat || 0, hrv: d.hrv || 0,
        contact: lastContact === null ? null : lastContact ? 1 : 0
    });
}, 1000);

function saveSessionLog(leaving = false) {
    if (!sessionLog || sessionLog.size < 10) return;
    const body = JSON.stringify(sessionLog.toJSON());
    if (leaving) { try { fetch('api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < 60000 }); } catch { /* going away */ } return; }
    fetch('api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
}
setInterval(() => saveSessionLog(), 30000);

// ---- calibration ---------------------------------------------------------------
// Finished (button or X) records the real peak: the highest pulse of the last
// minute and a half, from the strap and from the beat timing. Kept across
// sessions, the peaks give a Climax HR, and the pullback lands a few BPM
// under it. The Calibrate switch runs a session with no pullbacks and no
// warning line so the pulse can reach its natural top.

const FINISHES = 'player_finishes';
let calibrating = false;
const peakTrail = [];       // strap readings, last two minutes
const beatTrail = [];       // beat-timing rates, last two minutes

setInterval(() => {
    const now = Date.now();
    if (hr !== null && hrSource === 'ble') peakTrail.push({ t: now, hr });
    const b = hrSource === 'ble' ? instantHr(beats, now) : null;
    if (Number.isFinite(b)) beatTrail.push({ t: now, hr: b });
    for (const list of [peakTrail, beatTrail]) while (list.length && now - list[0].t > 120000) list.shift();
}, 1000);

function markFinished() {
    if (!pool) return;
    const now = Date.now();
    const peak = peakBefore(peakTrail, beatTrail, now);
    logEvent('finished', { ...peak, calibrating });
    scriptStopped = true;
    sync();
    doing('Finished: script stopped');
    if (!peak.strap) {
        $('calibText').textContent = 'Finished noted. No heart-rate readings in the last minute and a half, so there is no peak to learn from.';
        $('calibYes').classList.add('hidden');
        $('calibBox').classList.remove('hidden');
        return;
    }
    let list = [];
    try { list = JSON.parse(localStorage.getItem(FINISHES) || '[]'); } catch { list = []; }
    list.push({ at: new Date(now).toISOString(), strap: peak.strap, beat: peak.beat, session: sessionStart, calibrating });
    list = list.slice(-20);
    try { localStorage.setItem(FINISHES, JSON.stringify(list)); } catch { /* not critical */ }
    const s = suggestFromFinishes(list, { minHr: settings.minHr });
    const beatNote = peak.beat && peak.beat > peak.strap ? ` (beat timing touched ${peak.beat})` : '';
    $('calibText').textContent = `Your pulse peaked at ${peak.strap} BPM${beatNote}. ` +
        (s.finishes > 1 ? `Across your last ${s.finishes} finishes the typical peak is ${s.climax}. ` : '') +
        `Set Climax HR to ${s.climax} and pull back at ${s.pct}% (about ${s.pullbackAt} BPM)? Now: Climax ${settings.maxHr}, pullback ${settings.edgeHoldPercent}%.`;
    $('calibYes').classList.remove('hidden');
    $('calibYes').onclick = () => {
        const a = writeField(localStorage, byKey.maxHr, s.climax);
        if (!a.ok) { $('calibText').textContent = a.error; return; }
        writeField(localStorage, byKey.edgeHoldPercent, s.pct);
        applySetting('maxHr', s.climax);
        applySetting('edgeHoldPercent', s.pct);
        $('calibBox').classList.add('hidden');
        doing(`Climax HR ${s.climax}, pullback at ${s.pct}% (about ${ceiling().trigger} BPM)`);
    };
    $('calibBox').classList.remove('hidden');
}

$('finishedBtn').addEventListener('click', markFinished);
$('calibNo').addEventListener('click', () => $('calibBox').classList.add('hidden'));
// Never remembered: a forgotten Calibrate switch would mean no pullbacks.
$('calibToggle').checked = false;

// ---- page lifecycle safety -------------------------------------------------------
// A running session leaves a note (refreshed every 5 s). A page that ends
// cleanly marks it closed; a crashed or killed page cannot, so the next time
// the player opens it sends the Handy a stop, since the Handy can keep
// playing the strokes already queued on it. A frozen page stops everything.

const LIVE_KEY = 'player_session_live';
const HIDDEN_PAUSE_MS = 180000;
let hiddenSince = document.hidden ? Date.now() : null;

function markLive(closed = false) {
    try { localStorage.setItem(LIVE_KEY, JSON.stringify({ at: Date.now(), closed })); } catch { /* not critical */ }
}
function clearLive() {
    try { localStorage.removeItem(LIVE_KEY); } catch { /* not critical */ }
}
setInterval(() => { if (pool && handy) markLive(); }, 5000);

(function stopLeftover() {
    let live = null;
    try { live = JSON.parse(localStorage.getItem(LIVE_KEY) || 'null'); } catch { live = null; }
    if (!live) return;
    // Fresh and not closed: another open tab is running it right now.
    if (!live.closed && Date.now() - live.at < 15000) return;
    clearLive();
    const key = localStorage.getItem('handy_connection_key');
    if (!key) return;
    fetch('https://www.handyfeeling.com/api/handy/v2/hssp/stop', { method: 'PUT', headers: { 'X-Connection-Key': key } }).catch(() => {});
    fetch('api/handy-app-id').then(r => r.json()).then(j => {
        const id = localStorage.getItem('handy_app_id') || j.id;
        if (id) fetch('https://www.handyfeeling.com/api/handy-rest/v3/hsp/stop', { method: 'PUT', headers: { 'X-Connection-Key': key, 'X-Api-Key': id } }).catch(() => {});
    }).catch(() => {});
    if (!live.closed) {
        alertBox('The last session did not close properly (the page crashed or was closed hard), so the Handy was sent a stop.');
        setTimeout(() => { if (!pool) alertBox(''); }, 12000);
    }
})();

document.addEventListener('visibilitychange', () => { hiddenSince = document.hidden ? Date.now() : null; });
document.addEventListener('freeze', () => {
    if (!pool) return;
    safetyPaused = true;
    try { video.pause(); } catch { /* frozen */ }
    handy?.stopOnUnload();
    logEvent('frozen');
});
document.addEventListener('resume', () => {
    if (pool && safetyPaused) alertBox('The browser froze this page in the background, so everything was stopped. Press play to go on.');
});
