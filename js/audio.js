/**
 * audio.js — procedural Web Audio synth engine (no sample files).
 *
 * Signal path (everything is capped, so it can never get loud or harsh):
 *
 *   voices ─▶ steal gain ─▶ pan ─▶ bus(0.5) ─▶ wobble ─┬─▶ dry ──────────────┐
 *                                                     ├─▶ shimmer (chorus) ─┤
 *                                                     ├─▶ echo (feedback) ──┼─▶ warmth LPF ─▶ sparkle shelf ─▶ compressor ─▶ master ─▶ limiter ─▶ out
 *                                                     └─▶ space (reverb) ───┘
 *
 * The effects are driven by the three per-scene sound sliders (setFx).
 *
 * - A fixed voice pool (voice stealing) limits simultaneous one-shot notes.
 *   Stolen voices fade out over ~40 ms through their own "steal" gain stage,
 *   so we never cancel an envelope mid-ramp (which can click).
 * - Every envelope starts at 0 and ramps up (≥ 5 ms attack) → no clicks.
 * - All pitches come from one shared musical scale (pentatonic by default),
 *   addressed by integer "steps", so any combination of notes is consonant.
 * - Gesture speed is mapped by callers to `vel` (volume) and `bright` (timbre).
 */

export const SCALES = {
  pentMajor: [0, 2, 4, 7, 9],
  pentMinor: [0, 3, 5, 7, 10],
};

const ROOT_MIDI = 48; // C3. Step 0 = C3, step 5 = C4, step 10 = C5 …

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.scale = SCALES.pentMajor;
    this.volume = 0.7;
    this.muted = false;
    this.windFactor = 1;
    this.maxVoices = 14;
    this.voices = [];
    this.pads = new Set();
    this.ambient = null;
    this.fx = {}; this.pitchShift = 0; this.ringMul = 1; this.sparkle = 0;
  }

  // ---- lifecycle ----------------------------------------------------------

  /** Must be called from inside a user gesture (iOS requirement). */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this._build();
    }
    // iOS: playing a silent buffer inside the gesture fully unlocks output.
    try {
      const b = this.ctx.createBuffer(1, 1, 22050);
      const s = this.ctx.createBufferSource();
      s.buffer = b; s.connect(this.ctx.destination); s.start(0);
    } catch (e) { /* ignore */ }
    if (this.ctx.state !== 'running') this.ctx.resume();
    this.ready = true;
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ready && this.ctx.state !== 'running') this.ctx.resume(); }

  _build() {
    const c = this.ctx;
    this.bus = c.createGain(); this.bus.gain.value = 0.5;
    // --- sound-slider effects (all start neutral; see setFx) -----------------
    this.trem = c.createGain(); this.trem.gain.value = 1;            // wobble (tremolo)
    this.tremLfo = c.createOscillator(); this.tremLfo.frequency.value = 2.6;
    this.tremDepth = c.createGain(); this.tremDepth.gain.value = 0;
    this.tremLfo.connect(this.tremDepth); this.tremDepth.connect(this.trem.gain); this.tremLfo.start();
    this.dry = c.createGain(); this.dry.gain.value = 1;
    this.chorus = c.createDelay(0.1); this.chorus.delayTime.value = 0.022; // shimmer (chorus)
    this.chorusLfo = c.createOscillator(); this.chorusLfo.frequency.value = 0.35;
    this.chorusDepth = c.createGain(); this.chorusDepth.gain.value = 0;
    this.chorusLfo.connect(this.chorusDepth); this.chorusDepth.connect(this.chorus.delayTime); this.chorusLfo.start();
    this.chorusWet = c.createGain(); this.chorusWet.gain.value = 0;
    this.echo = c.createDelay(2.0); this.echo.delayTime.value = 0.38;  // echo (feedback delay)
    this.echoLp = c.createBiquadFilter(); this.echoLp.type = 'lowpass'; this.echoLp.frequency.value = 2600; // each repeat gets softer/darker
    this.echoFb = c.createGain(); this.echoFb.gain.value = 0;
    this.echoWet = c.createGain(); this.echoWet.gain.value = 0;
    this.shelf = c.createBiquadFilter(); this.shelf.type = 'highshelf'; this.shelf.frequency.value = 4500; this.shelf.gain.value = 0; // sparkle
    // --- mastering --------------------------------------------------------
    this.tone = c.createBiquadFilter(); this.tone.type = 'lowpass'; this.tone.frequency.value = 7000; this.tone.Q.value = 0.4; // warmth
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -20; this.comp.knee.value = 20; this.comp.ratio.value = 8;
    this.comp.attack.value = 0.005; this.comp.release.value = 0.3;
    this.master = c.createGain(); this.master.gain.value = 0;
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -6; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001; this.limiter.release.value = 0.12;

    this.revSend = c.createGain(); this.revSend.gain.value = 0.32;
    this.reverb = c.createConvolver();
    this.reverb.buffer = this._impulse(2.6);

    this.bus.connect(this.trem);
    this.trem.connect(this.dry); this.dry.connect(this.tone);
    this.trem.connect(this.chorus); this.chorus.connect(this.chorusWet); this.chorusWet.connect(this.tone);
    this.trem.connect(this.echo); this.echo.connect(this.echoLp); this.echoLp.connect(this.echoFb); this.echoFb.connect(this.echo);
    this.echoLp.connect(this.echoWet); this.echoWet.connect(this.tone);
    this.trem.connect(this.revSend); this.revSend.connect(this.reverb); this.reverb.connect(this.tone);
    this.tone.connect(this.shelf); this.shelf.connect(this.comp); this.comp.connect(this.master);
    this.master.connect(this.limiter); this.limiter.connect(c.destination);
    this._applyMaster(0.4);
    this.setFx(this.fx);
  }

  /**
   * Sound-slider effects. Every value is 0..1; missing keys go back to neutral.
   * All ranges are capped (echo feedback ≤ 0.6, sparkle ≤ +5 dB, wobble ≤ 45 %)
   * and everything still passes through the compressor and limiter.
   *   echo    feedback delay (wet + repeats)   echoTime  seconds between repeats
   *   space   reverb amount                    shimmer   slow chorus
   *   warmth  low-pass (darker, softer)        sparkle   gentle high shelf + brighter bells
   *   wobble  slow tremolo                     pitch     shifts every note by up to ±1 octave (in scale steps)
   *   ring    how long bells ring (0.5×–2.5×)
   */
  setFx(fx = {}) {
    const f = { echo: 0, echoTime: 0.38, space: 0.3, shimmer: 0, warmth: 0, sparkle: 0, wobble: 0, pitch: 0.5, ring: 0.25, ...fx };
    this.fx = f;
    this.pitchShift = Math.round((f.pitch - 0.5) * 10);
    this.ringMul = 0.5 + f.ring * 2.0;
    this.sparkle = f.sparkle;
    if (!this.ctx) return;
    const t = this.ctx.currentTime, tc = 0.08;
    this.echo.delayTime.setTargetAtTime(f.echoTime, t, 0.2);
    this.echoWet.gain.setTargetAtTime(0.5 * f.echo, t, tc);
    this.echoFb.gain.setTargetAtTime(f.echo > 0.001 ? 0.12 + 0.48 * f.echo : 0, t, tc);
    this.revSend.gain.setTargetAtTime(0.05 + 0.9 * f.space, t, tc);
    this.chorusWet.gain.setTargetAtTime(0.6 * f.shimmer, t, tc);
    this.chorusDepth.gain.setTargetAtTime(0.006 * f.shimmer, t, tc);
    this.dry.gain.setTargetAtTime(1 - 0.25 * f.shimmer, t, tc);
    this.tone.frequency.setTargetAtTime(7000 * Math.pow(1 - f.warmth, 2.2) + 450, t, tc);
    this.shelf.gain.setTargetAtTime(5 * f.sparkle, t, tc);
    this.tremDepth.gain.setTargetAtTime(0.45 * f.wobble, t, tc);
  }

  /** Procedural stereo reverb impulse: smoothed decaying noise (a soft, roomy tail). */
  _impulse(seconds) {
    const c = this.ctx, rate = c.sampleRate, len = Math.floor(rate * seconds);
    const buf = c.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        lp += 0.35 * ((Math.random() * 2 - 1) - lp); // gentle low-pass = darker tail
        d[i] = lp * Math.pow(1 - t, 2.4) * (i < rate * 0.01 ? i / (rate * 0.01) : 1);
      }
    }
    return buf;
  }

  _applyMaster(tc = 0.15) {
    if (!this.ctx) return;
    const v = this.muted ? 0 : this.volume * this.volume * this.windFactor; // squared = perceptual taper
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, tc);
  }
  setVolume(v) { this.volume = v; this._applyMaster(); }
  setMuted(m) { this.muted = m; this._applyMaster(0.08); }
  setWindFactor(f) { this.windFactor = f; this._applyMaster(0.5); }
  setScale(name) { this.scale = SCALES[name] || SCALES.pentMajor; }

  // ---- pitch helpers ------------------------------------------------------

  /** Frequency of integer scale step (0 = C3). Works for any step, incl. negatives. */
  freq(step) {
    step += this.pitchShift; // the 'pitch' sound slider moves along the same scale
    const n = this.scale.length;
    const oct = Math.floor(step / n);
    const deg = ((step % n) + n) % n;
    const midi = ROOT_MIDI + 12 * oct + this.scale[deg];
    return 440 * Math.pow(2, (midi - 69) / 12);
  }
  /** Map a 0..1 value onto a scale step between lo and hi (inclusive). */
  stepFromUnit(u, lo, hi) { return Math.round(lo + Math.min(1, Math.max(0, u)) * (hi - lo)); }

  // ---- voice pool ---------------------------------------------------------

  /** Reserve a voice slot; steals the oldest voice (soft fade) if the pool is full. */
  _voice(dur, pan, send = 1) {
    const c = this.ctx, now = c.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) if (this.voices[i].end < now) this.voices.splice(i, 1);
    if (this.voices.length >= this.maxVoices) {
      const old = this.voices.shift();
      old.steal.gain.setTargetAtTime(0, now, 0.012);
      for (const o of old.oscs) { try { o.stop(now + 0.08); } catch (e) { /* already stopped */ } }
    }
    const steal = c.createGain();
    let out = steal;
    if (c.createStereoPanner) {
      const p = c.createStereoPanner(); p.pan.value = Math.max(-0.8, Math.min(0.8, pan || 0));
      steal.connect(p); out = p;
    }
    out.connect(this.bus);
    const v = { end: now + dur, steal, out, oscs: [], nodes: [steal, out] };
    this.voices.push(v);
    return v;
  }

  _osc(v, type, f) {
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.value = f;
    v.oscs.push(o); v.nodes.push(o);
    return o;
  }
  _gain(v, val = 0) { const g = this.ctx.createGain(); g.gain.value = val; v.nodes.push(g); return g; }

  /** Start all oscillators of a voice and clean the graph up when it ends. */
  _run(v, t, dur) {
    let left = v.oscs.length;
    for (const o of v.oscs) {
      o.onended = () => { if (--left === 0) for (const n of v.nodes) { try { n.disconnect(); } catch (e) { /* ok */ } } };
      o.start(t); o.stop(t + dur);
    }
  }

  /** Attack/decay envelope on a gain param: 0 → peak in `atk`, exponential-ish decay. */
  _env(param, t, peak, atk, tau) {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + atk);
    param.setTargetAtTime(0, t + atk, tau);
  }

  _ok() { return this.ctx && this.ready && this.ctx.state === 'running' && !this.muted; }

  // ---- one-shot voices ----------------------------------------------------

  /** Soft FM bell/chime. vel 0..1 → volume, bright 0..1 → FM index (timbre). */
  chime(f, vel = 0.5, pan = 0, bright = 0.5, decay = 1.6) {
    if (!this._ok()) return;
    decay *= this.ringMul; bright = Math.min(1, bright + this.sparkle * 0.35);
    const c = this.ctx, t = c.currentTime + 0.005, dur = decay * 2.2;
    const v = this._voice(dur, pan);
    const car = this._osc(v, 'sine', f);
    const mod = this._osc(v, 'sine', f * 3.5);
    const modG = this._gain(v);
    modG.gain.setValueAtTime(f * (0.6 + 2.2 * bright), t);
    modG.gain.setTargetAtTime(f * 0.08, t, decay * 0.25);
    mod.connect(modG); modG.connect(car.frequency);
    const env = this._gain(v);
    this._env(env.gain, t, 0.05 + 0.22 * vel, 0.012, decay * 0.4);
    car.connect(env);
    // A quiet octave partial adds sparkle without harshness.
    const p2 = this._osc(v, 'sine', f * 2.0);
    const e2 = this._gain(v);
    this._env(e2.gain, t, (0.02 + 0.05 * vel) * bright, 0.008, decay * 0.15);
    p2.connect(e2); e2.connect(v.steal);
    env.connect(v.steal);
    this._run(v, t, dur);
  }

  /** Marimba-like wooden pluck: fundamental + fast-decaying 4th harmonic. */
  marimba(f, vel = 0.5, pan = 0, bright = 0.5) {
    if (!this._ok()) return;
    const c = this.ctx, t = c.currentTime + 0.005, dur = 1.4;
    const v = this._voice(dur, pan);
    const o1 = this._osc(v, 'sine', f), o2 = this._osc(v, 'sine', f * 4), o3 = this._osc(v, 'sine', f * 0.5);
    const g1 = this._gain(v), g2 = this._gain(v), g3 = this._gain(v);
    this._env(g1.gain, t, 0.06 + 0.24 * vel, 0.006, 0.28);
    this._env(g2.gain, t, (0.02 + 0.06 * vel) * bright, 0.005, 0.05);
    this._env(g3.gain, t, 0.03 + 0.05 * vel, 0.01, 0.2);
    o1.connect(g1); o2.connect(g2); o3.connect(g3);
    g1.connect(v.steal); g2.connect(v.steal); g3.connect(v.steal);
    this._run(v, t, dur);
  }

  /** Bubble pop: short sine with an upward pitch sweep. */
  bubble(f, vel = 0.5, pan = 0) {
    if (!this._ok()) return;
    const c = this.ctx, t = c.currentTime + 0.005, dur = 0.4;
    const v = this._voice(dur, pan);
    const o = this._osc(v, 'sine', f);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 2.2, t + 0.12);
    const g = this._gain(v);
    this._env(g.gain, t, 0.06 + 0.2 * vel, 0.008, 0.06);
    o.connect(g); g.connect(v.steal);
    this._run(v, t, dur);
  }

  /** Soft water drop: low "plip" gliding up into a ringing tone, generous reverb. */
  drop(f, vel = 0.5, pan = 0, bright = 0.5) {
    if (!this._ok()) return;
    const c = this.ctx, t = c.currentTime + 0.005, dur = 1.6;
    const v = this._voice(dur, pan);
    const o = this._osc(v, 'sine', f * 0.6);
    o.frequency.setValueAtTime(f * 0.6, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.06);
    const g = this._gain(v);
    this._env(g.gain, t, 0.06 + 0.22 * vel, 0.006, 0.3);
    o.connect(g); g.connect(v.steal);
    const o2 = this._osc(v, 'sine', f * 2);
    const g2 = this._gain(v);
    this._env(g2.gain, t + 0.04, (0.015 + 0.05 * vel) * (0.4 + bright), 0.01, 0.12);
    o2.connect(g2); g2.connect(v.steal);
    this._run(v, t, dur);
  }

  /** Squishy, rounded low tone (jelly): filtered triangle bending gently down. */
  squish(f, vel = 0.5, pan = 0, bright = 0.4) {
    if (!this._ok()) return;
    const c = this.ctx, t = c.currentTime + 0.005, dur = 1.2;
    const v = this._voice(dur, pan);
    const o = this._osc(v, 'triangle', f * 1.15);
    o.frequency.setValueAtTime(f * 1.15, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.18);
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3; v.nodes.push(lp);
    lp.frequency.setValueAtTime(f * (2 + 4 * bright), t);
    lp.frequency.setTargetAtTime(f * 1.2, t, 0.12);
    const sub = this._osc(v, 'sine', f * 0.5);
    const g = this._gain(v), gs = this._gain(v);
    this._env(g.gain, t, 0.1 + 0.3 * vel, 0.025, 0.22);
    this._env(gs.gain, t, 0.08 + 0.15 * vel, 0.03, 0.25);
    o.connect(lp); lp.connect(g); g.connect(v.steal);
    sub.connect(gs); gs.connect(v.steal);
    this._run(v, t, dur);
  }

  // ---- sustained pads -----------------------------------------------------

  /**
   * Create a sustained pad voice. Returns a handle with set(level, bright, freq, pan) and stop().
   * type 'warm'   : detuned saws through a low-pass (soft, round)
   * type 'shimmer': stacked sines/triangles with slow tremolo (airy)
   */
  pad(type = 'warm', f = 130) {
    if (!this.ctx) return NULL_PAD;
    if (this.pads.size >= 8) { const first = this.pads.values().next().value; first.stop(); }
    const c = this.ctx, t = c.currentTime;
    const nodes = [], oscs = [];
    const mk = (tp, fr, det = 0) => { const o = c.createOscillator(); o.type = tp; o.frequency.value = fr; o.detune.value = det; oscs.push(o); nodes.push(o); return o; };
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 0.7; nodes.push(lp);
    const g = c.createGain(); g.gain.value = 0; nodes.push(g);
    let panner = null;
    if (c.createStereoPanner) { panner = c.createStereoPanner(); nodes.push(panner); }
    const mult = [];
    if (type === 'shimmer') {
      mult.push(1, 2, 3);
      const a = mk('sine', f), b = mk('triangle', f * 2, 4), d = mk('sine', f * 3, -5);
      const trem = mk('sine', 5.5), tg = c.createGain(); tg.gain.value = 0.25; nodes.push(tg);
      const sum = c.createGain(); sum.gain.value = 0.6; nodes.push(sum);
      trem.connect(tg); tg.connect(sum.gain);
      a.connect(sum); b.connect(sum); d.connect(sum); sum.connect(lp);
    } else {
      mult.push(1, 1, 0.5);
      const a = mk('sawtooth', f, -8), b = mk('sawtooth', f, 8), d = mk('sine', f * 0.5);
      a.connect(lp); b.connect(lp); d.connect(lp);
    }
    lp.connect(g);
    if (panner) { g.connect(panner); panner.connect(this.bus); } else g.connect(this.bus);
    oscs.forEach((o) => o.start(t));
    const freqOscs = type === 'shimmer' ? [oscs[0], oscs[1], oscs[2]] : [oscs[0], oscs[1], oscs[2]];
    const engine = this;
    const handle = {
      alive: true,
      set(level, bright = 0.3, freq = null, pan = null, tc = 0.12) {
        if (!handle.alive) return;
        const now = c.currentTime;
        g.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * 0.12, now, tc);
        lp.frequency.setTargetAtTime(250 + 2600 * Math.max(0, Math.min(1, bright)) ** 1.5, now, tc);
        if (freq) for (let i = 0; i < freqOscs.length; i++) freqOscs[i].frequency.setTargetAtTime(freq * mult[i], now, 0.08);
        if (pan !== null && panner) panner.pan.setTargetAtTime(Math.max(-0.8, Math.min(0.8, pan)), now, 0.1);
      },
      stop(fade = 0.35) {
        if (!handle.alive) return;
        handle.alive = false;
        engine.pads.delete(handle);
        const now = c.currentTime;
        g.gain.setTargetAtTime(0, now, fade / 3);
        oscs.forEach((o) => { try { o.stop(now + fade * 2 + 0.1); } catch (e) { /* ok */ } });
        oscs[0].onended = () => nodes.forEach((n) => { try { n.disconnect(); } catch (e) { /* ok */ } });
      },
    };
    this.pads.add(handle);
    return handle;
  }

  /** Stop every sustained pad (called on scene switch so no nodes leak). */
  releaseAllPads() { for (const p of [...this.pads]) if (p !== this.ambient) p.stop(); }

  /** Quiet optional ambient drone (root + fifth), very slow. */
  setAmbient(on, rootStep = 0) {
    if (this.ambient) { this.ambient.stop(1.5); this.ambient = null; }
    if (!on || !this.ctx) return;
    this.ambient = this.pad('warm', this.freq(rootStep));
    this.ambient.set(0.35, 0.12, null, 0, 1.5);
  }
}

const NULL_PAD = { alive: false, set() {}, stop() {} };
