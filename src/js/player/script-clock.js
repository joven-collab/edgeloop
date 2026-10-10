// A stand-in for the <video> element in Script-only mode: the same clock
// surface the player uses (currentTime, duration, paused, play/pause, seek
// and the media events) with no picture and no network stream, so every
// sync, seek and safety path runs unchanged.
export class ScriptClock extends EventTarget {
    constructor({ now = () => performance.now(), tickMs = 250 } = {}) {
        super();
        this.isClock = true;
        this._now = now;
        this._base = 0;        // media seconds at _since
        this._since = null;    // wall time playback (re)started, null while paused
        this.duration = NaN;
        this.ended = false;
        this.seeking = false;
        this.readyState = 0;
        this.muted = true;
        this.error = null;
        this._timer = setInterval(() => this._tick(), tickMs);
    }

    get paused() { return this._since === null; }

    get currentTime() {
        const t = this._since === null ? this._base : this._base + (this._now() - this._since) / 1000;
        return Number.isFinite(this.duration) ? Math.min(t, this.duration) : t;
    }

    set currentTime(sec) {
        const t = Math.max(0, Number(sec) || 0);
        this.ended = false;
        this._emit('seeking');
        this._base = Number.isFinite(this.duration) ? Math.min(t, this.duration) : t;
        if (this._since !== null) this._since = this._now();
        this._emit('seeked');
        this._emit('timeupdate');
    }

    // The player assigns a stream URL; the clock only needs the length, which
    // the player sets on `duration` first.
    set src(_) {
        this._base = 0;
        this._since = null;
        this.ended = false;
        this.readyState = 4;
        queueMicrotask(() => { this._emit('loadedmetadata'); this._emit('canplay'); });
    }

    get src() { return ''; }

    play() {
        if (this._since === null) {
            if (this.ended) { this._base = 0; this.ended = false; }
            this._since = this._now();
            this._emit('play');
            this._emit('playing');
        }
        return Promise.resolve();
    }

    pause() {
        if (this._since === null) return;
        this._base = this.currentTime;
        this._since = null;
        this._emit('pause');
    }

    removeAttribute() { this.pause(); this.readyState = 0; this.duration = NaN; }
    load() {}
    getAttribute() { return null; }

    dispose() { clearInterval(this._timer); this.pause(); }

    _tick() {
        if (this._since === null) return;
        this._emit('timeupdate');
        if (Number.isFinite(this.duration) && this.currentTime >= this.duration) {
            this._base = this.duration;
            this._since = null;
            this.ended = true;
            this._emit('pause');
            this._emit('ended');
        }
    }

    _emit(type) { this.dispatchEvent(new Event(type)); }
}
