// Live volume leveling for the <video> element: an automatic gain control
// measures the incoming loudness and steers a gain node toward one target
// level: loud passages are turned down quickly, quiet ones raised slowly
// (so it does not pump), near-silence is left alone (so hiss is not boosted),
// and a light limiter after it catches any spike.
//
// The Web Audio DynamicsCompressorNode is not used for the leveling itself:
// it applies its own automatic make-up gain that cannot be switched off, so a
// strong compressor ends up making loud passages louder. As a limiter with a
// threshold near 0 dB its make-up gain is about +0.5 dB, which is harmless.
//
// A media element can be wired into Web Audio only once, and the context
// must be created or resumed from a user gesture, so everything is built
// lazily on the first set(true) and kept for the page's lifetime.

export const LEVELER = Object.freeze({
    targetDb: -23,      // loudness (RMS, dBFS) everything is steered toward
    maxBoostDb: 12,
    maxCutDb: -24,
    silenceDb: -55,     // quieter than this: hold the gain, do not boost noise
    cutPerSecondDb: 40, // how fast loud passages are brought down
    risePerSecondDb: 5, // how fast quiet passages are brought up
    intervalMs: 50,
    limitAt: -1.5       // dB ceiling for the limiter
});

export const toDb = (x) => 20 * Math.log10(Math.max(x, 1e-9));

// One control step: move the current gain toward the one that would put the
// measured level on target, cutting fast and raising slowly. Pure.
export function nextGainDb(currentDb, levelDb, dtSeconds, s = LEVELER) {
    if (!(levelDb > s.silenceDb)) return currentDb;
    const wanted = Math.max(s.maxCutDb, Math.min(s.maxBoostDb, s.targetDb - levelDb));
    const diff = wanted - currentDb;
    const maxStep = (diff < 0 ? s.cutPerSecondDb : s.risePerSecondDb) * dtSeconds;
    return currentDb + Math.max(-maxStep, Math.min(maxStep, diff));
}

export function createLeveler(mediaEl, settings = LEVELER) {
    let ctx = null;
    let source = null;
    let analyser = null;
    let gain = null;
    let chainIn = null;
    let timer = 0;
    let gainDb = 0;
    let on = false;
    let samples = null;

    function build() {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) return false;
        ctx = new AC();
        source = ctx.createMediaElementSource(mediaEl);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        samples = new Float32Array(analyser.fftSize);
        gain = ctx.createGain();
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = settings.limitAt;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.1;
        // Measure the input (before the gain) so the control never chases itself.
        analyser.connect(gain);
        gain.connect(limiter).connect(ctx.destination);
        chainIn = analyser;
        return true;
    }

    function step() {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const levelDb = toDb(Math.sqrt(sum / samples.length));
        gainDb = nextGainDb(gainDb, levelDb, settings.intervalMs / 1000, settings);
        gain.gain.setTargetAtTime(Math.pow(10, gainDb / 20), ctx.currentTime, 0.03);
    }

    function route() {
        source.disconnect();
        clearInterval(timer);
        if (on) {
            source.connect(chainIn);
            timer = setInterval(step, settings.intervalMs);
        } else {
            source.connect(ctx.destination);
        }
    }

    return {
        get enabled() { return on; },
        get gainDb() { return gainDb; },
        get available() { return Boolean(globalThis.AudioContext || globalThis.webkitAudioContext); },
        // Once wired in, the element is only audible while the context runs,
        // so playback nudges it awake.
        resume() { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); },
        // Call from a click or key press the first time.
        set(want) {
            on = Boolean(want);
            if (!ctx) {
                if (!on) return on;
                if (!build()) { on = false; return on; }
            }
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            route();
            return on;
        }
    };
}
