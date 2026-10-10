// Personal learning: how the wearer's pulse actually responds to each section,
// which scenes get skipped, and where panics happen. Pure; the server stores
// the data and the player feeds it events.

export const MIN_VISIT_MS = 10000;
export const MIN_SAMPLES = 2;
export const SLOPE_STEP = 6;       // BPM/min difference worth one level
export const SKIP_FACTOR = 0.7;    // weight per net skip
export const MIN_WEIGHT = 0.15;

export function emptyLearning() {
    return { version: 1, scenes: {}, levels: {} };
}

// A finished stay in one window. Returns null when it says nothing useful.
export function makeVisit({ sceneId, index, level, startHr, endHr, startAt, endAt, half = false, edged = false }) {
    const ms = endAt - startAt;
    if (!sceneId || !(ms >= MIN_VISIT_MS) || half || edged || level < 0) return null;
    if (!Number.isFinite(startHr) || !Number.isFinite(endHr)) return null;
    return { type: 'visit', sceneId: String(sceneId), index, level, slope: ((endHr - startHr) * 60000) / ms };
}

function sceneOf(data, id) {
    if (!data.scenes[id]) data.scenes[id] = { plays: 0, skips: 0, panics: 0, win: {} };
    return data.scenes[id];
}

// Fold events into the stored data (mutates and returns it).
export function applyEvents(data, events) {
    const d = data && data.scenes ? data : emptyLearning();
    for (const e of Array.isArray(events) ? events : []) {
        if (!e || typeof e.sceneId !== 'string' && typeof e.sceneId !== 'number') continue;
        const s = sceneOf(d, String(e.sceneId));
        if (e.type === 'play') s.plays++;
        else if (e.type === 'skip') s.skips++;
        else if (e.type === 'panic') {
            s.panics++;
            if (Number.isInteger(e.index)) {
                const w = (s.win[e.index] ||= { n: 0, sum: 0, panics: 0 });
                w.panics = (w.panics || 0) + 1;
            }
        } else if (e.type === 'visit' && Number.isInteger(e.index) && Number.isFinite(e.slope) && Number.isInteger(e.level)) {
            const slope = Math.max(-60, Math.min(60, e.slope));
            const w = (s.win[e.index] ||= { n: 0, sum: 0, panics: 0 });
            w.n++;
            w.sum += slope;
            const l = (d.levels[e.level] ||= { n: 0, sum: 0 });
            l.n++;
            l.sum += slope;
        }
    }
    return d;
}

// Scene weight for random picks: skips push it down, finished plays pull it
// back up a little.
export function sceneWeight(stats) {
    if (!stats) return 1;
    const net = Math.max(0, (stats.skips || 0) - 0.5 * (stats.plays || 0));
    return Math.max(MIN_WEIGHT, Math.pow(SKIP_FACTOR, net));
}

// The scene's window levels, nudged by what the wearer's pulse has shown:
// a window that heats up more than its level usually does counts one level
// hotter (and vice versa); a window with a panic counts one level hotter.
export function adjustLevels(levels, stats, levelStats = {}) {
    if (!stats?.win) return levels;
    return levels.map((l, i) => {
        if (l < 0) return l;
        const w = stats.win[i];
        if (!w) return l;
        let adj = 0;
        const typical = levelStats[l];
        if (w.n >= MIN_SAMPLES && typical?.n >= MIN_SAMPLES) {
            const diff = w.sum / w.n - typical.sum / typical.n;
            adj = Math.max(-1, Math.min(1, Math.round(diff / SLOPE_STEP)));
        }
        if (w.panics > 0) adj = Math.max(adj, 1);
        return Math.max(0, Math.min(5, l + adj));
    });
}

// Offer an earlier half-speed line when most recent panics came on a fast
// climb. Returns the suggested warning share or null.
export function suggestEarlierWarning(panics, currentWarnAt) {
    const recent = (Array.isArray(panics) ? panics : []).slice(-6).filter(p => Number.isFinite(p?.risingBpmPer10s));
    if (recent.length < 3) return null;
    const fast = recent.filter(p => p.risingBpmPer10s >= 8).length;
    if (fast / recent.length < 0.6) return null;
    const next = Math.round((currentWarnAt - 0.05) * 100) / 100;
    return next >= 0.7 ? next : null;
}

// Dynamic mode: how long to stay in a clip before cutting. Weighted chances
// over three bands, nudged by what the data says about this clip: scenes that
// get skipped lean short, clips that heat the wearer up more than usual (and
// scenes that get finished) lean long.
export const DWELL_BANDS = Object.freeze([
    { name: 'short', minMs: 45000, maxMs: 75000, weight: 0.3 },
    { name: 'medium', minMs: 75000, maxMs: 120000, weight: 0.45 },
    { name: 'long', minMs: 120000, maxMs: 180000, weight: 0.25 }
]);

export function dwellWeights({ sceneStats, windowIndex, level, levelStats = {} } = {}) {
    const w = DWELL_BANDS.map(b => b.weight);
    const sw = sceneWeight(sceneStats);
    if (sw < 1) { const shift = (1 - sw) * 0.3; w[0] += shift; w[2] -= shift; }
    if ((sceneStats?.plays || 0) >= 2) { w[2] += 0.1; w[0] -= 0.05; }
    const win = sceneStats?.win?.[windowIndex];
    const typical = levelStats[level];
    if (win?.n >= MIN_SAMPLES && typical?.n >= MIN_SAMPLES && !(win.panics > 0)) {
        const diff = win.sum / win.n - typical.sum / typical.n;
        if (diff > SLOPE_STEP / 2) { w[2] += 0.2; w[0] -= 0.1; }
        else if (diff < -SLOPE_STEP / 2) { w[0] += 0.2; w[2] -= 0.1; }
    }
    const clamped = w.map(x => Math.max(0.05, x));
    const total = clamped.reduce((a, b) => a + b, 0);
    return clamped.map(x => x / total);
}

export function chooseDwellMs(context = {}, rand = Math.random) {
    const weights = dwellWeights(context);
    let r = rand();
    let band = DWELL_BANDS[DWELL_BANDS.length - 1];
    for (let i = 0; i < DWELL_BANDS.length; i++) {
        if (r < weights[i]) { band = DWELL_BANDS[i]; break; }
        r -= weights[i];
    }
    return Math.round(band.minMs + rand() * (band.maxMs - band.minMs));
}
