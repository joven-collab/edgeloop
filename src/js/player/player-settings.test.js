import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, byKey, readAll, readField, writeField, exportBackup, importBackup, EDGELOOP_KEY, HANDY_KEY } from './player-settings.js';

function memory(initial = {}) {
    const m = new Map(Object.entries(initial));
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        dump: () => Object.fromEntries(m)
    };
}

describe('player settings', () => {
    it('every field has a tab, a label and a factory value inside its bounds', () => {
        for (const f of FIELDS) {
            assert.ok(f.tab && f.label, f.key);
            if (f.type === 'number') assert.ok(f.def >= f.min && f.def <= f.max, f.key);
        }
    });

    it('reads factory values from an empty browser', () => {
        const all = readAll(memory());
        assert.equal(all.minHr, 70);
        assert.equal(all.player_warn_at, 90);
        assert.equal(all.player_lookahead, true);
        assert.equal(all.player_mic, false);
    });

    it('reads the formats the player already wrote', () => {
        const s = memory({ player_warn_at: '0.85', player_hud: 'off', player_script_offset_ms: '-120', [EDGELOOP_KEY]: JSON.stringify({ minHr: 65, maxHr: 150 }) });
        const all = readAll(s);
        assert.equal(all.player_warn_at, 85);
        assert.equal(all.player_hud, false);
        assert.equal(all.player_script_offset_ms, -120);
        assert.equal(all.maxHr, 150);
    });

    it('clamps writes and keeps the stored format', () => {
        const s = memory();
        assert.equal(writeField(s, byKey.player_warn_at, 150).value, 98);
        assert.equal(s.getItem('player_warn_at'), '0.98');
        writeField(s, byKey.hrStaleSeconds, 99);
        assert.equal(JSON.parse(s.getItem(EDGELOOP_KEY)).hrStaleSeconds, 20);
        writeField(s, byKey.player_normalize, true);
        assert.equal(s.getItem('player_normalize'), 'on');
    });

    it('refuses a Climax HR at or below Resting HR', () => {
        const s = memory({ [EDGELOOP_KEY]: JSON.stringify({ minHr: 70, maxHr: 140 }) });
        const r = writeField(s, byKey.maxHr, 60);
        assert.equal(r.ok, false);
        assert.equal(readField(s, byKey.maxHr), 140);
    });

    it('backs up and restores, leaving the Handy key out unless asked', () => {
        const a = memory({ player_warn_at: '0.8', player_recent: '[1,2]', [HANDY_KEY]: 'k', [EDGELOOP_KEY]: JSON.stringify({ minHr: 60, maxHr: 145 }) });
        const file = JSON.parse(JSON.stringify(exportBackup(a)));
        assert.equal(file.handyKey, undefined);
        const b = memory();
        const r = importBackup(b, file);
        assert.ok(r.ok);
        assert.equal(readField(b, byKey.player_warn_at), 80);
        assert.equal(readField(b, byKey.maxHr), 145);
        assert.equal(b.getItem('player_recent'), '[1,2]');
        assert.equal(b.getItem(HANDY_KEY), null);
        assert.equal(exportBackup(a, { includeHandyKey: true }).handyKey, 'k');
    });

    it('checks every imported value and names what it skipped', () => {
        const b = memory();
        const r = importBackup(b, { app: 'edgeloop-player', edgeloop: { hrStaleSeconds: 999, bogus: 1, minHr: 150, maxHr: 100 }, player: { player_mic_gate: '500', player_other: 'x', player_recent: 'not json' } });
        assert.equal(readField(b, byKey.hrStaleSeconds), 20);
        assert.equal(readField(b, byKey.player_mic_gate), 90);
        assert.equal(readField(b, byKey.maxHr), 140, 'a nonsense pair falls back to the factory one');
        assert.ok(r.skipped.includes('bogus') && r.skipped.includes('player_other') && r.skipped.includes('player_recent'));
        assert.equal(importBackup(b, { foo: 1 }).ok, false);
    });
});
