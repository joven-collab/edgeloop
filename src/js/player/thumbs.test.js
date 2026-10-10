import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cueAt, parseThumbsVtt } from './thumbs.js';

const VTT = `WEBVTT

00:00:00.000 --> 00:00:42.042
abc_sprite.jpg#xywh=0,0,160,90

00:00:42.042 --> 00:01:24.084
abc_sprite.jpg#xywh=160,0,160,90

01:02:03.500 --> 01:02:45.000
abc_sprite.jpg#xywh=320,90,160,90
`;

describe('scrubber thumbs', () => {
    it('parses cues with times and tile boxes', () => {
        const cues = parseThumbsVtt(VTT);
        assert.equal(cues.length, 3);
        assert.deepEqual(cues[1], { start: 42.042, end: 84.084, x: 160, y: 0, w: 160, h: 90 });
        assert.equal(cues[2].start, 3723.5);
    });
    it('finds the tile for a time, clamping at the ends', () => {
        const cues = parseThumbsVtt(VTT);
        assert.equal(cueAt(cues, 10).x, 0);
        assert.equal(cueAt(cues, 50).x, 160);
        assert.equal(cueAt(cues, 99999).x, 320);
        assert.equal(cueAt([], 5), null);
        assert.deepEqual(parseThumbsVtt(null), []);
    });
});
