/**
 * Scene 7 — Chime Waterfall
 *
 * PHYSICS: beads are 2D circles falling through a staggered pegboard, simulated
 * in the board's own coordinates so tilting the board simply rotates gravity.
 * Each bead only tests the ≤ 9 pegs around it (grid lookup), resolves overlap
 * and reflects its normal velocity (restitution 0.45) with a tiny sideways
 * nudge so beads never balance on a peg. Beads softly push each other apart
 * (no sound), and leave through the bottom where they are recycled (pool).
 * Dragging sideways tilts the board up to ±11° on a spring; releasing lets it
 * settle back level.
 *
 * SOUND: every peg hit rings a soft chime; pitch is the peg's column on the
 * pentatonic scale (left low → right high), volume follows impact speed, pan
 * follows x. Each peg has a 120 ms cooldown and all hits share a limiter
 * (≤ 14/s), so a cascade sounds like a music box, never a clatter.
 *
 * TOUCH: touching drops a bead right there; holding pours one every ~0.3 s.
 *
 * IDLE: a bead drops quietly from the top every few seconds; pegs glow softly
 * when struck and fade back.
 */
import * as THREE from 'three';
import { makeBackdrop, clamp, visibleSize, rng, RateLimiter } from '../util.js';

const BEAD_R = 0.26;
const PEG_R = 0.2;
const MAX_TILT = 0.19;

export default class ChimeWaterfall {
  init(renderer, audio, settings) {
    this.audio = audio; this.s = settings; this.pal = settings.palette;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.set(0, 0, 20);
    this.backdrop = makeBackdrop(this.pal);
    this.scene.add(this.backdrop);
    const hemi = new THREE.HemisphereLight('#ffffff', this.pal.dark ? '#2a2060' : '#d6cfe8', this.pal.dark ? 1.3 : 1.9);
    const key = new THREE.DirectionalLight('#ffffff', 1.8); key.position.set(-4, 6, 10);
    this.scene.add(hemi, key);
    this.board = new THREE.Group();
    this.scene.add(this.board);
    this.cols6 = this.pal.colors.map((c) => new THREE.Color(c));
    this.rand = rng(3);
    this.limiter = new RateLimiter(14, 4);
    this.tilt = 0; this.tiltV = 0; this.tiltTarget = 0;
    this.pointers = [];
    this.idleT = 1.5;
    this.dummy = new THREE.Object3D();
    this.tmpC = new THREE.Color();

    // Bead pool
    const max = this.maxBeads = Math.round(70 * Math.min(1.5, this.s.densityFactor));
    this.bx = new Float32Array(max); this.by = new Float32Array(max);
    this.bvx = new Float32Array(max); this.bvy = new Float32Array(max);
    this.alive = new Uint8Array(max); this.quiet = new Uint8Array(max);
    this.bornAt = new Float32Array(max);
    const beadMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.25, metalness: 0.1, emissive: this.pal.dark ? '#1c1640' : '#000000' });
    this.beads = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 18, 12), beadMat, max);
    this.beads.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beads.frustumCulled = false;
    for (let i = 0; i < max; i++) { this.beads.setColorAt(i, this.cols6[i % this.cols6.length]); this._hide(i); }
    this.board.add(this.beads);
    this.next = 0;
    this.time = 0;
  }

  _hide(i) { this.dummy.position.set(0, 0, -50); this.dummy.scale.setScalar(0.0001); this.dummy.updateMatrix(); this.beads.setMatrixAt(i, this.dummy.matrix); }

  /** Build the peg grid for the current screen shape. */
  buildPegs() {
    if (this.pegs) { this.board.remove(this.pegs, this.plate); this.pegs.geometry.dispose(); this.pegs.material.dispose(); this.pegs.dispose(); this.plate.geometry.dispose(); this.plate.material.dispose(); }
    const portrait = this.halfW < this.halfH;
    const C = this.C = portrait ? 7 : 10;
    const R = this.R = portrait ? 11 : 7;
    const bw = this.halfW * 2 * (portrait ? 0.86 : 0.74);
    const bh = this.halfH * 2 * (portrait ? 0.7 : 0.66);
    this.sx = bw / (C - 0.5); this.sy = bh / (R - 1);
    this.x0 = -bw / 2; this.y0 = bh / 2 - this.halfH * 0.04; // top row y
    this.wallX = bw / 2 + this.sx * 0.35;
    const n = C * R;
    this.pegGlow = new Float32Array(n);
    this.pegCool = new Float32Array(n);
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35, metalness: 0.2, emissive: this.pal.dark ? '#2a2458' : '#000000' });
    this.pegs = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 10), mat, n);
    this.pegs.frustumCulled = false;
    this.pegBase = [];
    for (let r = 0, i = 0; r < R; r++) for (let c = 0; c < C; c++, i++) {
      const col = this.cols6[c % this.cols6.length].clone().lerp(new THREE.Color(this.pal.dark ? '#8890c0' : this.pal.ink), 0.45);
      this.pegBase.push(col);
      this.pegs.setColorAt(i, col);
      this.dummy.position.set(this.pegX(r, c), this.pegY(r), 0); this.dummy.scale.setScalar(PEG_R); this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix(); this.pegs.setMatrixAt(i, this.dummy.matrix);
    }
    this.pegs.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.board.add(this.pegs);
    // A faint back plate so the board reads as one object when it tilts.
    const plateMat = new THREE.MeshBasicMaterial({ color: this.pal.dark ? '#ffffff' : this.pal.ink, transparent: true, opacity: this.pal.dark ? 0.035 : 0.06, depthWrite: false });
    this.plate = new THREE.Mesh(new THREE.PlaneGeometry(this.wallX * 2, bh + this.sy * 1.6), plateMat);
    this.plate.position.set(0, this.y0 - bh / 2, -0.6);
    this.board.add(this.plate);
  }
  pegX(r, c) { return this.x0 + c * this.sx + (r & 1 ? this.sx * 0.5 : 0); }
  pegY(r) { return this.y0 - r * this.sy; }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.backdrop.material.uniforms.uAspect.value = w / h;
    const v = visibleSize(this.camera, 20);
    this.halfW = v.w / 2; this.halfH = v.h / 2;
    this.buildPegs();
    this.alive.fill(0);
    for (let i = 0; i < this.maxBeads; i++) this._hide(i);
  }

  /** Spawn a bead at board-local (x, y). */
  spawn(x, y, quiet = false) {
    let i = -1;
    for (let k = 0; k < this.maxBeads; k++) { const j = (this.next + k) % this.maxBeads; if (!this.alive[j]) { i = j; break; } }
    if (i < 0) { // recycle the oldest bead
      let oldest = 1e9; for (let j = 0; j < this.maxBeads; j++) if (this.bornAt[j] < oldest) { oldest = this.bornAt[j]; i = j; }
    }
    this.next = (i + 1) % this.maxBeads;
    this.alive[i] = 1; this.quiet[i] = quiet ? 1 : 0; this.bornAt[i] = this.time;
    this.bx[i] = clamp(x, -this.wallX + BEAD_R, this.wallX - BEAD_R); this.by[i] = y;
    this.bvx[i] = (this.rand() - 0.5) * 0.3; this.bvy[i] = 0;
  }

  /** Screen → board-local coordinates (undo the tilt). */
  _local(p, out) {
    const wx = p.nx * this.halfW, wy = p.ny * this.halfH;
    const c = Math.cos(-this.tilt), s = Math.sin(-this.tilt);
    out.x = wx * c - wy * s; out.y = wx * s + wy * c;
    return out;
  }

  onPointerDown(p) {
    p.data = { x: 0, y: 0, pour: 0, tilting: false };
    this._local(p, p.data);
    this.spawn(p.data.x, Math.min(p.data.y, this.y0 + this.sy * 0.8));
    this.pointers.push(p);
    this.audio.bubble(this.audio.freq(this.audio.stepFromUnit((p.nx + 1) / 2, 8, 16)), 0.2, p.nx * 0.6);
  }
  onPointerMove(p) {
    if (!p.data) return;
    if (Math.abs(p.x - p.startX) > 24) p.data.tilting = true;
    this._local(p, p.data);
  }
  onPointerUp(p) { const i = this.pointers.indexOf(p); if (i >= 0) this.pointers.splice(i, 1); }

  update(dt, time) {
    this.time = time;
    // Tilt follows the sideways drag of the first tilting finger (spring).
    const tp = this.pointers.find((q) => q.data && q.data.tilting);
    this.tiltTarget = tp ? clamp((tp.x - tp.startX) / 320, -1, 1) * -MAX_TILT : 0;
    this.tiltV += (40 * (this.tiltTarget - this.tilt) - 9 * this.tiltV) * dt;
    this.tilt += this.tiltV * dt;
    this.board.rotation.z = this.tilt;

    // Pour while holding still.
    for (const p of this.pointers) {
      if (p.data.tilting) continue;
      p.data.pour += dt;
      if (p.data.pour > 0.3) { p.data.pour = 0; this.spawn(p.data.x, Math.min(p.data.y, this.y0 + this.sy * 0.8)); }
    }
    // Idle: a quiet bead from the top now and then.
    this.idleT -= dt;
    if (this.idleT < 0) {
      this.idleT = 2.6 + this.rand() * 1.5;
      this.spawn(this.x0 + this.rand() * (this.C - 1) * this.sx, this.y0 + this.sy * 0.9, true);
    }

    const g = 9;
    const gx = -g * Math.sin(this.tilt), gy = -g * Math.cos(this.tilt);
    const { bx, by, bvx, bvy, alive, C, R, sx, sy } = this;
    const minD = BEAD_R + PEG_R;
    const now = performance.now() / 1000;
    const steps = 2, h = dt / steps;
    for (let st = 0; st < steps; st++) {
      for (let i = 0; i < this.maxBeads; i++) {
        if (!alive[i]) continue;
        bvx[i] += gx * h; bvy[i] += gy * h;
        bvx[i] *= 0.999; bvy[i] *= 0.999;
        bx[i] += bvx[i] * h; by[i] += bvy[i] * h;
        // walls
        if (bx[i] < -this.wallX + BEAD_R) { bx[i] = -this.wallX + BEAD_R; bvx[i] = Math.abs(bvx[i]) * 0.4; }
        if (bx[i] > this.wallX - BEAD_R) { bx[i] = this.wallX - BEAD_R; bvx[i] = -Math.abs(bvx[i]) * 0.4; }
        // pegs near this bead
        const r0 = Math.round((this.y0 - by[i]) / sy);
        for (let r = r0 - 1; r <= r0 + 1; r++) {
          if (r < 0 || r >= R) continue;
          const off = r & 1 ? sx * 0.5 : 0;
          const c0 = Math.round((bx[i] - this.x0 - off) / sx);
          for (let c = c0 - 1; c <= c0 + 1; c++) {
            if (c < 0 || c >= C) continue;
            const px = this.x0 + c * sx + off, py = this.y0 - r * sy;
            const dx = bx[i] - px, dy = by[i] - py, d2 = dx * dx + dy * dy;
            if (d2 >= minD * minD) continue;
            const d = Math.sqrt(d2) || 1e-4, nx = dx / d, ny = dy / d;
            bx[i] = px + nx * minD; by[i] = py + ny * minD;
            const vn = bvx[i] * nx + bvy[i] * ny;
            if (vn < 0) {
              bvx[i] -= 1.45 * vn * nx; bvy[i] -= 1.45 * vn * ny;
              bvx[i] += (i & 1 ? 0.25 : -0.25) * (1 - Math.abs(nx)); // never balance on top
              const k = r * C + c;
              this.pegGlow[k] = Math.min(1, this.pegGlow[k] + clamp(-vn / 6, 0.25, 1));
              if (-vn > 0.8 && now - this.pegCool[k] > 0.12 && this.limiter.take(now)) {
                this.pegCool[k] = now;
                const step = this.audio.stepFromUnit(c / (C - 1), 6, 17);
                const vel = clamp(-vn / 9, 0.08, 0.6) * (this.quiet[i] ? 0.45 : 1);
                this.audio.chime(this.audio.freq(step), vel, clamp(px / this.halfW, -1, 1) * 0.7, 0.3, 1.1);
              }
            }
          }
        }
        if (by[i] < -this.halfH - 1.5) { alive[i] = 0; this._hide(i); }
      }
    }
    // gentle bead–bead separation (silent)
    for (let i = 0; i < this.maxBeads; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < this.maxBeads; j++) {
        if (!alive[j]) continue;
        const dx = bx[j] - bx[i], dy = by[j] - by[i], d2 = dx * dx + dy * dy, m = BEAD_R * 2;
        if (d2 >= m * m || d2 < 1e-8) continue;
        const d = Math.sqrt(d2), push = (m - d) * 0.5, nx = dx / d, ny = dy / d;
        bx[i] -= nx * push; by[i] -= ny * push; bx[j] += nx * push; by[j] += ny * push;
        const rv = (bvx[j] - bvx[i]) * nx + (bvy[j] - bvy[i]) * ny;
        if (rv < 0) { bvx[i] += rv * nx * 0.5; bvy[i] += rv * ny * 0.5; bvx[j] -= rv * nx * 0.5; bvy[j] -= rv * ny * 0.5; }
      }
    }

    // write beads
    const o = this.dummy;
    for (let i = 0; i < this.maxBeads; i++) {
      if (!alive[i]) continue;
      const age = time - this.bornAt[i];
      o.position.set(bx[i], by[i], 0); o.rotation.set(0, 0, 0);
      o.scale.setScalar(BEAD_R * Math.min(1, age * 6 + 0.2));
      o.updateMatrix(); this.beads.setMatrixAt(i, o.matrix);
    }
    this.beads.instanceMatrix.needsUpdate = true;
    // peg glow fades back slowly
    const fade = Math.exp(-dt * 2.2);
    const white = this.pal.dark ? 1 : 0.9;
    for (let k = 0; k < this.pegGlow.length; k++) {
      if (this.pegGlow[k] < 0.002) continue;
      this.pegGlow[k] *= fade;
      const c = this.tmpC.copy(this.pegBase[k]).lerp(this.cols6[(k % C) % this.cols6.length], Math.min(1, this.pegGlow[k] * 1.5));
      c.r = Math.min(1, c.r + this.pegGlow[k] * 0.35 * white); c.g = Math.min(1, c.g + this.pegGlow[k] * 0.35 * white); c.b = Math.min(1, c.b + this.pegGlow[k] * 0.35 * white);
      this.pegs.setColorAt(k, c);
    }
    this.pegs.instanceColor.needsUpdate = true;
  }

  dispose() { this.pointers.length = 0; }
}
