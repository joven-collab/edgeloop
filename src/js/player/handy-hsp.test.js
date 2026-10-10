import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHandyV3, pointsFrom, CHUNK } from './handy-hsp.js';

// A fake Handy service that records every call.
function fakeService({ connected = true, fwStatus = 0, maxPoints = 250 } = {}) {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        const path = url.replace(/^.*\/v3/, '');
        const body = opts.body ? JSON.parse(opts.body) : null;
        calls.push({ path, method: opts.method || 'GET', body, headers: opts.headers });
        const json = (o) => ({ ok: true, status: 200, json: async () => o });
        if (path === '/servertime') return json({ server_time: 1000000 });
        if (path === '/connected') return json({ result: { connected } });
        if (path === '/info') return json({ result: { fw_status: fwStatus, fw_version: '4.1.0' } });
        if (path === '/hsp/setup') return json({ result: { max_points: maxPoints } });
        if (path === '/hsp/state') return json({ result: { points: maxPoints, current_point: 0 } });
        return json({ result: {} });
    };
    return { calls, fetchImpl };
}

const script = { actions: Array.from({ length: 1000 }, (_, i) => ({ at: i * 100, pos: i % 2 ? 90 : 10 })) };
const noTimer = { setTimer: () => 1, clearTimer: () => {} };

describe('Handy streaming driver', () => {
    it('picks the point at or just before the start', () => {
        const { first, points } = pointsFrom(script.actions, 250);
        assert.equal(first, 2);
        assert.deepEqual(points[0], { t: 200, x: 10 });
    });

    it('connects, checks the firmware and sends both keys', async () => {
        const s = fakeService();
        const h = createHandyV3('devkey', 'appid', { fetchImpl: s.fetchImpl, ...noTimer });
        await h.connect();
        assert.equal(h.maxPoints, 250);
        const setup = s.calls.find(c => c.path === '/hsp/setup');
        assert.equal(setup.headers['X-Api-Key'], 'appid');
        assert.equal(setup.headers['X-Connection-Key'], 'devkey');
    });

    it('refuses old firmware with a clear message', async () => {
        const s = fakeService({ fwStatus: 2 });
        const h = createHandyV3('devkey', 'appid', { fetchImpl: s.fetchImpl, ...noTimer });
        await assert.rejects(h.connect(), /firmware update/);
    });

    it('uploads nothing and plays with the first chunk inside the play call', async () => {
        const s = fakeService();
        const h = createHandyV3('devkey', 'appid', { fetchImpl: s.fetchImpl, ...noTimer });
        await h.connect();
        const token = await h.upload('scene:1:full', script);
        await h.load(token);
        await h.play(5000);
        await h.settled();
        assert.ok(!s.calls.some(c => /upload/.test(c.path)));
        const play = s.calls.find(c => c.path === '/hsp/play');
        assert.equal(play.body.start_time, 5000);
        assert.equal(play.body.add.flush, true);
        assert.equal(play.body.add.points.length, CHUNK);
        assert.equal(play.body.add.points[0].t, 5000);
        const adds = s.calls.filter(c => c.path === '/hsp/add');
        assert.ok(adds.length >= 1, 'buffer filled after play');
        assert.ok(adds.every(a => a.body.flush === false && a.body.points.length <= CHUNK));
    });

    it('a switch is a flush and refill, not an upload', async () => {
        const s = fakeService();
        const h = createHandyV3('devkey', 'appid', { fetchImpl: s.fetchImpl, ...noTimer });
        await h.connect();
        await h.load(await h.upload('a', script));
        await h.play(0);
        await h.load(await h.upload('b', script));
        await h.play(20000);
        const plays = s.calls.filter(c => c.path === '/hsp/play');
        assert.equal(plays.length, 2);
        assert.equal(plays[1].body.add.flush, true);
        assert.equal(plays[1].body.start_time, 20000);
    });
});

describe('Handy streaming refill', () => {
    it('tops up once the device buffer runs low, even after it has wrapped', async () => {
        let refill = null;
        let state = { points: 250, current_point: 10 };
        const s = fakeService();
        const fetchImpl = async (url, opts) => {
            if (url.endsWith('/hsp/state')) return { ok: true, status: 200, json: async () => ({ result: state }) };
            return s.fetchImpl(url, opts);
        };
        const h = createHandyV3('devkey', 'appid', { fetchImpl, setTimer: (fn) => { refill = fn; return 1; }, clearTimer: () => {} });
        await h.connect();
        await h.load(await h.upload('long', script));
        await h.play(0);
        await h.settled();
        const before = s.calls.filter(c => c.path === '/hsp/add').length;
        await refill();
        assert.equal(s.calls.filter(c => c.path === '/hsp/add').length, before, 'plenty queued: no top-up');
        state = { points: 250, current_point: 240 }; // wrapped buffer, nearly played out
        await refill();
        assert.ok(s.calls.filter(c => c.path === '/hsp/add').length > before, 'low: topped up');
    });
});

describe('Handy streaming responsiveness', () => {
    it('play returns once the device runs, before the queue is filled', async () => {
        let release;
        const gate = new Promise(r => { release = r; });
        const s = fakeService({ maxPoints: 100000 });
        const fetchImpl = async (url, opts) => {
            if (url.endsWith('/hsp/add')) await gate;
            return s.fetchImpl(url, opts);
        };
        const h = createHandyV3('devkey', 'appid', { fetchImpl, ...noTimer });
        await h.connect();
        await h.load(await h.upload('big', script));
        await h.play(0);
        assert.equal(s.calls.filter(c => c.path === '/hsp/add').length, 0, 'no fill has completed yet');
        await h.stop();
        release();
        await h.settled();
        const adds = s.calls.filter(c => c.path === '/hsp/add').length;
        assert.ok(adds <= 1, 'filling stops after a stop: ' + adds);
    });
});
