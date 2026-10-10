// Stash scrubber previews: a WebVTT index of which sprite tile covers which
// time range. Pure, shared by the server (parsing) and the player (lookup).

function vttSeconds(stamp) {
    return stamp.trim().split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
}

export function parseThumbsVtt(text) {
    const cues = [];
    const re = /(\d[\d:.]+)\s*-->\s*(\d[\d:.]+)\s*\r?\n[^#\r\n]*#xywh=(\d+),(\d+),(\d+),(\d+)/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
        cues.push({ start: vttSeconds(m[1]), end: vttSeconds(m[2]), x: +m[3], y: +m[4], w: +m[5], h: +m[6] });
    }
    return cues;
}

export function cueAt(cues, seconds) {
    let lo = 0, hi = cues.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (seconds < cues[mid].start) hi = mid - 1;
        else if (seconds >= cues[mid].end) lo = mid + 1;
        else return cues[mid];
    }
    return cues.length ? cues[Math.max(0, Math.min(cues.length - 1, lo))] : null;
}
