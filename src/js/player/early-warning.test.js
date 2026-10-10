import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hrSlope, lookaheadBpm, micEnvelope, driveHr, EARLY } from './early-warning.js';

const trail = (from, perSecond, seconds, now = 100000) =>
    Array.from({ length: seconds + 1 }, (_, i) => ({ t: now - (seconds - i) * 1000, hr: from + perSecond * i }));

describe('early warning', () => {
    it('measures the climb in BPM per second', () => {
        assert.equal(Math.round(hrSlope(trail(120, 1, 10), 100000) * 10) / 10, 1);
        assert.equal(hrSlope(trail(120, 1, 2), 100000), null, 'too little history');
    });

    it('projects a fast climb high in the band', () => {
        const extra = lookaheadBpm({ trail: trail(130, 1, 10), now: 100000, hr: 140, minHr: 70, triggerHr: 150 });
        assert.equal(extra, EARLY.lookaheadS);
    });

    it('ignores steady, falling or low-band pulses', () => {
        const base = { now: 100000, minHr: 70, triggerHr: 150 };
        assert.equal(lookaheadBpm({ ...base, trail: trail(140, 0, 10), hr: 140 }), 0, 'steady');
        assert.equal(lookaheadBpm({ ...base, trail: trail(145, -1, 10), hr: 135 }), 0, 'falling');
        assert.equal(lookaheadBpm({ ...base, trail: trail(80, 1, 10), hr: 90 }), 0, 'low in the band');
    });

    it('caps a wild jump', () => {
        const extra = lookaheadBpm({ trail: trail(100, 5, 10), now: 100000, hr: 150, minHr: 70, triggerHr: 160 });
        assert.equal(extra, EARLY.maxLookaheadBpm);
    });

    it('a single loud moment barely counts, sustained loudness does', () => {
        let env = 0;
        env = micEnvelope(env, 100, 0.2);
        assert.ok(env < 20, `one cough: ${env}`);
        for (let i = 0; i < 20; i++) env = micEnvelope(env, 100, 0.2);
        assert.ok(env > 90, `four seconds of panting: ${env}`);
        const after = micEnvelope(env, 0, 1);
        assert.ok(after > 70, 'lets go slowly');
    });

    it('drive rate only ever adds', () => {
        assert.equal(driveHr({ hr: 140, lookahead: 4, mic: 3 }), 147);
        assert.equal(driveHr({ hr: 140, lookahead: -4, mic: -3 }), 140);
        assert.equal(driveHr({ hr: null, lookahead: 4 }), null);
    });
});

import { instantHr, rmssd, hrvBaseline, hrvBpm } from './early-warning.js';

describe('beat-to-beat signals', () => {
    const beats = (rrs, end = 20000) => { let t = end; const out = []; for (let k = rrs.length - 1; k >= 0; k--) { out.unshift({ t, rr: rrs[k] }); t -= rrs[k]; } return out; };

    it('instant rate follows the last few beats, ahead of an averaged BPM', () => {
        const b = beats([1000, 1000, 1000, 1000, 550, 540, 530]);
        assert.equal(instantHr(b, 20000), 111);
    });

    it('variability collapse near the top of the band adds BPM', () => {
        const calm = beats([900, 960, 880, 970, 890, 960, 900, 950]);
        const tight = beats([560, 562, 559, 561, 560, 562, 561, 560]);
        const base = rmssd(calm, 20000);
        const now = rmssd(tight, 20000);
        assert.ok(base > 50 && now < 5, `${base} ${now}`);
        assert.equal(hrvBpm({ current: now, baseline: base, hr: 100, minHr: 60, triggerHr: 110 }), 10);
        assert.equal(hrvBpm({ current: now, baseline: base, hr: 70, minHr: 60, triggerHr: 110 }), 0, 'not low in the band');
        assert.equal(hrvBaseline([10, 20, 30]), null, 'baseline needs a few readings');
    });
});
