// The director: turns heart rate into "what should be playing now" for the
// player. Pure and clock-driven, so it can be tested without a browser.
//
// Heart-rate ladder:
//   below the warning line  -> the pulse CAPS intensity; a drifting mood
//                              picks what to play underneath that cap
//   warning line and above  -> half speed, slow sections
//   pullback mark (edge)    -> Full Stop (script stopped, video plays on) or
//                              Crawl (slowest section at half speed)
//   edge released           -> resume in a slow section, sometimes a new scene
import { WINDOW_MS } from '../library/script-analysis.js';

export const DIRECTOR_DEFAULTS = Object.freeze({
    warnAt: 0.9,            // share of the resting -> pullback band
    minDwellMs: 90000,      // default stay in a Dynamic clip (the player passes a weighted one)
    pulseDwellMs: 20000,    // the pulse may force an ease-off after this long
    newSceneOnRelease: 0.7, // chance an edge cuts to a different clip
    newSceneOnCut: 0.4,     // chance an ordinary cut goes to a different video
    halfOffBelow: 0.5,      // half speed ends after this long below this band
    halfOffAfterMs: 45000,
    deadGraceMs: 4000,      // stillness allowed after the action stops
    comingSoonMs: 1500,     // a stroke this close means the pause is ending
    mode: 'dynamic'         // 'dynamic' | 'full' (Regular) | 'pmv'
});

export function bandProgress(hr, minHr, triggerHr) {
    const span = Math.max(1, triggerHr - minHr);
    return Math.max(0, Math.min(1, (hr - minHr) / span));
}

// The most the pulse allows: 5 (hottest) at rest down to 0 at the warning line.
export function targetLevel(progress, warnAt = DIRECTOR_DEFAULTS.warnAt) {
    if (progress >= warnAt) return 0;
    return Math.max(0, Math.min(5, Math.round(5 * (1 - progress / warnAt))));
}

export function windowIndexAt(ms) {
    return Math.max(0, Math.floor(ms / WINDOW_MS));
}

// Best window for `target` in one scene, avoiding the window we are in and
// the ones right next to it. Later windows win ties so a jump feels like
// moving on. Returns null when nothing is within one level of the target.
export function chooseWindow(levels, target, { avoid = -1, rand = Math.random, maxLevel = 5, minIndex = 0 } = {}) {
    let best = Infinity;
    let picks = [];
    for (let i = minIndex; i < levels.length; i++) {
        const l = levels[i];
        if (l < 0 || l > maxLevel) continue;
        if (avoid >= 0 && Math.abs(i - avoid) <= 1) continue;
        // The final window is too close to the end to be worth starting in.
        if (levels.length > 2 && i === levels.length - 1) continue;
        // The next window must be live too, so a start is never 15 s from a dead spot.
        if (i + 1 < levels.length && levels[i + 1] < 0) continue;
        const d = Math.abs(l - target);
        if (d < best) { best = d; picks = [i]; } else if (d === best) picks.push(i);
    }
    if (!picks.length || best > 1) return null;
    const later = avoid >= 0 ? picks.filter(i => i > avoid) : picks;
    const pool = later.length ? later : picks;
    return pool[Math.floor(rand() * pool.length)];
}

// A scene from `pool` with a window near `target`, skipping recent ones.
export function chooseScene(scenes, { pool, target, recent = [], excludeId = null, rand = Math.random, maxLevel = 5 }) {
    const inPool = scenes.filter(s => (pool === 'any' || s.pool === pool) && s.id !== excludeId);
    const fresh = inPool.filter(s => !recent.includes(s.id));
    // Weighted shuffle: a scene's `weight` (default 1) makes it come up
    // proportionally more or less often.
    const order = (list) => list
        .map(s => ({ s, key: Math.pow(Math.max(rand(), 1e-9), 1 / Math.max(0.01, s.weight ?? 1)) }))
        .sort((a, b) => b.key - a.key)
        .map(x => x.s);
    for (const list of [fresh, inPool]) {
        for (const s of order(list)) {
            const idx = chooseWindow(s.levelArray, target, { rand, maxLevel });
            if (idx !== null) return { scene: s, index: idx };
        }
    }
    return null;
}

// Mood: what the director aims for when the pulse leaves room. The heart rate
// only caps intensity; the mood wanders underneath that cap so a low pulse
// does not simply mean "hottest possible" (which loops: intense -> pulse up ->
// slow -> pulse down -> intense).
export const MOOD_DEFAULTS = Object.freeze({
    start: 2,
    min: 1,
    max: 4,
    stepMinMs: 120000,       // how long a mood holds before it may move
    stepMaxMs: 240000,
    buildChance: 0.12,       // per step: a build-up to intense
    buildMs: 75000,          // how long a build-up lasts
    lowPulseBelow: 0.3,      // pulse this low in the band...
    lowPulseForMs: 180000    // ...for this long nudges the mood up a step
});

export function createMood(options = {}, now = 0, rand = Math.random) {
    const m = { ...MOOD_DEFAULTS, ...options };
    const holdFor = () => m.stepMinMs + rand() * (m.stepMaxMs - m.stepMinMs);
    return { cfg: m, level: m.start, nextAt: now + holdFor(), buildUntil: 0, lowSince: null, holdFor };
}

// Advances the mood clock. Returns { level, changed, why }.
export function advanceMood(mood, { now, p, rand = Math.random }) {
    const m = mood.cfg;
    let changed = false;
    let why = '';

    if (mood.buildUntil && now >= mood.buildUntil) {
        mood.buildUntil = 0;
        changed = true;
        why = 'Mood: settling back down';
    }

    // A pulse that stays low leans the mood up so a session never stalls.
    if (p < m.lowPulseBelow) {
        if (mood.lowSince === null) mood.lowSince = now;
        if (now - mood.lowSince >= m.lowPulseForMs && mood.level < m.max) {
            mood.level++;
            mood.lowSince = now;
            changed = true;
            why = 'Mood: pulse is low, leaning up';
        }
    } else {
        mood.lowSince = null;
    }

    if (now >= mood.nextAt) {
        mood.nextAt = now + mood.holdFor();
        const r = rand();
        if (!mood.buildUntil && r < m.buildChance) {
            mood.buildUntil = now + m.buildMs;
            changed = true;
            why = 'Mood: building up';
        } else if (r < m.buildChance + 0.3 && mood.level < m.max) {
            mood.level++;
            changed = true;
            why = 'Mood: drifting up';
        } else if (r < m.buildChance + 0.6 && mood.level > m.min) {
            mood.level--;
            changed = true;
            why = 'Mood: easing off';
        }
    }
    return { level: mood.buildUntil ? 5 : mood.level, changed, why };
}

// Stateful wrapper around the rules above. Modes:
//   dynamic  a random denial compilation: clips cut after a weighted stay,
//            edges usually cut to a new clip, the pulse can force an ease-off
//   full     "Regular": each video plays start to finish; edges are handled
//            in place (half speed or a stopped script), never by jumping
//   pmv      tracks play through; an edge cools down the rest of the track
// `tick` returns at most one action for the player:
//   { type: 'edge-stop' }                  stop the script, keep the video
//   { type: 'crawl', index }               half speed; index = slow section to
//                                          jump to, or null to stay in place
//   { type: 'cooldown' }                   PMV: script off for the rest of the track
//   { type: 'jump', index, half }          seek within the scene
//   { type: 'scene', target, half }        load another scene near target
//   { type: 'half', on }                   switch the half-speed script
//   { type: 'resume' }                     restart the script where it is
export function createDirector(options = {}) {
    const o = { ...DIRECTOR_DEFAULTS, ...options };
    let sectionSince = 0;
    let dwellMs = o.minDwellMs;
    let edged = false;
    let stopped = false;
    let cooldown = false;
    let half = false;
    let calmSince = null;
    let finishing = false;
    // Faster / Slower: a manual shift on top of the mood, still under the cap.
    let pace = 0;
    let cutNow = false;
    // A quiet lean from "how I feel" ratings: like pace, but it never forces
    // a cut; it only shapes the next choice.
    let lean = 0;
    const mood = createMood(options.mood, 0, options.rand ?? Math.random);
    let moodLevel = mood.level;

    // Heart rate caps; the mood picks underneath the cap; half speed keeps
    // it gentle. Finishing leans hotter but still follows the mood.
    const aim = (p) => {
        const wanted = Math.max(0, Math.min(5, moodLevel + pace + lean));
        if (finishing) return Math.max(0, Math.min(5, Math.max(3, moodLevel) + pace + lean));
        const cap = targetLevel(p, o.warnAt);
        return half ? Math.min(cap, wanted, 1) : Math.min(cap, wanted);
    };

    const halfRules = (now, p) => {
        if (!o.noEdges && p >= o.warnAt && !half) { half = true; calmSince = null; return { type: 'half', on: true }; }
        if (half && p < o.halfOffBelow) {
            if (calmSince === null) calmSince = now;
            if (now - calmSince >= o.halfOffAfterMs) { half = false; calmSince = null; return { type: 'half', on: false }; }
        } else {
            calmSince = null;
        }
        return null;
    };

    return {
        configure(next = {}) { Object.assign(o, next); },
        get edged() { return edged; },
        get half() { return half; },
        get cooldown() { return cooldown; },
        get finishing() { return finishing; },
        get mood() { return moodLevel; },
        get pace() { return pace; },
        // Faster (+1) / Slower (-1): shift the aim and cut on the next tick.
        setLean(v) { lean = Math.max(-1, Math.min(1, v)); },
        nudge(delta) {
            pace = Math.max(-3, Math.min(3, pace + delta));
            cutNow = true;
            return pace;
        },
        // What to aim for right now (scene picks, skips, track changes).
        target(p) { return aim(p); },
        // The player moved (new scene, jump, skip): restart the stay clock.
        moved(now, { halfOn, newScene = false, dwell } = {}) {
            sectionSince = now;
            if (Number.isFinite(dwell)) dwellMs = dwell;
            if (halfOn !== undefined) half = halfOn;
            calmSince = null;
            if (newScene && o.mode === 'pmv') { cooldown = false; edged = false; stopped = false; }
        },
        setHalf(on) { half = on; calmSince = null; },
        // Finish: no more pullbacks, half speed or cool-downs.
        finish() { finishing = true; edged = false; stopped = false; cooldown = false; },
        // idleMs: time since the last stroke; nextActionInMs: time to the next
        // one (Infinity when the script has ended). Both come from the loaded
        // script, so a dead spot is judged on real strokes, not window grades.
        tick({ now, hr, minHr, triggerHr, released, ceilingBehaviour = 'crawl', levels, positionMs, idleMs = 0, nextActionInMs = 0, rand = Math.random }) {
            const p = bandProgress(hr, minHr, triggerHr);
            const idx = windowIndexAt(positionMs);
            const moodStep = advanceMood(mood, { now, p, rand });
            moodLevel = moodStep.level;
            const stalled = idleMs >= o.deadGraceMs && nextActionInMs > o.comingSoonMs;
            // Calibration runs to the natural top: no pullbacks, no warning line.
            const atMark = !o.noEdges && hr >= triggerHr;

            if (finishing) {
                if (half) { half = false; return { type: 'half', on: false }; }
                if (o.mode !== 'dynamic') return null;
                const target = aim(p);
                const tail = Math.floor(levels.length * 0.7);
                const endOfVideo = positionMs >= levels.length * WINDOW_MS - 5000;
                if (stalled || endOfVideo || now - sectionSince >= dwellMs) {
                    const jump = chooseWindow(levels, target, { avoid: idx, rand, minIndex: Math.max(tail, idx + 1) });
                    if (jump !== null) return { type: 'jump', index: jump, half: false, why: 'Finish: later part of this video' };
                    return { type: 'scene', target, half: false, finish: true, why: 'Finish: another video' };
                }
                return null;
            }

            // PMV: the video never jumps. A pulse at the mark ends the script
            // for the rest of the track; the video plays out as a cool-down.
            if (o.mode === 'pmv') {
                if (cooldown) return null;
                if (atMark) { edged = true; cooldown = true; return { type: 'cooldown' }; }
                return halfRules(now, p);
            }

            // Regular: play the video out; handle edges in place.
            if (o.mode === 'full') {
                if (atMark) {
                    if (edged) return null;
                    edged = true;
                    if (ceilingBehaviour === 'stop') { stopped = true; return { type: 'edge-stop' }; }
                    half = true;
                    return { type: 'crawl', index: null };
                }
                if (edged) {
                    if (!released) return null;
                    edged = false;
                    half = true;
                    calmSince = null;
                    if (stopped) { stopped = false; return { type: 'resume' }; }
                    return null;
                }
                return halfRules(now, p);
            }

            // Dynamic from here on.
            if (atMark) {
                if (!edged) {
                    edged = true;
                    if (ceilingBehaviour === 'stop') { stopped = true; return { type: 'edge-stop' }; }
                    half = true;
                    const slowest = chooseWindow(levels, 0, { avoid: idx, rand, maxLevel: 1 });
                    if (slowest !== null) return { type: 'crawl', index: slowest };
                    return { type: 'half', on: true };
                }
                return null;
            }
            if (edged) {
                if (!released) return null;
                edged = false;
                half = true;
                calmSince = null;
                stopped = false;
                if (rand() < o.newSceneOnRelease) return { type: 'scene', target: 1, half: true, edge: true, why: 'Edge over: next clip' };
                const slow = chooseWindow(levels, 1, { avoid: idx, rand, maxLevel: 2 });
                if (slow !== null) return { type: 'jump', index: slow, half: true, why: 'Edge over: a slower part' };
                return { type: 'resume' };
            }
            if (stopped) { stopped = false; return { type: 'resume' }; }

            if (cutNow) {
                cutNow = false;
                const want = aim(p);
                const capped = !finishing && want < Math.max(0, Math.min(5, moodLevel + pace)) && want === targetLevel(p, o.warnAt);
                if (pace < 0 && want === 0 && !half) { half = true; return { type: 'half', on: true, why: 'Slower: half speed' }; }
                if (pace >= 0 && half && p < o.warnAt) { half = false; return { type: 'half', on: false, why: 'Faster: full speed' }; }
                const why = capped ? 'Faster: held back by your pulse' : (pace > 0 ? `Faster (pace +${pace})` : pace < 0 ? `Slower (pace ${pace})` : 'Pace back to normal');
                if (levels[idx] === want) return { type: 'note', why };
                const jump = chooseWindow(levels, want, { avoid: idx, rand });
                if (jump !== null) return { type: 'jump', index: jump, half, why };
                return { type: 'scene', target: want, half, why };
            }

            const halfAction = halfRules(now, p);
            if (halfAction) return halfAction;

            const target = aim(p);

            // Dead spot, or nothing usable left: move on rather than wrap.
            const nextLive = chooseWindow(levels, target, { avoid: idx, rand, minIndex: idx + 1 });
            if (stalled || positionMs >= levels.length * WINDOW_MS - 5000) {
                const why = stalled ? 'Skipping a still spot' : 'Video ending';
                if (nextLive !== null) return { type: 'jump', index: nextLive, half, why };
                return { type: 'scene', target, half, why: why + ': new video' };
            }

            const current = levels[idx];
            const stayed = now - sectionSince;
            // The pulse may force an ease-off early; anything else waits for
            // this clip's stay to run out.
            const tooHot = current > targetLevel(p, o.warnAt) + 1 && stayed >= o.pulseDwellMs;
            if (!tooHot && stayed < dwellMs) return null;
            if (!tooHot && Math.abs(current - target) < 1 && rand() < 0.5) {
                // Stay's up but the clip still fits: sometimes let it ride on.
                sectionSince = now;
                return null;
            }
            const why = tooHot ? 'Easing off for your pulse' : (moodStep.why || 'Next clip');
            if (!tooHot && rand() < o.newSceneOnCut) return { type: 'scene', target, half, why };
            const jump = chooseWindow(levels, target, { avoid: idx, rand });
            if (jump !== null) return { type: 'jump', index: jump, half, why };
            return { type: 'scene', target, half, why };
        }
    };
}

// Fast forward: a later window of the same video with a different feel, no
// hotter than `maxLevel`. Prefers a different tier from the one playing;
// null when nothing later qualifies (the player then changes video).
export function fastForwardWindow(levels, fromIndex, { maxLevel = 5, rand = Math.random, tierOf = (l) => l } = {}) {
    const here = levels[fromIndex];
    const later = [];
    for (let i = fromIndex + 2; i < levels.length; i++) {
        const l = levels[i];
        if (l < 0 || l > maxLevel) continue;
        if (i + 1 < levels.length && levels[i + 1] < 0) continue;
        if (i === levels.length - 1) continue;
        later.push(i);
    }
    if (!later.length) return null;
    const different = later.filter(i => here === undefined || here < 0 || tierOf(levels[i]) !== tierOf(here));
    const pool = different.length ? different : later;
    return pool[Math.floor(rand() * pool.length)];
}

// Panic: how far the pulse must fall, and for how long, before the script
// comes back by itself.
export const PANIC_DROP_BPM = 8;
export const PANIC_HOLD_MS = 10000;
export const PANIC_MIN_MS = 15000;

export function panicCanResume({ hr, panicHr, releaseHr, since, calmSince, now }) {
    if (!Number.isFinite(hr)) return false;
    const low = hr <= Math.min(panicHr - PANIC_DROP_BPM, releaseHr);
    return low && calmSince !== null && now - calmSince >= PANIC_HOLD_MS && now - since >= PANIC_MIN_MS;
}

// Suggested Climax HR after a panic: the pulse you panicked at, less a small
// margin, never under Resting + 15 and only ever lower than today's value.
export function suggestCeilingAfterPanic({ panicHr, minHr, maxHr }) {
    const floor = minHr + 15;
    const target = Math.max(floor, Math.round(panicHr) - 2);
    if (target >= maxHr) return Math.max(floor, maxHr - 3) < maxHr ? Math.max(floor, maxHr - 3) : null;
    return target;
}

// PMV: a whole track whose typical (median live) level is near `target`,
// started at its first live window so a dead intro is skipped.
export function trackLevel(levels) {
    const live = levels.filter(l => l >= 0).sort((a, b) => a - b);
    return live.length ? live[Math.floor(live.length / 2)] : -1;
}

export function firstLiveWindow(levels) {
    const i = levels.findIndex(l => l >= 0);
    return i < 0 ? 0 : i;
}

export function chooseTrack(scenes, { pool, target, recent = [], excludeId = null, rand = Math.random }) {
    const inPool = scenes.filter(s => (pool === 'any' || s.pool === pool) && s.id !== excludeId && trackLevel(s.levelArray) >= 0);
    const fresh = inPool.filter(s => !recent.includes(s.id));
    for (const list of [fresh, inPool]) {
        if (!list.length) continue;
        const best = Math.min(...list.map(s => Math.abs(trackLevel(s.levelArray) - target)));
        const close = list.filter(s => Math.abs(trackLevel(s.levelArray) - target) <= Math.max(1, best));
        let total = close.reduce((sum, s) => sum + (s.weight ?? 1), 0);
        let r = rand() * total;
        for (const s of close) {
            r -= s.weight ?? 1;
            if (r <= 0) return { scene: s, index: firstLiveWindow(s.levelArray) };
        }
        const last = close[close.length - 1];
        return { scene: last, index: firstLiveWindow(last.levelArray) };
    }
    return null;
}
