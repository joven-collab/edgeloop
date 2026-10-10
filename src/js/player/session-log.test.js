import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLog, summarize } from './session-log.js';

describe('session log', () => {
    it('records samples and events against the session clock', () => {
        const log = createSessionLog({ trigger: 105 }, 0);
        for (let s = 0; s < 40; s++) log.sample(s * 1000, { hr: 80 + s, drive: 82 + s, level: 3 });
        log.event(35000, 'edge', 'crawl');
        const j = JSON.parse(JSON.stringify(log.toJSON(40000)));
        assert.equal(j.samples.length, 40);
        assert.equal(j.samples[10][0], 10);
        assert.deepEqual(j.events[0], [35, 'edge', 'crawl']);
        const [e] = summarize(j);
        assert.equal(e.hr, 115);
        assert.equal(e.peak30sBefore, 115);
        assert.equal(e.peak60sAfter, 119, 'pulse kept climbing after the edge');
    });
});
