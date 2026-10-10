// A second-by-second record of one session, saved to data/sessions on this PC:
// the measured pulse, the rate the director acted on (pulse + lookahead + mic +
// rating), the section's intensity, and every event (edges, panics, ratings,
// half speed, scene changes). It is what shows why an edge was or was not
// caught. Pure: the player feeds it and sends it.

// rr: the beat-to-beat intervals (ms) the strap reported during that second,
// for heart-rate variability and breathing; contact: the strap's skin contact.
export const SAMPLE_FIELDS = ['t', 'hr', 'drive', 'rising', 'mic', 'feel', 'level', 'half', 'edged', 'stopped', 'paused', 'rr', 'contact', 'beat', 'hrv'];

export function createSessionLog(meta, now = Date.now()) {
    const start = now;
    const samples = [];
    const events = [];
    const sec = (at) => Math.round((at - start) / 100) / 10;
    return {
        id: String(start),
        // One row a second; values in SAMPLE_FIELDS order, t in seconds.
        sample(at, row) {
            samples.push(SAMPLE_FIELDS.map(k => (k === 't' ? sec(at) : row[k] ?? null)));
        },
        event(at, type, detail = null) {
            events.push([sec(at), type, detail]);
        },
        get size() { return samples.length; },
        toJSON(end = Date.now()) {
            return { id: String(start), startedAt: new Date(start).toISOString(), seconds: sec(end), meta, fields: SAMPLE_FIELDS, samples, events };
        }
    };
}

// Where each edge happened relative to the mark, and what the pulse did in
// the half minute before it: the summary a session file is read for.
export function summarize(log) {
    const i = Object.fromEntries(log.fields.map((f, k) => [f, k]));
    const at = (t) => log.samples.reduce((best, s) => (Math.abs(s[i.t] - t) < Math.abs(best[i.t] - t) ? s : best), log.samples[0]);
    const marks = log.events.filter(e => ['edge', 'panic', 'feel-close', 'missed'].includes(e[1]));
    return marks.map(([t, type, detail]) => {
        const s = at(t);
        const before = log.samples.filter(x => x[i.t] >= t - 30 && x[i.t] <= t);
        const peak = before.reduce((m, x) => Math.max(m, x[i.hr] ?? 0), 0);
        const after = log.samples.filter(x => x[i.t] > t && x[i.t] <= t + 60).reduce((m, x) => Math.max(m, x[i.hr] ?? 0), 0);
        return { t, type, detail, hr: s?.[i.hr] ?? null, drive: s?.[i.drive] ?? null, peak30sBefore: peak, peak60sAfter: after };
    });
}
