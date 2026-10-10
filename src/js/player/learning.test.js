import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adjustLevels, applyEvents, emptyLearning, makeVisit, sceneWeight, suggestEarlierWarning } from './learning.js';

describe('makeVisit', () => {
    const base = { sceneId: '7', index: 3, level: 2, startHr: 90, endHr: 96, startAt: 0, endAt: 30000 };
    it('turns a stay into a BPM-per-minute slope', () => {
        assert.equal(makeVisit(base).slope, 12);
    });
    it('ignores short, half-speed, edged or dead stays', () => {
        assert.equal(makeVisit({ ...base, endAt: 5000 }), null);
        assert.equal(makeVisit({ ...base, half: true }), null);
        assert.equal(makeVisit({ ...base, edged: true }), null);
        assert.equal(makeVisit({ ...base, level: -1 }), null);
    });
});

describe('applyEvents and adjustLevels', () => {
    it('makes a window that heats up more than usual count one level hotter', () => {
        const d = applyEvents(emptyLearning(), [
            { type: 'visit', sceneId: 'a', index: 0, level: 2, slope: 20 },
            { type: 'visit', sceneId: 'a', index: 0, level: 2, slope: 20 },
            { type: 'visit', sceneId: 'b', index: 5, level: 2, slope: 0 },
            { type: 'visit', sceneId: 'b', index: 5, level: 2, slope: 0 }
        ]);
        assert.deepEqual(adjustLevels([2, 2], d.scenes.a, d.levels), [3, 2]);
        assert.deepEqual(adjustLevels([-1, 2, 2, 2, 2, 2], d.scenes.b, d.levels), [-1, 2, 2, 2, 2, 1]);
    });

    it('treats a panic window as hotter and leaves unknown windows alone', () => {
        const d = applyEvents(emptyLearning(), [{ type: 'panic', sceneId: 'c', index: 1 }]);
        assert.deepEqual(adjustLevels([4, 4, 5], d.scenes.c, d.levels), [4, 5, 5]);
        assert.deepEqual(adjustLevels([4], undefined, {}), [4]);
    });

    it('survives garbage input', () => {
        const d = applyEvents(null, [null, { type: 'visit' }, { type: 'play', sceneId: 9 }]);
        assert.equal(d.scenes['9'].plays, 1);
    });
});

describe('sceneWeight', () => {
    it('drops with skips, recovers with plays, never hits zero', () => {
        assert.equal(sceneWeight(undefined), 1);
        assert.ok(sceneWeight({ skips: 2, plays: 0 }) < sceneWeight({ skips: 1, plays: 0 }));
        assert.equal(sceneWeight({ skips: 2, plays: 4 }), 1);
        assert.equal(sceneWeight({ skips: 50, plays: 0 }), 0.15);
    });
});

describe('suggestEarlierWarning', () => {
    const fast = { risingBpmPer10s: 12 };
    const slow = { risingBpmPer10s: 2 };
    it('needs several panics, mostly on a fast climb', () => {
        assert.equal(suggestEarlierWarning([fast, fast], 0.9), null);
        assert.equal(suggestEarlierWarning([fast, slow, slow], 0.9), null);
        assert.equal(suggestEarlierWarning([fast, fast, slow], 0.9), 0.85);
        assert.equal(suggestEarlierWarning([fast, fast, fast], 0.7), null);
    });
});

import { chooseDwellMs, dwellWeights, DWELL_BANDS } from './learning.js';

describe('dwell chances', () => {
    it('always stays at least 45 s and at most 3 min', () => {
        for (const r of [0, 0.3, 0.6, 0.99]) {
            const ms = chooseDwellMs({}, () => r);
            assert.ok(ms >= 45000 && ms <= 180000, String(ms));
        }
    });
    it('leans short for skipped scenes and long for clips that work', () => {
        const base = dwellWeights({});
        const skipped = dwellWeights({ sceneStats: { skips: 4, plays: 0 } });
        assert.ok(skipped[0] > base[0] && skipped[2] < base[2]);
        const d = applyEvents(emptyLearning(), [
            { type: 'visit', sceneId: 'w', index: 2, level: 3, slope: 15 },
            { type: 'visit', sceneId: 'w', index: 2, level: 3, slope: 15 },
            { type: 'visit', sceneId: 'z', index: 0, level: 3, slope: 0 },
            { type: 'visit', sceneId: 'z', index: 0, level: 3, slope: 0 }
        ]);
        const working = dwellWeights({ sceneStats: d.scenes.w, windowIndex: 2, level: 3, levelStats: d.levels });
        assert.ok(working[2] > base[2]);
        assert.equal(DWELL_BANDS.length, 3);
    });
});
