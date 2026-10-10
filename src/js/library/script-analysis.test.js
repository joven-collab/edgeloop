import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    WINDOW_MS,
    analyzeScript,
    cleanActions,
    decodeLevels,
    encodeLevels,
    halfSpeedActions,
    levelForSpeed,
    reversalPoints,
    tierForLevel
} from './script-analysis.js';

// Full strokes 0<->100, one leg every `legMs`, from `from` to `to` ms.
function strokes(from, to, legMs, lo = 0, hi = 100) {
    const out = [];
    let up = false;
    for (let at = from; at <= to; at += legMs) {
        out.push({ at, pos: up ? hi : lo });
        up = !up;
    }
    return out;
}

describe('levels and tiers', () => {
    it('maps speeds onto six levels and three tiers', () => {
        assert.equal(levelForSpeed(0), -1);
        assert.equal(levelForSpeed(NaN), -1);
        assert.equal(levelForSpeed(50), 0);
        assert.equal(levelForSpeed(200), 2);
        assert.equal(levelForSpeed(999), 5);
        assert.deepEqual([-1, 0, 1, 2, 3, 4, 5].map(tierForLevel),
            ['dead', 'slow', 'slow', 'medium', 'medium', 'intense', 'intense']);
    });

    it('round-trips the compact level string', () => {
        const windows = [-1, 0, 5, 3].map(level => ({ level }));
        assert.equal(encodeLevels(windows), 'x053');
        assert.deepEqual(decodeLevels('x053'), [-1, 0, 5, 3]);
    });
});

describe('cleanActions', () => {
    it('drops junk, clamps positions, sorts and dedupes by time', () => {
        const out = cleanActions([{ at: 500, pos: 120 }, { at: 'x', pos: 1 }, { at: 0, pos: -5 }, { at: 500, pos: 40 }]);
        assert.deepEqual(out, [{ at: 0, pos: 0 }, { at: 500, pos: 40 }]);
        assert.deepEqual(cleanActions(null), []);
    });
});

describe('analyzeScript', () => {
    it('grades a fast section, a dead gap and a slow section', () => {
        const fast = strokes(0, WINDOW_MS - 1, 200);              // 500 units/s
        const slow = strokes(2 * WINDOW_MS, 3 * WINDOW_MS - 1, 1000); // 100 units/s
        const r = analyzeScript([...fast, ...slow], 3 * WINDOW_MS);
        assert.deepEqual(r.windows.map(w => w.tier), ['intense', 'dead', 'slow']);
        assert.equal(r.deadPercent, 33);
        assert.deepEqual(r.mix, { slow: 50, medium: 0, intense: 50 });
    });

    it('never throws on empty or garbage input', () => {
        const r = analyzeScript([], 0);
        assert.equal(r.windows.length, 1);
        assert.equal(r.windows[0].tier, 'dead');
        assert.equal(r.firstActionMs, null);
    });
});

describe('halfSpeedActions', () => {
    it('halves the stroke count but keeps the start, end and extremes', () => {
        const src = strokes(0, 8000, 500);
        const half = halfSpeedActions(src);
        const srcTurns = reversalPoints(src).length;
        assert.ok(half.length <= Math.ceil(srcTurns / 2) + 1, `${half.length} vs ${srcTurns}`);
        assert.equal(half[0].at, 0);
        assert.equal(half[half.length - 1].at, 8000);
        for (let i = 1; i < half.length - 1; i++) {
            assert.ok(half[i].pos === 0 || half[i].pos === 100, 'full-range strokes stay full range');
            assert.notEqual(half[i].pos, half[i - 1].pos, 'directions still alternate');
        }
    });

    it('keeps a long pause where it was', () => {
        const src = [...strokes(0, 2000, 250), { at: 2000 + 6000, pos: 0 }, ...strokes(9000, 11000, 250)];
        const half = halfSpeedActions(src);
        assert.ok(!half.some(a => a.at > 2000 && a.at < 8000), 'nothing invented inside the pause');
        assert.ok(half.some(a => a.at >= 9000), 'strokes after the pause survive');
    });
});
