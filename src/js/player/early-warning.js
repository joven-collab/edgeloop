// Catching an edge sooner. Heart-rate monitors run 5-15 s behind the body, so
// the player reacts to a "drive" heart rate that can sit above the measured
// one for two reasons:
//   - lookahead: a pulse that is climbing fast is projected a few seconds
//     ahead, so the warning line and the pullback mark arrive earlier;
//   - microphone: sustained loud breathing or voice adds a few BPM.
// Both only ever ADD, so they can only make things calmer or edge sooner.
// The measured pulse still drives the readout, the learning data and the
// panic resume; only the director's decisions use the drive rate.

export const EARLY = Object.freeze({
    trendWindowMs: 10000,  // readings used for the slope
    minSpanMs: 4000,       // need at least this much history
    minPoints: 3,
    lookaheadS: 8,         // how far ahead a climb is projected
    minSlope: 0.15,        // BPM/s; slower drift is jitter, ignored
    maxLookaheadBpm: 12,
    fromBand: 0.4,         // only in the upper part of the resting-to-mark band
    micRiseS: 1.2,         // loudness envelope: builds over ~1 s (one cough barely counts)
    micFallS: 5            // and lets go slowly, so panting between breaths holds
});

// Least-squares slope of the recent readings, BPM per second. Null when
// there is not enough history to trust it.
export function hrSlope(trail, now, s = EARLY) {
    const pts = trail.filter(p => now - p.t <= s.trendWindowMs);
    if (pts.length < s.minPoints) return null;
    if (pts[pts.length - 1].t - pts[0].t < s.minSpanMs) return null;
    const n = pts.length;
    let mt = 0, mh = 0;
    for (const p of pts) { mt += p.t; mh += p.hr; }
    mt /= n; mh /= n;
    let num = 0, den = 0;
    for (const p of pts) { num += (p.t - mt) * (p.hr - mh); den += (p.t - mt) ** 2; }
    return den > 0 ? (num / den) * 1000 : null;
}

// Extra BPM from a fast climb. Zero low in the band (where it would only
// make the intensity cap twitchy) and whenever the pulse is steady or falling.
export function lookaheadBpm({ trail, now, hr, minHr, triggerHr }, s = EARLY) {
    if (!Number.isFinite(hr) || !(triggerHr > minHr)) return 0;
    if ((hr - minHr) / (triggerHr - minHr) < s.fromBand) return 0;
    const slope = hrSlope(trail, now, s);
    if (slope === null || slope < s.minSlope) return 0;
    return Math.min(s.maxLookaheadBpm, Math.round(slope * s.lookaheadS));
}

// One step of the loudness envelope (0-100): quick-ish up, slow down.
export function micEnvelope(prev, level, dtSeconds, s = EARLY) {
    const tau = level > prev ? s.micRiseS : s.micFallS;
    const k = 1 - Math.exp(-dtSeconds / tau);
    return prev + (level - prev) * k;
}

// The rate the director acts on.
export function driveHr({ hr, lookahead = 0, mic = 0 }) {
    if (!Number.isFinite(hr)) return hr;
    return hr + Math.max(0, lookahead) + Math.max(0, mic);
}

// ---- beat-to-beat signals ------------------------------------------------------
// The strap also reports the time between heartbeats. Averaged BPM lags a few
// beats; the last few intervals give a faster "instant" rate. And the beat-to-
// beat variation (RMSSD) collapses as arousal peaks: in a recorded session it
// fell from ~60 ms to ~15 ms five seconds before the pulse topped out.

export const BEATS = Object.freeze({
    instantBeats: 3,        // last beats averaged for the instant rate
    instantMs: 5000,        // ...if they arrived this recently
    hrvWindowMs: 20000,     // beats used for RMSSD
    minBeats: 6,
    baselineMin: 6,         // RMSSD readings needed before a baseline counts
    collapseAt: 0.35,       // RMSSD under this share of the session baseline = collapsed
    deepAt: 0.2,
    collapseBpm: 6,
    deepBpm: 10,
    fromBand: 0.45          // only counted in the upper part of the band
});

const clean = (beats, now, windowMs) => beats.filter(b => now - b.t <= windowMs && b.rr >= 300 && b.rr <= 1500);

export function instantHr(beats, now, s = BEATS) {
    const b = clean(beats, now, s.instantMs).slice(-s.instantBeats);
    if (b.length < 2) return null;
    return Math.round(60000 / (b.reduce((a, x) => a + x.rr, 0) / b.length));
}

export function rmssd(beats, now, s = BEATS) {
    const b = clean(beats, now, s.hrvWindowMs);
    if (b.length < s.minBeats) return null;
    let sum = 0;
    for (let k = 1; k < b.length; k++) sum += (b[k].rr - b[k - 1].rr) ** 2;
    return Math.sqrt(sum / (b.length - 1));
}

// Median of the RMSSD readings taken so far this session.
export function hrvBaseline(readings, s = BEATS) {
    if (readings.length < s.baselineMin) return null;
    const sorted = [...readings].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

// Extra BPM when variability has collapsed while the pulse is high.
export function hrvBpm({ current, baseline, hr, minHr, triggerHr }, s = BEATS) {
    if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline <= 0) return 0;
    if (!(triggerHr > minHr) || (hr - minHr) / (triggerHr - minHr) < s.fromBand) return 0;
    const ratio = current / baseline;
    if (ratio < s.deepAt) return s.deepBpm;
    if (ratio < s.collapseAt) return s.collapseBpm;
    return 0;
}
