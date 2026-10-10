// Every player setting in one list: which tab it sits on, how it is stored,
// its bounds and its factory value. The settings panel is drawn from this
// list, every write is clamped by it, and backup / restore go through it, so
// a value typed, restored or imported always passes the same check.
//
// Two stores: 'el' is EdgeLoop's own settings object (shared with the setup
// page, checked by its schema), 'ls' is a plain localStorage key of ours.

import { SETTING_SANITIZERS } from '../settings-schema.js';
import { sanitizeHrLimits } from '../session-rules.js';

export const EDGELOOP_KEY = 'edgeloop_advanced_settings';
export const HANDY_KEY = 'handy_connection_key';

export const TABS = [
    { id: 'hr', label: 'Heart rate' },
    { id: 'early', label: 'Catching edges' },
    { id: 'play', label: 'Playback' },
    { id: 'handy', label: 'Handy' },
    { id: 'backup', label: 'Backup' }
];

export const FIELDS = [
    { key: 'minHr', store: 'el', tab: 'hr', type: 'number', label: 'Resting HR', unit: 'BPM', min: 30, max: 250, def: 70 },
    { key: 'maxHr', store: 'el', tab: 'hr', type: 'number', label: 'Climax HR', unit: 'BPM', min: 30, max: 250, def: 140 },
    { key: 'edgeHoldPercent', store: 'el', tab: 'hr', type: 'number', label: 'Pullback at', unit: '% of Climax HR', min: 90, max: 100, def: 100 },
    { key: 'ceilingBehaviour', store: 'el', tab: 'hr', type: 'select', label: 'At the pullback', def: 'crawl',
        options: [['crawl', 'Crawl (slow part, half speed)'], ['stop', 'Full Stop (script off, video plays)']] },
    { key: 'player_warn_at', store: 'ls', tab: 'hr', type: 'number', label: 'Half speed from', unit: '% of the way to the pullback', min: 60, max: 98, def: 90, scale: 100 },
    { key: 'hrStaleSeconds', store: 'el', tab: 'hr', type: 'number', label: 'No signal: stop after', unit: 's', min: 3, max: 20, def: 8 },
    { key: 'hrAutoResume', store: 'el', tab: 'hr', type: 'bool', label: 'Resume by itself when the signal returns', def: true },
    { key: 'adaptiveDecay', store: 'el', tab: 'hr', type: 'bool', label: 'Lower the ceiling as edges add up', def: true },
    { key: 'decayEdgeCount', store: 'el', tab: 'hr', type: 'number', label: 'Every', unit: 'edges', min: 1, max: 10, def: 2, sub: 'adaptiveDecay' },
    { key: 'decayBpm', store: 'el', tab: 'hr', type: 'number', label: 'Lower by', unit: 'BPM', min: 1, max: 5, def: 2, sub: 'adaptiveDecay' },
    { key: 'decayFloor', store: 'el', tab: 'hr', type: 'number', label: 'Never below', unit: 'BPM', min: 80, max: 130, def: 105, sub: 'adaptiveDecay' },

    { key: 'player_lookahead', store: 'ls', tab: 'early', type: 'bool', label: 'Lookahead: a fast climb counts early', def: true },
    { key: 'player_lookahead_s', store: 'ls', tab: 'early', type: 'number', label: 'Look ahead', unit: 's', min: 3, max: 15, def: 8, sub: 'player_lookahead' },
    { key: 'player_lookahead_max', store: 'ls', tab: 'early', type: 'number', label: 'At most', unit: 'BPM extra', min: 4, max: 20, def: 12, sub: 'player_lookahead' },
    { key: 'player_mic', store: 'ls', tab: 'early', type: 'bool', label: 'Mic: loud breathing or voice counts', def: false },
    { key: 'player_mic_gate', store: 'ls', tab: 'early', type: 'number', label: 'Mic gate', unit: '(meter on the start screen)', min: 8, max: 90, def: 40, sub: 'player_mic' },
    { key: 'player_mic_boost', store: 'ls', tab: 'early', type: 'number', label: 'Mic strength', unit: 'BPM at most', min: 0, max: 20, def: 10, sub: 'player_mic' },

    { key: 'player_normalize', store: 'ls', tab: 'play', type: 'bool', label: 'Normalize volume', def: false },
    { key: 'player_norm_target', store: 'ls', tab: 'play', type: 'number', label: 'Normalize loudness', unit: 'dB (lower = quieter overall)', min: -32, max: -14, def: -23, sub: 'player_normalize' },
    { key: 'player_dead_grace_s', store: 'ls', tab: 'play', type: 'number', label: 'Dead spot: move on after', unit: 's of stillness', min: 2, max: 15, def: 4 },
    { key: 'player_half_off_s', store: 'ls', tab: 'play', type: 'number', label: 'Half speed ends after', unit: 's calm', min: 15, max: 180, def: 45 },
    { key: 'player_new_clip_pct', store: 'ls', tab: 'play', type: 'number', label: 'Dynamic: new clip after an edge', unit: '% of the time', min: 0, max: 100, def: 70 },
    { key: 'player_script_offset_ms', store: 'ls', tab: 'play', type: 'number', label: 'Script offset', unit: 'ms ([ and ] while playing)', min: -1000, max: 1000, step: 10, def: 0 },
    { key: 'player_hud', store: 'ls', tab: 'play', type: 'bool', label: 'Status line', def: true },

    { key: HANDY_KEY, store: 'raw', tab: 'handy', type: 'secret', label: 'Connection key', def: '' },
    { key: 'player_handy_mode', store: 'ls', tab: 'handy', type: 'select', label: 'Wi-Fi mode', def: 'stream',
        options: [['stream', 'Newer: instant switching (firmware 4)'], ['classic', 'Classic: script upload']] },
    { key: 'handy_app_id', store: 'raw', tab: 'handy', type: 'secret', label: 'Application ID', def: '', placeholder: 'or put it in a .handy-app-id file' }
];

export const byKey = Object.fromEntries(FIELDS.map(f => [f.key, f]));

function readEl(storage) {
    try { const o = JSON.parse(storage.getItem(EDGELOOP_KEY) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

// Clamp a value to what the field allows. Returns the value to store (in
// display units), or the factory value when it cannot be read.
export function clampField(f, value) {
    if (f.type === 'bool') return value === true || value === 'true' || value === 'on' ? true : value === false || value === 'false' || value === 'off' ? false : f.def;
    if (f.type === 'select') return f.options.some(([v]) => v === value) ? value : f.def;
    if (f.type === 'secret') return typeof value === 'string' ? value.trim().slice(0, 200) : f.def;
    const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
    if (!Number.isFinite(n)) return f.def;
    const step = f.step || 1;
    return Math.max(f.min, Math.min(f.max, Math.round(n / step) * step));
}

export function readField(storage, f) {
    if (f.store === 'el') {
        const v = readEl(storage)[f.key];
        return v === undefined ? f.def : clampField(f, v);
    }
    const raw = storage.getItem(f.key);
    if (raw === null || raw === '') return f.def;
    if (f.type === 'secret') return raw;
    if (f.type === 'bool') return clampField(f, raw);
    return clampField(f, f.scale ? Number(raw) * f.scale : raw);
}

export function readAll(storage) {
    return Object.fromEntries(FIELDS.map(f => [f.key, readField(storage, f)]));
}

// Write one field. The HR pair is checked together: a pair that would not
// make sense is refused with a reason, and nothing is written.
export function writeField(storage, f, value) {
    const v = clampField(f, value);
    if (f.store === 'el') {
        const el = readEl(storage);
        if (f.key === 'minHr' || f.key === 'maxHr') {
            const next = { minHr: el.minHr ?? 70, maxHr: el.maxHr ?? 140, [f.key]: v };
            const check = sanitizeHrLimits(next.minHr, next.maxHr);
            if (!check.valid) return { ok: false, value: readField(storage, f), error: 'Climax HR must be above Resting HR.' };
        }
        const sanitize = SETTING_SANITIZERS[f.key];
        el[f.key] = sanitize && f.key !== 'minHr' && f.key !== 'maxHr' ? sanitize(v) : v;
        storage.setItem(EDGELOOP_KEY, JSON.stringify(el));
        return { ok: true, value: el[f.key] };
    }
    if (f.type === 'secret') { if (v) storage.setItem(f.key, v); else storage.removeItem(f.key); return { ok: true, value: v }; }
    if (f.type === 'bool') storage.setItem(f.key, v ? 'on' : 'off');
    else storage.setItem(f.key, String(f.scale ? v / f.scale : v));
    return { ok: true, value: v };
}

// ---- backup ------------------------------------------------------------------

// Plain player keys that are not in the panel but are still worth keeping:
// goals, warm-up, the recent list (so a restore does not replay old videos)
// and the panic log the earlier-warning suggestion learns from.
const EXTRA_KEYS = ['player_goals', 'player_warmup', 'player_recent', 'player_panics', 'player_warn_dismissed_count'];
const JSON_KEYS = new Set(['player_goals', 'player_recent', 'player_panics']);

export function exportBackup(storage, { includeHandyKey = false, now = new Date() } = {}) {
    const player = {};
    for (const f of FIELDS) if (f.store === 'ls' && storage.getItem(f.key) !== null) player[f.key] = storage.getItem(f.key);
    for (const k of EXTRA_KEYS) if (storage.getItem(k) !== null) player[k] = storage.getItem(k);
    const out = { app: 'edgeloop-player', version: 1, exportedAt: now.toISOString(), edgeloop: readEl(storage), player };
    if (includeHandyKey && storage.getItem(HANDY_KEY)) out.handyKey = storage.getItem(HANDY_KEY);
    return out;
}

// Put a backup back. Every value is checked on the way in; anything unknown
// or unreadable is skipped and named. Returns what was restored.
export function importBackup(storage, data) {
    if (!data || typeof data !== 'object' || data.app !== 'edgeloop-player') {
        return { ok: false, error: 'Not a player backup file.', restored: [], skipped: [] };
    }
    const restored = [];
    const skipped = [];
    if (data.edgeloop && typeof data.edgeloop === 'object' && !Array.isArray(data.edgeloop)) {
        const el = readEl(storage);
        for (const [k, v] of Object.entries(data.edgeloop)) {
            if (!(k in SETTING_SANITIZERS)) { skipped.push(k); continue; }
            el[k] = k === 'minHr' || k === 'maxHr' ? v : SETTING_SANITIZERS[k](v);
            restored.push(byKey[k]?.label || k);
        }
        const hr = sanitizeHrLimits(el.minHr, el.maxHr);
        if (!hr.valid) { el.minHr = 70; el.maxHr = 140; skipped.push('heart-rate pair (reset to 70 / 140)'); }
        storage.setItem(EDGELOOP_KEY, JSON.stringify(el));
    }
    for (const [k, v] of Object.entries(data.player || {})) {
        const f = byKey[k];
        if (f && f.store === 'ls') {
            const shown = f.type === 'bool' ? clampField(f, v) : clampField(f, f.scale ? Number(v) * f.scale : v);
            writeField(storage, f, shown);
            restored.push(f.label);
        } else if (EXTRA_KEYS.includes(k) && typeof v === 'string') {
            if (JSON_KEYS.has(k)) { try { JSON.parse(v); } catch { skipped.push(k); continue; } }
            storage.setItem(k, v.slice(0, 200000));
            restored.push(k.replace('player_', '').replace(/_/g, ' '));
        } else {
            skipped.push(k);
        }
    }
    if (typeof data.handyKey === 'string' && data.handyKey.trim()) {
        storage.setItem(HANDY_KEY, data.handyKey.trim().slice(0, 200));
        restored.push('Handy key');
    }
    return { ok: true, restored, skipped };
}
