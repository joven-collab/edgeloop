import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { freshness, feelBpm, ratingHr, isLow, suggestClimaxFromFeel, FEEL } from './feel.js';

const band = { minHr: 60, triggerHr: 120 };

describe('feel ratings', () => {
    it('stay fresh for a minute, then fade out over the next', () => {
        const r = { level: 7, at: 0 };
        assert.equal(freshness(r, 30000), 1);
        assert.equal(freshness(r, 90000), 0.5);
        assert.equal(freshness(r, 130000), 0);
    });

    it('add a little when you feel closer than your pulse shows, capped', () => {
        const extra = feelBpm({ rating: { level: 9, at: 0 }, hr: 70, ...band, now: 1000 });
        assert.equal(extra, FEEL.maxBpm);
        const small = feelBpm({ rating: { level: 6, at: 0 }, hr: 85, ...band, now: 1000 });
        assert.ok(small > 0 && small < FEEL.maxBpm, String(small));
    });

    it('never subtracts: feeling calm does not hide a climbing pulse', () => {
        assert.equal(feelBpm({ rating: { level: 2, at: 0 }, hr: 110, ...band, now: 1000 }), 0);
    });

    it('0 goes past the pullback mark while fresh', () => {
        const extra = feelBpm({ rating: { level: 0, at: 0 }, hr: 80, ...band, now: 1000 });
        assert.equal(80 + extra, ratingHr(0, band));
        assert.ok(80 + extra > band.triggerHr);
    });

    it('a low rating asks for more only while fresh', () => {
        assert.equal(isLow({ level: 2, at: 0 }, 1000), true);
        assert.equal(isLow({ level: 2, at: 0 }, 200000), false);
        assert.equal(isLow({ level: 5, at: 0 }, 1000), false);
    });

    it('suggests a Climax HR from where "close" usually shows', () => {
        const samples = [];
        for (let i = 0; i < 10; i++) samples.push({ level: i % 2 ? 9 : 0, hr: 96 + (i % 3), session: i < 5 ? 'a' : 'b' });
        const s = suggestClimaxFromFeel(samples, { maxHr: 120, minHr: 60 });
        assert.ok(s && s.suggested >= 100 && s.suggested <= 102, JSON.stringify(s));
        assert.equal(suggestClimaxFromFeel(samples.slice(0, 5), { maxHr: 120, minHr: 60 }), null, 'one session is not enough');
        assert.equal(suggestClimaxFromFeel(samples, { maxHr: 101, minHr: 60 }), null, 'already about right');
    });
});
