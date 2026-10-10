import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { peakBefore, suggestFromFinishes, heldPeak } from './calibration.js';

describe('calibration', () => {
    it('finds the peak held in the last minute and a half, from both sources', () => {
        const now = 200000;
        const sec = (from, values) => values.map((hr, i) => ({ t: from + i * 1000, hr }));
        const strap = [{ t: 50000, hr: 140 }, ...sec(185000, [104, 108, 110, 111, 110, 109, 98])];
        const beat = sec(185000, [110, 116, 115, 117, 116, 112]);
        assert.deepEqual(peakBefore(strap, beat, now), { strap: 110, beat: 115 });
    });

    it('a single glitchy reading is not a peak', () => {
        const sec = (from, values) => values.map((hr, i) => ({ t: from + i * 1000, hr }));
        assert.equal(heldPeak(sec(0, [100, 101, 160, 102, 101, 100])), 101);
    });

    it('sets Climax HR from the typical finish and the pullback a few BPM under it', () => {
        const s = suggestFromFinishes([{ strap: 108 }, { strap: 112 }, { strap: 130 }], { minHr: 60 });
        assert.equal(s.climax, 112, 'median, so one odd session does not drag it');
        assert.equal(s.pct, 94);
        assert.equal(s.pullbackAt, 105);
        assert.equal(suggestFromFinishes([], { minHr: 60 }), null);
    });
});
