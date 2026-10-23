/**
 * main.js — renderer, render loop, scene manager, settings and app chrome.
 *
 * One WebGLRenderer is shared by all scenes. Only one scene runs at a time:
 * switching fades a theme-coloured veil in (300 ms), fully disposes the old
 * scene (geometries, materials, textures, instance buffers and audio pads),
 * builds the new one, then fades the veil out (300 ms) — ~600 ms in total.
 */
import * as THREE from 'three';
import { AudioEngine } from './audio.js';
import { Input } from './input.js';
import { THEMES, disposeObject, smoothstep } from './util.js';

// ---------------------------------------------------------------------------
// Scene registry (lazy-loaded ES modules; all are precached by the service worker)
// ---------------------------------------------------------------------------
// Each scene also names its three right-hand sound sliders (see AudioEngine.setFx):
// [effect key, starting value 0..1]; `echoTime` is that scene's echo spacing in seconds.
const SCENES = [
  { id: 'discs', load: () => import('./scenes/discs.js'), ambient: 0, echoTime: 0.32, fx: [['echo', 0.2], ['shimmer', 0], ['pitch', 0.5]] },
  { id: 'jelly', load: () => import('./scenes/jelly.js'), ambient: -3, echoTime: 0.3, fx: [['wobble', 0], ['warmth', 0.3], ['pitch', 0.5]] },
  { id: 'stars', load: () => import('./scenes/stars.js'), ambient: 2, echoTime: 0.55, fx: [['space', 0.45], ['echo', 0.15], ['sparkle', 0.2]] },
  { id: 'pond', load: () => import('./scenes/pond.js'), ambient: 0, echoTime: 0.45, fx: [['echo', 0.25], ['space', 0.4], ['shimmer', 0.1]] },
  { id: 'clay', load: () => import('./scenes/clay.js'), ambient: 3, echoTime: 0.4, fx: [['wobble', 0], ['echo', 0.1], ['pitch', 0.5]] },
  { id: 'gravity', load: () => import('./scenes/gravity.js'), ambient: -1, echoTime: 0.25, fx: [['echo', 0.15], ['pitch', 0.5], ['sparkle', 0.2]] },
  { id: 'waterfall', load: () => import('./scenes/waterfall.js'), ambient: 1, echoTime: 0.3, fx: [['echo', 0.1], ['ring', 0.25], ['pitch', 0.5]] },
  { id: 'kaleido', load: () => import('./scenes/kaleido.js'), ambient: 4, echoTime: 0.6, fx: [['echo', 0.3], ['shimmer', 0.2], ['space', 0.4]] },
  { id: 'mirror', load: () => import('./scenes/mirror.js'), ambient: 0, echoTime: 0.35, fx: [['wobble', 0], ['warmth', 0.2], ['pitch', 0.5]] },
];

// ---------------------------------------------------------------------------
// Settings (persisted in localStorage)
// ---------------------------------------------------------------------------
const STORE_KEY = 'calmspace.settings.v1';
const DEFAULTS = {
  theme: 'neon', volume: 0.7, ambient: false, scale: 'pentMajor',
  motion: 'medium', density: 'medium', lock: false, navAutoHide: false, windDown: 0,
  kaleidoSegments: 8, muted: false, lastScene: 0, fxPanel: true, fx: {},
};
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; } catch (e) { return { ...DEFAULTS }; }
}
function saveSettings() { try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ } }

const settings = loadSettings();
const reducedMotionMQ = window.matchMedia('(prefers-reduced-motion: reduce)');

/** The read-only context object every scene receives as its `settings` argument. */
function sceneContext() {
  const reduced = reducedMotionMQ.matches;
  const densityF = { low: 0.5, medium: 1, high: 1.6 }[settings.density] * (reduced ? 0.6 : 1);
  return {
    palette: THEMES[settings.theme] || THEMES.neon,
    density: settings.density,
    densityFactor: densityF,
    motion: { low: 0.6, medium: 1, high: 1.35 }[settings.motion],
    reducedMotion: reduced,
    kaleidoSegments: settings.kaleidoSegments,
  };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false });
renderer.outputColorSpace = THREE.SRGBColorSpace;
let dprCap = 2;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const audio = new AudioEngine();
audio.setVolume(settings.volume);
audio.setScale(settings.scale);
audio.setMuted(settings.muted);

let current = null;       // active scene instance
let currentIndex = -1;
let switching = false;
let pendingIndex = -1;
let ctx = sceneContext();

// ---------------------------------------------------------------------------
// Input routing
// ---------------------------------------------------------------------------
const input = new Input(canvas, {
  down(p) {
    revealNavIfBottom(p);
    if (current && !switching) current.onPointerDown(p);
  },
  move(p) { if (current && !switching) current.onPointerMove(p); },
  up(p) { if (current && !switching) current.onPointerUp(p); },
});

// Block every browser gesture that could zoom, scroll, select or open menus.
const stop = (e) => e.preventDefault();
['gesturestart', 'gesturechange', 'gestureend', 'contextmenu', 'dblclick', 'selectstart'].forEach((t) => document.addEventListener(t, stop, { passive: false }));
document.addEventListener('touchmove', (e) => { if (!e.target.closest('.scrollable')) e.preventDefault(); }, { passive: false });
canvas.addEventListener('touchstart', stop, { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => { // kill double-tap zoom on old iOS
  const now = Date.now();
  if (now - lastTouchEnd < 350 && !e.target.closest('button, input, select, label')) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

// ---------------------------------------------------------------------------
// Scene manager
// ---------------------------------------------------------------------------
const veil = document.getElementById('veil');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function applyThemeChrome() {
  const pal = ctx.palette;
  document.documentElement.dataset.theme = settings.theme;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', pal.bg);
  veil.style.background = pal.bg;
  renderer.setClearColor(pal.bg, 1);
}

function disposeScene(s) {
  if (!s) return;
  try { s.dispose(); } catch (e) { console.error('dispose failed', e); }
  disposeObject(s.scene);
  audio.releaseAllPads();
  renderer.renderLists.dispose();
}

async function switchTo(index, { instant = false } = {}) {
  index = ((index % SCENES.length) + SCENES.length) % SCENES.length;
  if (switching) { pendingIndex = index; return; }
  switching = true;
  input.cancelAll();
  if (!instant) { veil.classList.add('on'); await wait(320); }
  disposeScene(current);
  current = null;
  ctx = sceneContext();
  applyThemeChrome();
  const mod = await SCENES[index].load();
  const s = new mod.default();
  s.init(renderer, audio, ctx);
  s.resize(window.innerWidth, window.innerHeight);
  current = s; currentIndex = index;
  settings.lastScene = index; saveSettings();
  updateNavActive();
  buildFxPanel(index);
  audio.setAmbient(settings.ambient && audio.ready, SCENES[index].ambient);
  // Render one frame under the veil so the reveal shows a finished scene.
  s.update(1 / 60, sceneTime);
  render();
  veil.classList.remove('on');
  await wait(instant ? 0 : 300);
  switching = false;
  if (pendingIndex >= 0) { const n = pendingIndex; pendingIndex = -1; if (n !== currentIndex) switchTo(n); }
}

/** Rebuild the current scene (after theme / density / segment changes). */
function reloadScene() { if (currentIndex >= 0) switchTo(currentIndex); }

// ---------------------------------------------------------------------------
// Render loop with adaptive resolution
// ---------------------------------------------------------------------------
let rafId = 0, lastT = 0, sceneTime = 0, frameEMA = 16.7, slowFor = 0;
let errorLogged = false;
const stats = { fps: 60, frameMs: 16.7 };

function render() {
  if (!current) return;
  if (current.render) current.render(renderer); else renderer.render(current.scene, current.camera);
}

function frame(tms) {
  rafId = requestAnimationFrame(frame);
  const t = tms / 1000;
  const raw = lastT ? t - lastT : 1 / 60;
  lastT = t;
  const dtReal = Math.min(raw, 0.05); // clamp so a hiccup never makes physics jump
  // Frame-time monitor: if frames stay above 20 ms for ~1.5 s, drop DPR to 1.5 (once).
  frameEMA += (raw * 1000 - frameEMA) * 0.05;
  stats.frameMs = frameEMA; stats.fps = 1000 / frameEMA;
  if (frameEMA > 20 && dprCap > 1.5) {
    slowFor += raw;
    if (slowFor > 1.5) { dprCap = 1.5; applySize(); console.info('[calm] lowering pixel ratio to 1.5'); }
  } else slowFor = 0;

  input.update(dtReal);
  const dt = dtReal * ctx.motion * (ctx.reducedMotion ? 0.7 : 1);
  sceneTime += dt;
  updateWindDown();
  if (current && !switching) {
    try { current.update(dt, sceneTime); } catch (e) { if (!errorLogged) { console.error(e); errorLogged = true; } }
  }
  render();
}

function startLoop() { if (!rafId) { lastT = 0; rafId = requestAnimationFrame(frame); } }
function stopLoop() { cancelAnimationFrame(rafId); rafId = 0; }

function applySize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  renderer.setSize(w, h, false);
  input.resize(w, h);
  if (current) current.resize(w, h);
}
window.addEventListener('resize', applySize);
window.addEventListener('orientationchange', () => setTimeout(applySize, 250));

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopLoop(); input.cancelAll(); audio.suspend(); }
  else { audio.resume(); startLoop(); }
});

// ---------------------------------------------------------------------------
// Wind-down: after N minutes, dim the screen and quieten audio over 2 minutes.
// It eases into a calm, dim, quiet state and stays there — it never cuts off.
// ---------------------------------------------------------------------------
const dimmer = document.getElementById('dimmer');
let windStart = performance.now();
function updateWindDown() {
  if (!settings.windDown) { if (dimmer.style.opacity !== '0') { dimmer.style.opacity = '0'; audio.setWindFactor(1); } return; }
  const elapsed = (performance.now() - windStart) / 1000;
  const p = smoothstep(0, 1, (elapsed - settings.windDown * 60) / 120);
  dimmer.style.opacity = (0.7 * p).toFixed(3);
  const f = 1 - 0.85 * p;
  if (Math.abs(f - audio.windFactor) > 0.01) audio.setWindFactor(f);
}

// ---------------------------------------------------------------------------
// Navigation bar
// ---------------------------------------------------------------------------
const nav = document.getElementById('nav');
const navButtons = [...nav.querySelectorAll('button[data-scene]')];
let navTimer = 0;

function updateNavActive() {
  navButtons.forEach((b, i) => { b.classList.toggle('active', i === currentIndex); b.setAttribute('aria-pressed', i === currentIndex); });
}
function showNav() {
  wakeFx();
  if (settings.lock) return;
  nav.classList.remove('hidden');
  clearTimeout(navTimer);
  // The scene chooser stays open unless parents switch auto-hide on.
  if (settings.navAutoHide) navTimer = setTimeout(() => nav.classList.add('hidden'), 4000);
}
function revealNavIfBottom(p) {
  if (!settings.lock && nav.classList.contains('hidden') && p.y > window.innerHeight - 110) showNav();
  if (p.x > window.innerWidth - 110) wakeFx();
}
navButtons.forEach((b) => b.addEventListener('click', () => {
  showNav();
  const i = Number(b.dataset.scene);
  if (i !== currentIndex) switchTo(i);
}));
nav.addEventListener('pointerdown', showNav);

function applyLock() {
  nav.classList.toggle('locked', settings.lock);
  if (settings.lock) nav.classList.add('hidden');
}

// Mute toggle — always visible.
const muteBtn = document.getElementById('mute');
function updateMute() { muteBtn.classList.toggle('muted', settings.muted); muteBtn.setAttribute('aria-pressed', settings.muted); }
muteBtn.addEventListener('click', () => {
  audio.unlock();
  settings.muted = !settings.muted; audio.setMuted(settings.muted); saveSettings(); updateMute();
});


// ---------------------------------------------------------------------------
// Sound sliders (right-hand side): three per scene, each driving one effect.
// Custom vertical sliders (large touch targets, work in every iPad Safari);
// values are saved per scene. Moving a slider plays a soft preview bell so
// the change is heard straight away.
// ---------------------------------------------------------------------------
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
const fxPanel = document.getElementById('fx');
let fxTimer = 0, previewAt = 0;

function fxValues(index) {
  const sc = SCENES[index];
  const saved = settings.fx && settings.fx[sc.id];
  return sc.fx.map(([, def], i) => (saved && typeof saved[i] === 'number' ? saved[i] : def));
}
function applyFx(index) {
  const sc = SCENES[index], vals = fxValues(index);
  const fx = { echoTime: sc.echoTime };
  sc.fx.forEach(([key], i) => { fx[key] = vals[i]; });
  audio.setFx(fx);
}
function buildFxPanel(index) {
  applyFx(index);
  const sc = SCENES[index], vals = fxValues(index), pal = THEMES[settings.theme] || THEMES.neon;
  fxPanel.innerHTML = '';
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
      applyFx(index);
      if (preview) previewFx();
    };
    const fromY = (y) => { const r = track.getBoundingClientRect(); return 1 - (y - r.top) / r.height; };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
      el.classList.add('active'); wakeFx(); audio.unlock();
      set(fromY(e.clientY), true);
    });
    el.addEventListener('pointermove', (e) => { if (el.classList.contains('active')) { set(fromY(e.clientY), true); wakeFx(); } });
    const end = () => { if (el.classList.contains('active')) { el.classList.remove('active'); saveSettings(); } };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end);
    el.addEventListener('keydown', (e) => {
      const d = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key];
      if (d) { e.preventDefault(); set(vals[i] + d, true); saveSettings(); }
    });
    set(vals[i], false);
    fxPanel.appendChild(el);
  });
}
/** A soft bell through the current effects, at most ~4 per second while dragging. */
function previewFx() {
  const now = performance.now();
  if (now - previewAt < 260) return;
  previewAt = now;
  audio.chime(audio.freq(9 + ((now / 260) | 0) % 3), 0.28, 0.6, 0.3, 1.4);
}
function wakeFx() {
  fxPanel.classList.remove('dim');
  clearTimeout(fxTimer);
  fxTimer = setTimeout(() => fxPanel.classList.add('dim'), 4000);
}
function applyFxPanel() { fxPanel.hidden = !settings.fxPanel; }

// ---------------------------------------------------------------------------
// Parent settings: opened by a 3-second press-and-hold on the corner dot.
// ---------------------------------------------------------------------------
const dot = document.getElementById('parent-dot');
const ring = dot.querySelector('.ring-fill');
const panel = document.getElementById('settings');
const HOLD_MS = 3000;
let holdStart = 0, holdRaf = 0;
const RING_LEN = 2 * Math.PI * 22;
ring.style.strokeDasharray = RING_LEN;
ring.style.strokeDashoffset = RING_LEN;

function holdTick() {
  const p = Math.min(1, (performance.now() - holdStart) / HOLD_MS);
  ring.style.strokeDashoffset = RING_LEN * (1 - p);
  if (p >= 1) { endHold(); openSettings(); return; }
  holdRaf = requestAnimationFrame(holdTick);
}
function endHold() {
  cancelAnimationFrame(holdRaf); holdRaf = 0; holdStart = 0;
  ring.style.transition = 'stroke-dashoffset .4s ease'; ring.style.strokeDashoffset = RING_LEN;
  setTimeout(() => { ring.style.transition = ''; }, 420);
}
dot.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try { dot.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
  ring.style.transition = '';
  holdStart = performance.now(); holdRaf = requestAnimationFrame(holdTick);
});
['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => dot.addEventListener(t, () => { if (holdStart) endHold(); }));
// Keyboard / switch-access users: hold Enter or Space for the same 3 s.
dot.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !holdStart && !e.repeat) { e.preventDefault(); holdStart = performance.now(); holdRaf = requestAnimationFrame(holdTick); } });
dot.addEventListener('keyup', () => { if (holdStart) endHold(); });

let snapshot = null;
function openSettings() {
  snapshot = { ...settings };
  syncForm();
  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add('open'));
  panel.querySelector('.done').focus({ preventScroll: true });
}
function closeSettings() {
  panel.classList.remove('open');
  setTimeout(() => { panel.hidden = true; }, 250);
  const needsReload = ['theme', 'density', 'kaleidoSegments', 'motion'].some((k) => snapshot[k] !== settings[k]);
  if (snapshot.windDown !== settings.windDown) windStart = performance.now();
  saveSettings();
  applyLock();
  applyFxPanel();
  if (needsReload) reloadScene();
  else audio.setAmbient(settings.ambient && audio.ready, SCENES[currentIndex].ambient);
  if (!settings.lock) showNav();
}
panel.querySelector('.done').addEventListener('click', closeSettings);

const form = panel.querySelector('form');
function syncForm() {
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    const v = settings[el.name];
    if (el.type === 'radio') el.checked = String(v) === el.value;
    else if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  form.querySelector('[data-out="volume"]').textContent = Math.round(settings.volume * 100) + '%';
  form.querySelector('[data-out="kaleidoSegments"]').textContent = settings.kaleidoSegments;
}
form.addEventListener('submit', (e) => e.preventDefault());
form.addEventListener('input', (e) => {
  const el = e.target; const k = el.name;
  if (!(k in settings)) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (k === 'volume') v = Number(v);
  if (k === 'kaleidoSegments' || k === 'windDown') v = Number(v);
  settings[k] = v;
  if (k === 'volume') audio.setVolume(v);
  if (k === 'scale') audio.setScale(v);
  if (k === 'theme') { ctx = sceneContext(); applyThemeChrome(); }
  syncForm();
  saveSettings();
});
panel.querySelector('.reset-wind').addEventListener('click', () => { windStart = performance.now(); });

// ---------------------------------------------------------------------------
// Splash: "tap to begin" unlocks audio (iOS needs a user gesture).
// ---------------------------------------------------------------------------
const splash = document.getElementById('splash');
function begin(e) {
  e.preventDefault();
  audio.unlock();
  audio.setMuted(settings.muted);
  splash.classList.add('gone');
  setTimeout(() => splash.remove(), 900);
  audio.setAmbient(settings.ambient, SCENES[currentIndex]?.ambient || 0);
  showNav();
}
splash.addEventListener('pointerup', begin, { once: true });
splash.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') begin(e); }, { once: true });
// Safety net: any later canvas touch also (re)unlocks audio.
canvas.addEventListener('pointerdown', () => { if (!audio.ready || audio.ctx?.state !== 'running') audio.unlock(); });

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
updateMute();
applyLock();
applyFxPanel();
reducedMotionMQ.addEventListener?.('change', reloadScene);
switchTo(settings.lastScene || 0, { instant: true }).then(() => startLoop());

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e)));
}

// Small debug/test hook (harmless in production).
window.__calm = {
  switchTo, stats, renderer, audio, settings,
  get scene() { return current; }, get index() { return currentIndex; }, get switching() { return switching; },
};
