import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LEVELER, nextGainDb } from './audio-leveler.js';

// Run the control for `seconds` against a steady input level.
function settle(startDb, levelDb, seconds) {
    let g = startDb;
    const dt = LEVELER.intervalMs / 1000;
    for (let t = 0; t < seconds; t += dt) g = nextGainDb(g, levelDb, dt);
    return g;
}

describe('volume leveling', () => {
    it('turns a loud passage down to the target, fast', () => {
        const g = settle(0, -6, 0.5);
        assert.equal(Math.round(-6 + g), LEVELER.targetDb, 'loud input lands on target within half a second');
    });

    it('raises a quiet passage, but slowly and within the boost cap', () => {
        assert.ok(settle(0, -38, 0.5) < 4, 'no sudden jump');
        assert.equal(settle(0, -38, 10), LEVELER.maxBoostDb, 'capped at the maximum boost');
        assert.equal(Math.round(-30 + settle(0, -30, 5)), LEVELER.targetDb);
    });

    it('never boosts near-silence', () => {
        assert.equal(settle(3, -70, 5), 3, 'holds the gain it had');
    });

    it('cuts much faster than it rises', () => {
        const dt = LEVELER.intervalMs / 1000;
        const cut = 0 - nextGainDb(0, 0, dt);
        const rise = nextGainDb(0, -40, dt) - 0;
        assert.ok(cut > rise * 5, `${cut} vs ${rise}`);
    });
});
