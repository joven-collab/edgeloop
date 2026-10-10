import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGoals, goalsMet } from './session-goals.js';

const min = 60000;

describe('session goals', () => {
    it('nothing set is a continual session, always open', () => {
        const g = createGoals({});
        assert.equal(g.continual, true);
        assert.equal(goalsMet(g, { elapsedMs: 0, edges: 0 }), true);
    });

    it('a time range hides an end time inside it', () => {
        const g = createGoals({ minMinutes: 20, maxMinutes: 35 }, () => 0.5);
        assert.equal(g.endMs, 27.5 * min);
        assert.equal(goalsMet(g, { elapsedMs: 27 * min, edges: 9 }), false);
        assert.equal(goalsMet(g, { elapsedMs: 28 * min, edges: 0 }), true);
    });

    it('edges alone unlock at the count', () => {
        const g = createGoals({ minEdges: 5 });
        assert.equal(goalsMet(g, { elapsedMs: 1 * min, edges: 4 }), false);
        assert.equal(goalsMet(g, { elapsedMs: 1 * min, edges: 5 }), true);
    });

    it('with both, time leads: early edges wait until close to the time', () => {
        const g = createGoals({ minMinutes: 30, maxMinutes: 30, minEdges: 3 });
        assert.equal(goalsMet(g, { elapsedMs: 10 * min, edges: 3 }), false);
        assert.equal(goalsMet(g, { elapsedMs: 24 * min, edges: 3 }), true);
        assert.equal(goalsMet(g, { elapsedMs: 30 * min, edges: 0 }), true, 'time alone is enough');
    });

    it('tolerates a single or reversed time box', () => {
        assert.equal(createGoals({ minMinutes: 25 }).endMs, 25 * min);
        assert.equal(createGoals({ maxMinutes: 25 }).endMs, 25 * min);
        assert.equal(createGoals({ minMinutes: 30, maxMinutes: 10 }, () => 0.9).endMs, 30 * min);
    });
});
