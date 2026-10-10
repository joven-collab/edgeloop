// Funscript analysis for the player: splits a script into fixed windows,
// grades each window into an intensity tier, marks dead spots, and builds a
// half-speed variant that stays on the video's timing. Pure: no I/O.

export const WINDOW_MS = 15000;

// Tier edges in position units per second of travel (0-100 scale). Tuned
// against the user's Stash heatmaps; adjust here only.
export const TIER_EDGES = {
    deadBelow: 8,
    slowLow: 75,
    slowHigh: 150,
    mediumLow: 225,
    mediumHigh: 300,
    intenseLow: 400
};

export const TIERS = ['dead', 'slow', 'medium', 'intense'];

// Six steps inside the three tiers, 0 = slowest live window, 5 = hottest.
export function levelForSpeed(speed) {
    const e = TIER_EDGES;
    if (!(speed >= e.deadBelow)) return -1;
    if (speed < e.slowLow) return 0;
    if (speed < e.slowHigh) return 1;
    if (speed < e.mediumLow) return 2;
    if (speed < e.mediumHigh) return 3;
    if (speed < e.intenseLow) return 4;
    return 5;
}

export function tierForLevel(level) {
    if (level < 0) return 'dead';
    if (level <= 1) return 'slow';
    if (level <= 3) return 'medium';
    return 'intense';
}

// Only finite points inside 0..100, sorted, one per timestamp.
export function cleanActions(actions) {
    if (!Array.isArray(actions)) return [];
    const byTime = new Map();
    for (const a of actions) {
        const at = Number(a?.at);
        const pos = Number(a?.pos);
        if (!Number.isFinite(at) || !Number.isFinite(pos) || at < 0) continue;
        byTime.set(Math.round(at), Math.max(0, Math.min(100, pos)));
    }
    return [...byTime.entries()].sort((x, y) => x[0] - y[0]).map(([at, pos]) => ({ at, pos }));
}

// Direction reversals (plus the first and last point): the stroke skeleton.
export function reversalPoints(actions) {
    const a = cleanActions(actions);
    if (a.length < 2) return a;
    const out = [a[0]];
    let dir = 0;
    for (let i = 1; i < a.length; i++) {
        const d = Math.sign(a[i].pos - a[i - 1].pos);
        if (d === 0) {
            // A hold: keep its start so a pause survives in the skeleton.
            if (a[i].at - a[i - 1].at > 1000 && out[out.length - 1] !== a[i - 1]) out.push(a[i - 1]);
            continue;
        }
        if (dir !== 0 && d !== dir && out[out.length - 1] !== a[i - 1]) out.push(a[i - 1]);
        dir = d;
    }
    if (out[out.length - 1] !== a[a.length - 1]) out.push(a[a.length - 1]);
    return out;
}

export function analyzeScript(actions, durationMs) {
    const a = cleanActions(actions);
    const lastAt = a.length ? a[a.length - 1].at : 0;
    const total = Math.max(Number.isFinite(durationMs) ? durationMs : 0, lastAt);
    const count = Math.max(1, Math.ceil(total / WINDOW_MS));
    const travel = new Array(count).fill(0);
    for (let i = 1; i < a.length; i++) {
        const d = Math.abs(a[i].pos - a[i - 1].pos);
        if (d === 0) continue;
        // Split a leg that crosses a window edge in proportion to time.
        let t0 = a[i - 1].at;
        const t1 = a[i].at;
        const span = Math.max(1, t1 - t0);
        while (t0 < t1) {
            const w = Math.min(count - 1, Math.floor(t0 / WINDOW_MS));
            const edge = Math.min(t1, (w + 1) * WINDOW_MS);
            const part = edge > t0 ? (edge - t0) / span : 1;
            travel[w] += d * part;
            if (edge <= t0 || w === count - 1) break;
            t0 = edge;
        }
    }
    const windows = travel.map((t, i) => {
        const len = Math.min(WINDOW_MS, total - i * WINDOW_MS) || WINDOW_MS;
        const speed = Math.round(t / (len / 1000));
        const level = levelForSpeed(speed);
        return { start: i * WINDOW_MS, speed, level, tier: tierForLevel(level) };
    });
    const live = windows.filter(w => w.level >= 0);
    const mix = { slow: 0, medium: 0, intense: 0 };
    for (const w of live) mix[w.tier]++;
    for (const k of Object.keys(mix)) mix[k] = live.length ? Math.round((100 * mix[k]) / live.length) : 0;
    const liveSpeeds = live.map(w => w.speed).sort((x, y) => x - y);
    return {
        durationMs: total,
        windows,
        mix,
        deadPercent: Math.round((100 * (windows.length - live.length)) / windows.length),
        liveMedianSpeed: liveSpeeds.length ? liveSpeeds[Math.floor(liveSpeeds.length / 2)] : 0,
        firstActionMs: a.length ? a[0].at : null
    };
}

// Compact form for the cache: one level digit per window ('x' = dead).
export function encodeLevels(windows) {
    return windows.map(w => (w.level < 0 ? 'x' : String(w.level))).join('');
}

export function decodeLevels(str) {
    return [...String(str || '')].map(c => (c === 'x' ? -1 : Number(c)));
}

// Half speed: every other stroke is dropped, so each remaining stroke takes
// twice as long but still starts and ends on the video's own beats. Pauses
// (gaps longer than PAUSE_MS) split the script into runs that are halved
// separately, so a pause stays where it was.
export const PAUSE_MS = 2000;

export function halfSpeedActions(actions) {
    const r = reversalPoints(actions);
    if (r.length < 3) return r;
    const runs = [[r[0]]];
    for (let i = 1; i < r.length; i++) {
        const gap = r[i].at - r[i - 1].at;
        const still = r[i].pos === r[i - 1].pos;
        if (gap > PAUSE_MS && still) runs.push([r[i]]);
        else runs[runs.length - 1].push(r[i]);
    }
    const out = [];
    for (const run of runs) {
        if (run.length < 3) { out.push(...run); continue; }
        // Kept anchors are every other reversal: same turn type each time, so
        // the missing opposite turn between two anchors takes the extreme of
        // the two strokes that were merged.
        for (let j = 0; 2 * j < run.length; j++) {
            const anchor = run[2 * j];
            if (j % 2 === 0) {
                out.push({ at: anchor.at, pos: anchor.pos });
            } else {
                const a = run[2 * j - 1];
                const b = run[2 * j + 1];
                const up = a.pos > run[2 * j - 2].pos;
                const pos = b ? (up ? Math.max(a.pos, b.pos) : Math.min(a.pos, b.pos)) : a.pos;
                out.push({ at: anchor.at, pos });
            }
        }
        const last = run[run.length - 1];
        if (out[out.length - 1].at !== last.at) out.push({ at: last.at, pos: last.pos });
    }
    return cleanActions(out);
}
