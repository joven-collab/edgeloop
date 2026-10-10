import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptClock } from './script-clock.js';

function makeClock() {
    let t = 0;
    const clock = new ScriptClock({ now: () => t, tickMs: 60000 });
    const events = [];
    for (const e of ['play', 'playing', 'pause', 'seeking', 'seeked', 'ended']) clock.addEventListener(e, () => events.push(e));
    return { clock, events, advance: (ms) => { t += ms; }, done: () => clock.dispose() };
}

describe('ScriptClock', () => {
    it('keeps media time like a video element', async () => {
        const { clock, advance, done } = makeClock();
        clock.duration = 60;
        clock.src = 'x';
        await new Promise(r => queueMicrotask(r));
        assert.equal(clock.readyState, 4);
        assert.equal(clock.paused, true);
        await clock.play();
        advance(2500);
        assert.equal(clock.currentTime, 2.5);
        clock.pause();
        advance(5000);
        assert.equal(clock.currentTime, 2.5, 'frozen while paused');
        done();
    });

    it('seeks with seeking/seeked and keeps playing from the new spot', async () => {
        const { clock, events, advance, done } = makeClock();
        clock.duration = 60;
        await clock.play();
        clock.currentTime = 30;
        advance(1000);
        assert.equal(clock.currentTime, 31);
        assert.deepEqual(events.slice(-2), ['seeking', 'seeked']);
        done();
    });

    it('ends at the duration', async () => {
        const { clock, events, advance, done } = makeClock();
        clock.duration = 10;
        await clock.play();
        advance(11000);
        clock._tick();
        assert.equal(clock.ended, true);
        assert.equal(clock.paused, true);
        assert.equal(clock.currentTime, 10);
        assert.ok(events.includes('ended'));
        done();
    });
});
