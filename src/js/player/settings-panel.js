// The settings overlay, drawn from the FIELDS list. Each change is clamped and
// stored straight away, and `onChange` lets the player apply it live.

import { TABS, FIELDS, byKey, readAll, writeField, exportBackup, importBackup } from './player-settings.js';

const $ = (id) => document.getElementById(id);

export function mountSettingsPanel({ storage = localStorage, onChange = () => {}, testHandy = null, handyInfo = null } = {}) {
    let tab = 'hr';
    let values = readAll(storage);

    const msg = (text, bad = false) => {
        $('settingsMsg').textContent = text || '';
        $('settingsMsg').classList.toggle('bad', bad);
    };

    function set(f, value) {
        const r = writeField(storage, f, value);
        values = readAll(storage);
        msg(r.ok ? '' : r.error, !r.ok);
        onChange(f.key, values[f.key]);
        render();
    }

    function fieldRow(f) {
        const row = document.createElement('div');
        row.className = 'set-row' + (f.sub ? ' sub' : '');
        const off = f.sub && !values[f.sub];
        if (f.type === 'bool') {
            const label = document.createElement('label');
            label.className = 'toggle';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = Boolean(values[f.key]);
            input.addEventListener('change', () => set(f, input.checked));
            const sw = document.createElement('span');
            sw.className = 'switch';
            label.append(input, sw, f.label);
            row.append(label);
            return row;
        }
        const label = document.createElement('label');
        label.className = 'set-label';
        label.textContent = f.label;
        let input;
        if (f.type === 'select') {
            input = document.createElement('select');
            for (const [v, text] of f.options) {
                const o = document.createElement('option');
                o.value = v;
                o.textContent = text;
                input.append(o);
            }
            input.value = values[f.key];
        } else if (f.type === 'secret') {
            input = document.createElement('input');
            input.type = 'password';
            input.autocomplete = 'off';
            input.spellcheck = false;
            input.value = values[f.key] || '';
            if (f.placeholder) input.placeholder = f.placeholder;
        } else {
            input = document.createElement('input');
            input.type = 'number';
            input.min = f.min;
            input.max = f.max;
            input.step = f.step || 1;
            input.value = values[f.key];
        }
        input.disabled = off;
        input.addEventListener('change', () => set(f, input.value));
        label.append(input);
        if (f.unit) {
            const unit = document.createElement('span');
            unit.className = 'muted';
            unit.textContent = f.unit;
            label.append(unit);
        }
        if (f.type === 'secret') {
            const show = document.createElement('button');
            show.type = 'button';
            show.textContent = 'Show';
            show.addEventListener('click', () => {
                input.type = input.type === 'password' ? 'text' : 'password';
                show.textContent = input.type === 'password' ? 'Show' : 'Hide';
            });
            label.append(show);
        }
        row.append(label);
        return row;
    }

    function handyExtras(body) {
        const row = document.createElement('div');
        row.className = 'set-row';
        const btn = document.createElement('button');
        btn.textContent = 'Test connection';
        btn.addEventListener('click', async () => {
            if (!values.handy_connection_key) { msg('Enter the connection key first.', true); return; }
            msg('Checking…');
            const ok = testHandy ? await testHandy(values.handy_connection_key) : false;
            if (!ok) { msg('The Handy did not answer. Is it on Wi-Fi, and is the key right?', true); return; }
            const info = handyInfo ? await handyInfo(values.handy_connection_key) : null;
            const fw = info?.fw_version ? ` Firmware ${info.fw_version}` : '';
            const ready = info ? (info.fw_status === 2 ? ': needs an update for the newer mode.' : ': ready for the newer mode.') : '.';
            msg('The Handy is online.' + fw + ready);
        });
        row.append(btn);
        body.append(row);
    }

    function backupTab(body) {
        const note = document.createElement('p');
        note.className = 'muted small';
        note.textContent = 'Saves every setting here, your goals, warm-up, the recently played list and the panic log to a file. What the player has learned about your videos stays in the data folder on this PC.';
        body.append(note);

        const keyRow = document.createElement('div');
        keyRow.className = 'set-row';
        const keyLabel = document.createElement('label');
        keyLabel.className = 'toggle';
        const keyBox = document.createElement('input');
        keyBox.type = 'checkbox';
        const sw = document.createElement('span');
        sw.className = 'switch';
        keyLabel.append(keyBox, sw, 'Include the Handy key');
        keyRow.append(keyLabel);
        body.append(keyRow);

        const row = document.createElement('div');
        row.className = 'set-row buttons';
        const exp = document.createElement('button');
        exp.textContent = 'Export';
        exp.addEventListener('click', () => {
            const data = exportBackup(storage, { includeHandyKey: keyBox.checked });
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `player-backup-${data.exportedAt.slice(0, 10)}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            msg('Backup saved to your downloads.');
        });
        const file = document.createElement('input');
        file.type = 'file';
        file.accept = '.json,application/json';
        file.hidden = true;
        const imp = document.createElement('button');
        imp.textContent = 'Import';
        imp.addEventListener('click', () => file.click());
        file.addEventListener('change', async () => {
            const f = file.files?.[0];
            file.value = '';
            if (!f) return;
            let data;
            try { data = JSON.parse(await f.text()); } catch { msg('That file is not readable JSON.', true); return; }
            const r = importBackup(storage, data);
            if (!r.ok) { msg(r.error, true); return; }
            values = readAll(storage);
            for (const fld of FIELDS) onChange(fld.key, values[fld.key]);
            msg(`Restored ${r.restored.length} settings.` + (r.skipped.length ? ` Skipped: ${r.skipped.join(', ')}.` : ''));
            render();
        });
        row.append(exp, imp, file);
        body.append(row);
    }

    function render() {
        const tabs = $('settingsTabs');
        tabs.replaceChildren(...TABS.map(t => {
            const b = document.createElement('button');
            b.textContent = t.label;
            b.className = t.id === tab ? 'on' : '';
            b.addEventListener('click', () => { tab = t.id; msg(''); render(); });
            return b;
        }));
        const body = $('settingsBody');
        body.replaceChildren();
        for (const f of FIELDS.filter(x => x.tab === tab)) body.append(fieldRow(f));
        if (tab === 'handy') handyExtras(body);
        if (tab === 'backup') backupTab(body);
    }

    const open = () => { values = readAll(storage); msg(''); render(); $('settings').classList.remove('hidden'); };
    const close = () => { $('settings').classList.add('hidden'); document.activeElement?.blur?.(); };
    $('settingsClose').addEventListener('click', close);
    $('settings').addEventListener('click', (e) => { if (e.target === $('settings')) close(); });

    return {
        open,
        close,
        get isOpen() { return !$('settings').classList.contains('hidden'); },
        // Something outside the panel changed a value (a key press, the
        // start-screen toggles): redraw if it is showing.
        refresh() { if (this.isOpen) { values = readAll(storage); render(); } }
    };
}

export { byKey };
