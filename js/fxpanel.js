/**
 * fxpanel.js — the three sound sliders on the right-hand side.
 *
 * Each scene names three effects (see AudioEngine.setFx) with starting values;
 * the panel shows one vertical slider per effect. Custom sliders give large
 * touch targets that work in every iPad Safari. Values are saved per scene,
 * and moving a slider plays a soft preview bell so the change is heard
 * straight away. The panel dims after 4 s without use.
 */
import { THEMES } from './util.js';

const FX_ICONS = {
  echo: '<circle cx="5" cy="12" r="2.6"/><circle cx="12" cy="12" r="2" opacity=".65"/><circle cx="18.5" cy="12" r="1.5" opacity=".35"/>',
  space: '<path d="M3 19a9 9 0 0 1 18 0M7 19a5 5 0 0 1 10 0"/><circle cx="12" cy="19" r="1"/>',
  shimmer: '<path d="M12 3l1.8 6.2L20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8z"/>',
  warmth: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  sparkle: '<path d="M8 3l1 3 3 1-3 1-1 3-1-3-3-1 3-1zM16 11l1.3 3.7 3.7 1.3-3.7 1.3L16 21l-1.3-3.7-3.7-1.3 3.7-1.3z"/>',
  wobble: '<path d="M2 12c2.5-6 5-6 7.5 0s5 6 7.5 0 3.5-5 5-3"/>',
  pitch: '<path d="M7 20V4M3.5 7.5L7 4l3.5 3.5M17 4v16M13.5 16.5L17 20l3.5-3.5"/>',
  ring: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.8 1.8H4.2z"/><path d="M10 21h4"/>',
};
const FX_LABELS = { echo: 'Echo', space: 'Space', shimmer: 'Shimmer', warmth: 'Warmth', sparkle: 'Sparkle', wobble: 'Wobble', pitch: 'Pitch', ring: 'Ring length' };

export class FxPanel {
  /**
   * @param {HTMLElement} el     the #fx container
   * @param {AudioEngine} audio
   * @param {object} settings    the live app settings (reads fx / theme / fxPanel, writes fx)
   * @param {Function} save      persists settings
   */
  constructor(el, audio, settings, save) {
    Object.assign(this, { el, audio, settings, save });
    this.timer = 0;
    this.previewAt = 0;
  }

  /** Current slider values for scene `sc`: saved ones, else the scene's defaults. */
  values(sc) {
    const saved = this.settings.fx && this.settings.fx[sc.id];
    return sc.fx.map(([, def], i) => (saved && typeof saved[i] === 'number' ? saved[i] : def));
  }

  apply(sc, vals = this.values(sc)) {
    const fx = { echoTime: sc.echoTime };
    sc.fx.forEach(([key], i) => { fx[key] = vals[i]; });
    this.audio.setFx(fx);
  }

  /** Rebuild the sliders for scene `sc` (registry entry) at position `index`. */
  build(sc, index) {
    const { audio, settings } = this;
    const vals = this.values(sc), pal = THEMES[settings.theme] || THEMES.neon;
    this.apply(sc, vals);
    this.el.innerHTML = '';
    sc.fx.forEach(([key], i) => {
      const el = document.createElement('div');
      el.className = 'fx-slider';
      el.setAttribute('role', 'slider'); el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', FX_LABELS[key]); el.setAttribute('aria-orientation', 'vertical');
      el.setAttribute('aria-valuemin', '0'); el.setAttribute('aria-valuemax', '100');
      el.style.setProperty('--c', pal.colors[(index + i * 2) % pal.colors.length]);
      el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${FX_ICONS[key]}</svg><div class="track"><div class="fill"></div><div class="thumb"></div></div>`;
      const track = el.querySelector('.track');
      const set = (v, preview) => {
        v = Math.min(1, Math.max(0, v));
        el.style.setProperty('--v', v);
        el.setAttribute('aria-valuenow', Math.round(v * 100));
        vals[i] = v;
        settings.fx = { ...settings.fx, [sc.id]: [...vals] };
        this.apply(sc, vals);
        if (preview) this.preview();
      };
      const fromY = (y) => { const r = track.getBoundingClientRect(); return 1 - (y - r.top) / r.height; };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
        el.classList.add('active'); this.wake(); audio.unlock();
        set(fromY(e.clientY), true);
      });
      el.addEventListener('pointermove', (e) => { if (el.classList.contains('active')) { set(fromY(e.clientY), true); this.wake(); } });
      const end = () => { if (el.classList.contains('active')) { el.classList.remove('active'); this.save(); } };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end);
      el.addEventListener('keydown', (e) => {
        const d = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key];
        if (d) { e.preventDefault(); set(vals[i] + d, true); this.save(); }
      });
      set(vals[i], false);
      this.el.appendChild(el);
    });
  }

  /** A soft bell through the current effects, at most ~4 per second while dragging. */
  preview() {
    const now = performance.now();
    if (now - this.previewAt < 260) return;
    this.previewAt = now;
    this.audio.chime(this.audio.freq(9 + ((now / 260) | 0) % 3), 0.28, 0.6, 0.3, 1.4);
  }

  /** Brighten the panel, then dim it again after 4 s. */
  wake() {
    this.el.classList.remove('dim');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.el.classList.add('dim'), 4000);
  }

  /** Show or hide the whole panel (parent setting). */
  applyVisibility() { this.el.hidden = !this.settings.fxPanel; }
}
