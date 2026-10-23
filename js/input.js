/**
 * input.js — unified multitouch / pointer handling.
 *
 * Tracks up to MAX_POINTERS simultaneous pointers (touch, pen or mouse) using
 * Pointer Events. Each pointer is a pooled, reused object (no per-event
 * allocation) carrying:
 *   x, y        CSS pixels          nx, ny   normalised device coords (-1..1, y up)
 *   vx, vy      smoothed px/second  speed    |v| in px/s
 *   pressure    0..1 (0.5 when the device does not report pressure)
 *   colorIndex  a stable 0..4 slot so scenes can give each finger its own colour
 *   downTime, startX, startY, travel (total px moved)
 */

const MAX_POINTERS = 10;

class Pointer {
  constructor() { this.reset(); }
  reset() {
    this.id = -1; this.active = false; this.type = 'touch';
    this.x = 0; this.y = 0; this.nx = 0; this.ny = 0; this.px = 0; this.py = 0;
    this.vx = 0; this.vy = 0; this.speed = 0; this.pressure = 0.5;
    this.colorIndex = 0; this.downTime = 0; this.lastT = 0;
    this.startX = 0; this.startY = 0; this.travel = 0;
    this.data = null; // free slot for scenes to hang per-finger state on
  }
}

export class Input {
  /**
   * @param {HTMLElement} el  element receiving events (the canvas)
   * @param {{down:Function, move:Function, up:Function}} handlers
   */
  constructor(el, handlers) {
    this.el = el;
    this.h = handlers;
    this.pool = Array.from({ length: MAX_POINTERS }, () => new Pointer());
    this.map = new Map();
    this.list = []; // active pointers, in down order
    this.w = window.innerWidth; this.h2 = window.innerHeight;

    this._down = this._down.bind(this);
    this._move = this._move.bind(this);
    this._up = this._up.bind(this);
    el.addEventListener('pointerdown', this._down);
    el.addEventListener('pointermove', this._move);
    el.addEventListener('pointerup', this._up);
    el.addEventListener('pointercancel', this._up);
    el.addEventListener('lostpointercapture', this._up);
  }

  resize(w, h) { this.w = w; this.h2 = h; }

  _set(p, e) {
    p.x = e.clientX; p.y = e.clientY;
    p.nx = (p.x / this.w) * 2 - 1;
    p.ny = -((p.y / this.h2) * 2 - 1);
    // Touch pressure is often reported as 0 or a constant; treat that as "medium".
    p.pressure = e.pressure > 0 && e.pressure !== 0.5 ? e.pressure : 0.5;
  }

  _down(e) {
    e.preventDefault();
    if (this.map.has(e.pointerId) || this.list.length >= MAX_POINTERS) return;
    const p = this.pool.find((q) => !q.active);
    if (!p) return;
    p.reset();
    p.active = true; p.id = e.pointerId; p.type = e.pointerType || 'touch';
    this._set(p, e);
    p.px = p.x; p.py = p.y; p.startX = p.x; p.startY = p.y;
    p.downTime = p.lastT = e.timeStamp / 1000;
    // Lowest free colour slot, so finger colours stay stable and predictable.
    const used = new Set(this.list.map((q) => q.colorIndex));
    let ci = 0; while (used.has(ci)) ci++;
    p.colorIndex = ci % 5;
    this.map.set(e.pointerId, p);
    this.list.push(p);
    try { this.el.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    this.h.down(p);
  }

  _move(e) {
    const p = this.map.get(e.pointerId);
    if (!p) return;
    const t = e.timeStamp / 1000;
    const dt = Math.max(0.001, t - p.lastT);
    p.px = p.x; p.py = p.y;
    this._set(p, e);
    const dx = p.x - p.px, dy = p.y - p.py;
    p.travel += Math.hypot(dx, dy);
    // Exponentially smoothed velocity (time constant ~40 ms) — stable under jittery input.
    const a = 1 - Math.exp(-dt / 0.04);
    p.vx += (dx / dt - p.vx) * a;
    p.vy += (dy / dt - p.vy) * a;
    p.speed = Math.hypot(p.vx, p.vy);
    p.lastT = t;
    this.h.move(p);
  }

  _up(e) {
    const p = this.map.get(e.pointerId);
    if (!p) return;
    this.map.delete(e.pointerId);
    this.list.splice(this.list.indexOf(p), 1);
    this.h.up(p);
    p.active = false;
  }

  /** Called once per frame: decays velocity of fingers that are held still (no move events). */
  update(dt) {
    const now = performance.now() / 1000;
    for (const p of this.list) {
      if (now - p.lastT > 0.05) {
        const k = Math.exp(-dt / 0.06);
        p.vx *= k; p.vy *= k; p.speed = Math.hypot(p.vx, p.vy);
      }
    }
  }

  /** Release everything (e.g. when switching scenes or hiding the page). */
  cancelAll() {
    for (const p of [...this.list]) { this.h.up(p); p.active = false; }
    this.map.clear(); this.list.length = 0;
  }
}
