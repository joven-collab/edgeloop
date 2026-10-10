// "How I feel" ratings in heart-rate mode: number pad 1-9, 0 = pull back now.
// A rating is a third opinion after the pulse and the microphone, so it only
// adds a little to the rate the director acts on, and only while fresh:
// full for a minute, then fading out over the next.
// Pure: no DOM, timers or storage.

export const FEEL = Object.freeze({
    holdMs: 60000,      // full weight this long
    fadeMs: 60000,      // then fades to nothing over this long
    weight: 0.5,        // share of the gap between pulse and the rating's level
    maxBpm: 8,          // most a 1-9 rating can add
    closeAt: 8,         // ratings this high (and 0) mean "close"
    lowAt: 3            // ratings this low ask for a little more
});

// 1 while fresh, then fading to 0.
export function freshness(rating, now, s = FEEL) {
    if (!rating) return 0;
    const age = now - rating.at;
    if (age <= s.holdMs) return 1;
    return Math.max(0, 1 - (age - s.holdMs) / s.fadeMs);
}

// The heart rate a rating stands for, on the same scale as manual arousal:
// 1 = resting, 9 = just under the half-speed line, 0 = over the pullback mark.
export function ratingHr(level, { minHr, triggerHr, top = 0.85 }) {
    if (level === 0) return triggerHr + 2;
    return Math.round(minHr + ((level - 1) / 8) * top * (triggerHr - minHr));
}

// Extra BPM the rating adds right now. Never negative: feeling calm never
// hides a pulse that is climbing. A 0 goes straight past the mark (that is
// what "pull back now" means) for as long as it is fresh.
export function feelBpm({ rating, hr, minHr, triggerHr, now }, s = FEEL) {
    const f = freshness(rating, now, s);
    if (!f || !Number.isFinite(hr)) return 0;
    const target = ratingHr(rating.level, { minHr, triggerHr });
    if (rating.level === 0) return Math.max(0, Math.round((target - hr) * f));
    const gap = Math.max(0, target - hr);
    return Math.round(Math.min(s.maxBpm, gap * s.weight) * f);
}

export const isLow = (rating, now, s = FEEL) => Boolean(rating) && rating.level > 0 && rating.level <= s.lowAt && freshness(rating, now, s) > 0;

// ---- learning your curve -----------------------------------------------------
// Each rating is kept with the pulse at that moment. Once a few "close"
// ratings (8, 9, 0) have come in over at least two sessions, the typical
// pulse at "close" says where the Climax HR probably belongs.

export const CURVE = Object.freeze({ minClose: 8, minSessions: 2, margin: 4, minChange: 4 });

export function suggestClimaxFromFeel(samples, { maxHr, minHr }, s = CURVE, f = FEEL) {
    const close = (samples || []).filter(x => (x.level === 0 || x.level >= f.closeAt) && Number.isFinite(x.hr));
    if (close.length < s.minClose) return null;
    if (new Set(close.map(x => x.session)).size < s.minSessions) return null;
    const hrs = close.map(x => x.hr).sort((a, b) => a - b);
    const median = hrs[Math.floor(hrs.length / 2)];
    // The pullback should land a little above where "close" usually shows.
    const suggested = Math.max(minHr + 15, Math.round(median + s.margin));
    if (Math.abs(suggested - maxHr) < s.minChange) return null;
    return { suggested, median, count: close.length };
}
