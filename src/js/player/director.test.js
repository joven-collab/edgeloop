import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WINDOW_MS } from '../library/script-analysis.js';
import { bandProgress, chooseScene, chooseWindow, createDirector, targetLevel } from './director.js';

const fixed = (v) => () => v;
const base = { minHr: 70, triggerHr: 130, released: false, ceilingBehaviour: 'crawl', rand: fixed(0.99) };

describe('ladder maths', () => {
    it('maps the band onto a falling target level', () => {
        assert.equal(bandProgress(70, 70, 130), 0);
        assert.equal(bandProgress(200, 70, 130), 1);
        assert.equal(targetLevel(0), 5);
        assert.equal(targetLevel(0.45), 3);
        assert.equal(targetLevel(0.9), 0);
    });
});

describe('chooseWindow', () => {
    it('picks the closest live level away from the current window', () => {
        const levels = [5, 5, 1, 1, 3, -1, 0, 0];
        assert.equal(chooseWindow(levels, 0, { avoid: 0, rand: fixed(0) }), 6);
        assert.equal(chooseWindow(levels, 5, { avoid: 3, rand: fixed(0) }), 0);
    });

    it('never starts right before a dead window and refuses a poor match', () => {
        const levels = [3, 3, 4, -1];
        assert.notEqual(chooseWindow(levels, 4, { rand: fixed(0) }), 2);
        assert.equal(chooseWindow([5, 5, 5], 0, { rand: fixed(0) }), null);
    });

    it('respects a level cap', () => {
        assert.equal(chooseWindow([5, 5, 2, 2], 3, { maxLevel: 2, rand: fixed(0) }), 2);
    });
});

describe('chooseScene', () => {
    const scenes = [
        { id: 'a', pool: 'regular', levelArray: [5, 5, 5] },
        { id: 'b', pool: 'regular', levelArray: [0, 0, 1] },
        { id: 'c', pool: 'pmv', levelArray: [0, 0, 0] }
    ];
    it('stays in the pool and finds a scene with the target', () => {
        const r = chooseScene(scenes, { pool: 'regular', target: 0, rand: fixed(0) });
        assert.equal(r.scene.id, 'b');
    });
    it('falls back to recent scenes rather than nothing', () => {
        const r = chooseScene(scenes, { pool: 'regular', target: 0, recent: ['b'], rand: fixed(0) });
        assert.equal(r.scene.id, 'b');
    });
});

describe('createDirector', () => {
    const levels = [5, 5, 5, 3, 3, 1, 1, 0, 0, 5, 5, 5];

    it('crawls to a slow section at half speed on an edge, then waits for release', () => {
        const d = createDirector();
        d.moved(0);
        const a = d.tick({ ...base, now: 1000, hr: 135, levels, positionMs: 0 });
        assert.equal(a.type, 'crawl');
        assert.ok(levels[a.index] <= 1);
        assert.equal(d.half, true);
        assert.equal(d.tick({ ...base, now: 2000, hr: 128, levels, positionMs: 0 }), null, 'held until released');
        const r = d.tick({ ...base, now: 3000, hr: 120, released: true, levels, positionMs: 0 });
        assert.ok(['jump', 'scene'].includes(r.type));
        assert.equal(r.half, true);
    });

    it('Full Stop stops the script and resumes after release', () => {
        const d = createDirector({ newSceneOnRelease: 0 });
        d.moved(0);
        assert.equal(d.tick({ ...base, ceilingBehaviour: 'stop', now: 1000, hr: 131, levels, positionMs: 0 }).type, 'edge-stop');
        const r = d.tick({ ...base, ceilingBehaviour: 'stop', now: 2000, hr: 120, released: true, levels, positionMs: 0 });
        assert.equal(r.type, 'jump');
    });

    it('turns half speed on at the warning line and off after a calm spell', () => {
        const d = createDirector();
        d.moved(0);
        assert.deepEqual(d.tick({ ...base, now: 1000, hr: 125, levels, positionMs: 0 }), { type: 'half', on: true });
        assert.equal(d.tick({ ...base, now: 2000, hr: 80, levels, positionMs: 0 }), null);
        assert.deepEqual(d.tick({ ...base, now: 2000 + 45000, hr: 80, levels, positionMs: 0 }), { type: 'half', on: false });
    });

    it('waits out the dwell time, then jumps toward the target', () => {
        const d = createDirector();
        d.moved(0);
        assert.equal(d.tick({ ...base, now: 10000, hr: 110, levels, positionMs: 0 }), null, 'dwell not over');
        const a = d.tick({ ...base, now: 31000, hr: 110, levels, positionMs: 0 });
        assert.equal(a.type, 'jump');
        assert.ok(levels[a.index] <= 2, `level ${levels[a.index]}`);
    });

    it('gives a dead spot a grace period, then leaves; moves to a new scene at the end', () => {
        const d = createDirector();
        d.moved(0);
        const withDead = [3, -1, 3, 3, 3];
        const at = { ...base, now: 1000, hr: 90, levels: withDead, positionMs: WINDOW_MS + 1000 };
        assert.equal(d.tick({ ...at, idleMs: 2500, nextActionInMs: 20000 }), null, 'still inside the grace period');
        assert.equal(d.tick({ ...at, idleMs: 6000, nextActionInMs: 800 }), null, 'a stroke is about to start');
        const a = d.tick({ ...at, idleMs: 4200, nextActionInMs: 20000 });
        assert.equal(a.type, 'jump');
        const end = d.tick({ ...base, now: 1000, hr: 90, levels: [3, 3], positionMs: 2 * WINDOW_MS - 1000 });
        assert.equal(end.type, 'scene');
    });
});

import { fastForwardWindow, panicCanResume, suggestCeilingAfterPanic } from './director.js';
import { tierForLevel } from '../library/script-analysis.js';

describe('fastForwardWindow', () => {
    const levels = [5, 5, 5, 1, 1, 5, 3, 3];
    it('moves later, to a different tier when it can', () => {
        const i = fastForwardWindow(levels, 0, { rand: () => 0, tierOf: tierForLevel });
        assert.ok(i >= 2);
        assert.notEqual(tierForLevel(levels[i]), 'intense');
    });
    it('honours the heart-rate cap and gives up at the end', () => {
        const i = fastForwardWindow(levels, 0, { maxLevel: 1, rand: () => 0.99, tierOf: tierForLevel });
        assert.ok(levels[i] <= 1);
        assert.equal(fastForwardWindow(levels, 6, { tierOf: tierForLevel }), null);
    });
});

describe('panic', () => {
    it('resumes only after a real drop, held, and a minimum pause', () => {
        const base = { panicHr: 120, releaseHr: 130, since: 0 };
        assert.equal(panicCanResume({ ...base, hr: 115, calmSince: 0, now: 30000 }), false, 'not down 8 BPM');
        assert.equal(panicCanResume({ ...base, hr: 110, calmSince: 25000, now: 30000 }), false, 'not held 10 s');
        assert.equal(panicCanResume({ ...base, hr: 110, calmSince: 0, now: 12000 }), false, 'under 15 s');
        assert.equal(panicCanResume({ ...base, hr: 110, calmSince: 5000, now: 20000 }), true);
    });
    it('suggests a lower ceiling, never below resting + 15', () => {
        assert.equal(suggestCeilingAfterPanic({ panicHr: 118, minHr: 70, maxHr: 140 }), 116);
        assert.equal(suggestCeilingAfterPanic({ panicHr: 150, minHr: 70, maxHr: 140 }), 137);
        assert.equal(suggestCeilingAfterPanic({ panicHr: 80, minHr: 70, maxHr: 140 }), 85);
        assert.equal(suggestCeilingAfterPanic({ panicHr: 150, minHr: 70, maxHr: 85 }), null);
    });
});

import { chooseTrack, trackLevel } from './director.js';

describe('PMV mode', () => {
    const long = Array(40).fill(3);            // 10 min track
    const pmv = { ...base, now: 100000, hr: 80 };

    it('never jumps: still spots and long tracks just play on', () => {
        const d = createDirector({ mode: 'pmv' });
        d.moved(0);
        assert.equal(d.tick({ ...pmv, levels: [3, -1, 3, 3, 3], positionMs: WINDOW_MS + 1000, idleMs: 9000, nextActionInMs: 20000 }), null);
        assert.equal(d.tick({ ...pmv, hr: 70, levels: Array(40).fill(1), positionMs: 20 * WINDOW_MS, idleMs: 3000 }), null);
    });

    it('cools down for the rest of the track at the edge, whatever the ceiling setting', () => {
        for (const ceilingBehaviour of ['crawl', 'stop']) {
            const d = createDirector({ mode: 'pmv' });
            d.moved(0);
            assert.deepEqual(d.tick({ ...pmv, ceilingBehaviour, hr: 135, levels: long, positionMs: 1000 }), { type: 'cooldown' });
            assert.equal(d.tick({ ...pmv, ceilingBehaviour, hr: 100, released: true, levels: long, positionMs: 5000 }), null, 'no resume mid-track');
            assert.equal(d.cooldown, true);
        }
    });

    it('a new track ends the cool-down', () => {
        const d = createDirector({ mode: 'pmv' });
        d.moved(0);
        d.tick({ ...pmv, hr: 135, levels: long, positionMs: 1000 });
        d.moved(5000, { newScene: true });
        assert.equal(d.cooldown, false);
        assert.deepEqual(d.tick({ ...pmv, hr: 135, levels: long, positionMs: 1000 }), { type: 'cooldown' }, 'still high: cools down again');
    });

    it('still switches to half speed at the warning line', () => {
        const d = createDirector({ mode: 'pmv' });
        d.moved(0);
        assert.deepEqual(d.tick({ ...pmv, hr: 125, levels: long, positionMs: 1000 }), { type: 'half', on: true });
    });

    it('picks tracks by their typical level and starts after a dead intro', () => {
        assert.equal(trackLevel([-1, 1, 5, 5]), 5);
        const scenes = [
            { id: 'calm', pool: 'pmv', levelArray: [-1, -1, 1, 1, 1] },
            { id: 'hot', pool: 'pmv', levelArray: [5, 5, 5] }
        ];
        const r = chooseTrack(scenes, { pool: 'pmv', target: 1, rand: () => 0 });
        assert.equal(r.scene.id, 'calm');
        assert.equal(r.index, 2);
    });
});

import { advanceMood, createMood } from './director.js';

describe('mood', () => {
    it('a low pulse caps nothing, so the mood decides (no automatic max intensity)', () => {
        const d = createDirector();
        assert.equal(d.target(0), 2, 'resting pulse aims at the mood, not at 5');
        assert.equal(d.target(0.8), 1, 'the pulse still caps it near the edge');
    });

    it('holds, then drifts one step at a time within its range', () => {
        const mood = createMood({}, 0, () => 0);
        assert.equal(advanceMood(mood, { now: 1000, p: 0.5, rand: () => 0.99 }).changed, false, 'holds before its time');
        const up = advanceMood(mood, { now: 300000, p: 0.5, rand: () => 0.2 });
        assert.equal(up.level, 3);
        const down = advanceMood(mood, { now: 600000, p: 0.5, rand: () => 0.5 });
        assert.equal(down.level, 2);
    });

    it('builds up to intense for a while, then settles back', () => {
        const mood = createMood({}, 0, () => 0);
        assert.equal(advanceMood(mood, { now: 300000, p: 0.5, rand: () => 0.05 }).level, 5);
        const after = advanceMood(mood, { now: 300000 + 80000, p: 0.5, rand: () => 0.99 });
        assert.equal(after.level, 2);
        assert.match(after.why, /settling/);
    });

    it('leans up when the pulse stays low for a long time', () => {
        const mood = createMood({}, 0, () => 0.99);
        mood.nextAt = Infinity;
        advanceMood(mood, { now: 0, p: 0.1 });
        assert.equal(advanceMood(mood, { now: 100000, p: 0.1 }).level, 2);
        const lean = advanceMood(mood, { now: 181000, p: 0.1 });
        assert.equal(lean.level, 3);
        assert.match(lean.why, /leaning up/);
    });
});

describe('Regular (full play) mode', () => {
    const long = Array(40).fill(3);
    const reg = { ...base, now: 500000, hr: 80 };

    it('never jumps, even on still spots, stale clips or a low pulse', () => {
        const d = createDirector({ mode: 'full' });
        d.moved(0);
        assert.equal(d.tick({ ...reg, levels: [3, -1, 3, 3], positionMs: WINDOW_MS + 1000, idleMs: 9000, nextActionInMs: 20000 }), null);
        assert.equal(d.tick({ ...reg, hr: 70, levels: long, positionMs: 5000 }), null);
    });

    it('crawls in place at the edge and releases without jumping', () => {
        const d = createDirector({ mode: 'full' });
        d.moved(0);
        assert.deepEqual(d.tick({ ...reg, hr: 135, levels: long, positionMs: 1000 }), { type: 'crawl', index: null });
        assert.equal(d.tick({ ...reg, hr: 120, released: true, levels: long, positionMs: 3000 }), null);
    });

    it('Full Stop stops the script, then resumes in place', () => {
        const d = createDirector({ mode: 'full' });
        d.moved(0);
        assert.equal(d.tick({ ...reg, ceilingBehaviour: 'stop', hr: 135, levels: long, positionMs: 1000 }).type, 'edge-stop');
        assert.equal(d.tick({ ...reg, ceilingBehaviour: 'stop', hr: 120, released: true, levels: long, positionMs: 3000 }).type, 'resume');
    });
});

describe('Dynamic stays', () => {
    const levels = [3, 3, 3, 3, 1, 1, 5, 5, 3, 3, 3, 3];
    it('holds a clip for its weighted stay unless the pulse forces an ease-off', () => {
        const d = createDirector({ rand: () => 0.99 });
        d.moved(0, { dwell: 100000 });
        assert.equal(d.tick({ ...base, now: 60000, hr: 90, levels, positionMs: 1000, rand: () => 0.99 }), null, 'stay not over');
        const forced = d.tick({ ...base, now: 30000, hr: 125, levels: [5, 5, 5, 1, 1, 1, 1], positionMs: 1000, rand: () => 0.99 });
        assert.ok(forced, 'pulse forces a change');
    });
});

describe('finish mode', () => {
    it('drops half speed and ignores the ceiling', () => {
        const d = createDirector();
        d.moved(0);
        d.setHalf(true);
        d.finish();
        assert.deepEqual(d.tick({ ...base, now: 1000, hr: 150, levels: Array(20).fill(3), positionMs: 1000 }), { type: 'half', on: false });
        assert.equal(d.tick({ ...base, now: 2000, hr: 150, levels: Array(20).fill(3), positionMs: 1000 }), null, 'no pullback');
    });

    it('in Dynamic, moves to the later part of a video when a clip ends', () => {
        const d = createDirector();
        d.moved(0, { dwell: 50000 });
        d.finish();
        const a = d.tick({ ...base, now: 60000, hr: 90, levels: Array(20).fill(4), positionMs: 1000, rand: () => 0 });
        assert.equal(a.type, 'jump');
        assert.ok(a.index >= 14, `window ${a.index}`);
    });
});

describe('any pool (Script only)', () => {
    it('picks from every pool', () => {
        const scenes = [{ id: 'r', pool: 'regular', levelArray: [3, 3, 3] }, { id: 'p', pool: 'pmv', levelArray: [3, 3, 3] }];
        const seen = new Set();
        for (const seq of [[0.1, 0.9], [0.9, 0.1]]) { let i = 0; seen.add(chooseScene(scenes, { pool: 'any', target: 3, rand: () => seq[i++ % 2] }).scene.id); }
        assert.equal(seen.size, 2);
    });
});

describe('pace (Faster / Slower)', () => {
    const levels = [2, 2, 2, 2, 5, 5, 5, 0, 0, 0, 3, 3];
    const calm = { ...base, now: 1000, hr: 72, levels, positionMs: 1000, rand: () => 0 };

    it('Faster cuts straight to a hotter section', () => {
        const d = createDirector();
        d.moved(0);
        assert.equal(d.nudge(1), 1);
        d.nudge(1); d.nudge(1);
        const a = d.tick(calm);
        assert.equal(a.type, 'jump');
        assert.equal(levels[a.index], 5);
        assert.match(a.why, /Faster/);
    });

    it('Faster is still capped by the pulse', () => {
        const d = createDirector();
        d.moved(0);
        d.nudge(3);
        const a = d.tick({ ...calm, hr: 118 });
        assert.ok(a.why.includes('held back') || levels[a.index] <= 1, JSON.stringify(a));
    });

    it('Slower at the bottom turns on half speed; pace stays within +-3', () => {
        const d = createDirector();
        d.moved(0);
        for (let i = 0; i < 6; i++) d.nudge(-1);
        assert.equal(d.pace, -3);
        assert.deepEqual(d.tick(calm), { type: 'half', on: true, why: 'Slower: half speed' });
    });
});
