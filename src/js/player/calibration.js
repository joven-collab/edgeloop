// Calibration: find your real Climax HR from the moment you actually finish.
// "Finished" (button or X) records the highest pulse of the last minute and
// a half, from both the strap's BPM and the beat timing, and keeps it with
// earlier finishes. The Climax HR then comes from those peaks, and the
// pullback mark sits a few BPM below it, where there is still time to stop.
// Pure: no DOM, timers or storage.

export const CALIBRATION = Object.freeze({
    windowMs: 90000,    // how far back a finish looks for the peak
    marginBpm: 7,       // pullback this far under the typical peak
    minPct: 90,         // pullback % bounds (the setting's own range)
    maxPct: 97,
    keep: 20,           // finishes remembered
    holdMs: 3000        // a peak counts only if the pulse held it this long
});

// The highest level the readings stayed at (or above) for `holdMs`: the
// largest "lowest reading over any holdMs stretch". One glitchy reading from
// the strap cannot become the peak.
export function heldPeak(points, holdMs = CALIBRATION.holdMs) {
    const p = points.filter(x => Number.isFinite(x.hr)).sort((a, b) => a.t - b.t);
    let best = null;
    for (let i = 0; i < p.length; i++) {
        let low = p[i].hr;
        let j = i;
        while (j + 1 < p.length && p[j + 1].t - p[i].t < holdMs) { j++; low = Math.min(low, p[j].hr); }
        if (p[j].t - p[i].t < holdMs * 0.6) continue;   // not enough readings in the stretch
        if (best === null || low > best) best = low;
    }
    return best;
}

// The peak your pulse held in the window before `now`, from strap readings
// [{ t, hr }] and beat-timing rates [{ t, hr }].
export function peakBefore(readings, beatRates, now, s = CALIBRATION) {
    const inWindow = (x) => now - x.t <= s.windowMs && now >= x.t && Number.isFinite(x.hr);
    return { strap: heldPeak(readings.filter(inWindow), s.holdMs), beat: heldPeak(beatRates.filter(inWindow), s.holdMs) };
}

// Climax HR and pullback from the recorded finishes: the median strap peak
// (one odd session does not move it much), and a pullback % that lands
// `marginBpm` under it.
export function suggestFromFinishes(finishes, { minHr }, s = CALIBRATION) {
    const peaks = (finishes || []).map(f => f.strap).filter(Number.isFinite).sort((a, b) => a - b);
    if (!peaks.length) return null;
    const climax = Math.max(minHr + 15, peaks[Math.floor(peaks.length / 2)]);
    const pct = Math.max(s.minPct, Math.min(s.maxPct, Math.round(100 * (climax - s.marginBpm) / climax)));
    return { climax, pct, pullbackAt: Math.round(climax * pct / 100), finishes: peaks.length };
}
