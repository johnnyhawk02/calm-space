/**
 * Scene 5 — Squishy Clay
 *
 * PHYSICS: a sphere of soft "clay" with two layers of deformation per vertex:
 *   • an elastic offset E (with velocity) on a lightly damped spring, so every
 *     prod squishes and wobbles back;
 *   • a plastic offset P that slowly takes over the elastic shape while a
 *     finger keeps holding, so held pushes and pulls stay moulded in.
 * A finger that lands on the clay grabs a smooth Gaussian patch of the surface.
 * Holding it still presses a dimple in (deeper the longer you hold, with a soft
 * raised rim); dragging pulls the patch out after the finger, up to about one
 * radius. On release the elastic part springs back with a wobble and the
 * moulded part stays. The plastic shape very slowly relaxes (half-life ~3 min)
 * and the round button smooths it back to a ball. All buffers are preallocated
 * (grab slots, per-grab weights); seam vertices share normals so the sphere
 * never shows a crease.
 *
 * ROTATION: hold the arrow buttons on the left to turn the clay, or drag on
 * the empty space around it. It turns very slowly by itself when left alone.
 *
 * SOUND: prods give low "squish" tones (pitch from where on screen); pulling
 * fades in a warm pad whose note climbs the pentatonic scale as the clay
 * stretches; letting go gives a soft low bloop. Rotate buttons tick softly
 * (marimba), the round button rings a gentle bell.
 */
import * as THREE from 'three';
import { makeBackdrop, ndcRay, clamp, visibleSize, RateLimiter } from '../util.js';

const MAX_GRABS = 5;
const K = 55, C = 3.2;          // elastic spring (under-damped → squishy wobble)
const KG = 320;                 // how firmly a finger holds its patch
const SIGMA = 0.32, SIGMA2 = 0.75;
const MOULD_RATE = 1.1;         // elastic → plastic transfer per second while held
const RELAX = 1 / 260;          // slow return of the moulded shape

const ICONS = {
  up: '<path d="M18 9v18M10 16l8-8 8 8"/>',
  down: '<path d="M18 27V9M10 20l8 8 8-8"/>',
  left: '<path d="M27 18H9M16 10l-8 8 8 8"/>',
  right: '<path d="M9 18h18M20 10l8 8-8 8"/>',
  round: '<circle cx="18" cy="18" r="9"/><path d="M18 5v3M18 28v3"/>',
};

export default class SquishyClay {
  init(renderer, audio, settings) {
    this.audio = audio; this.s = settings; this.pal = settings.palette;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.camera.position.set(0, 0.4, 13);
    this.camera.lookAt(0, 0, 0);
    this.backdrop = makeBackdrop(this.pal);
    this.scene.add(this.backdrop);
    const hemi = new THREE.HemisphereLight('#ffffff', this.pal.dark ? '#2a2060' : '#d8d0ea', this.pal.dark ? 1.2 : 1.7);
    const key = new THREE.DirectionalLight('#ffffff', 2.2); key.position.set(-5, 7, 8);
    const rim = new THREE.DirectionalLight(this.pal.dark ? '#a9b8ff' : '#ffffff', 1.0); rim.position.set(6, -3, -4);
    this.scene.add(hemi, key, rim);

    // ---- geometry & state -------------------------------------------------
    const seg = this.s.density === 'low' ? 64 : this.s.density === 'high' ? 112 : 88;
    const geo = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.75));
    const n = this.n = geo.attributes.position.count;
    this.rest = Float32Array.from(geo.attributes.position.array);
    this.P = new Float32Array(n * 3); this.E = new Float32Array(n * 3); this.V = new Float32Array(n * 3);
    this.pos = geo.attributes.position.array;
    geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
    geo.attributes.normal.setUsage(THREE.DynamicDrawUsage);
    this.cols = new Float32Array(n * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(this.cols, 3).setUsage(THREE.DynamicDrawUsage));
    // Seam / pole duplicates share one "canonical" vertex so their normals match.
    this.canon = new Int32Array(n);
    const seen = new Map();
    for (let i = 0; i < n; i++) {
      const k = `${this.rest[i * 3].toFixed(4)},${this.rest[i * 3 + 1].toFixed(4)},${this.rest[i * 3 + 2].toFixed(4)}`;
      if (seen.has(k)) this.canon[i] = seen.get(k); else { seen.set(k, i); this.canon[i] = i; }
    }
    this.nAcc = new Float32Array(n * 3);
    this.base = new THREE.Color(this.pal.colors[this.pal.dark ? 2 : 0]);
    this.light = this.base.clone().lerp(new THREE.Color('#ffffff'), 0.45);
    this.mat = new THREE.MeshPhysicalMaterial({
      color: '#ffffff', vertexColors: true, roughness: 0.55, metalness: 0,
      sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color('#ffffff'), clearcoat: 0.15, clearcoatRoughness: 0.6,
    });
    this.clay = new THREE.Mesh(geo, this.mat);
    this.clay.frustumCulled = false;
    this.root = new THREE.Group();
    this.root.add(this.clay);
    this.scene.add(this.root);

    // Soft contact glow/shadow under the clay.
    const shadowMat = new THREE.ShaderMaterial({
      uniforms: { c: { value: new THREE.Color(this.pal.dark ? this.pal.colors[2] : '#5a5480') }, a: { value: this.pal.dark ? 0.16 : 0.16 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} ',
      fragmentShader: 'uniform vec3 c; uniform float a; varying vec2 vUv; void main(){ float d=length(vUv-0.5)*2.0; gl_FragColor=vec4(c, a*pow(1.0-clamp(d,0.0,1.0),2.0)); \n#include <colorspace_fragment>\n }',
      transparent: true, depthWrite: false, blending: this.pal.dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
    this.shadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.shadow);

    // Grab slots (preallocated).
    this.grabs = Array.from({ length: MAX_GRABS }, () => ({
      active: false, owner: null, idx: new Int32Array(n), count: 0,
      w: new Float32Array(n), w2: new Float32Array(n), p0: new Float32Array(n * 3),
      H: new THREE.Vector3(), N: new THREE.Vector3(), viewN: new THREE.Vector3(), D: new THREE.Vector3(),
      t0: 0, pad: null, step: 0,
    }));

    this.q = new THREE.Quaternion();
    this.qd = new THREE.Quaternion();
    this.spin = new THREE.Vector3();       // angular velocity (world, rad/s)
    this.spinTarget = new THREE.Vector3();
    this.axis = new THREE.Vector3();
    this.tmp = new THREE.Vector3(); this.o = new THREE.Vector3(); this.d = new THREE.Vector3();
    this.inv = new THREE.Quaternion();
    this.rotators = [];
    this.quietT = 0;
    this.resetT = 0;
    this.dirty = 30;
    this.limiter = new RateLimiter(5, 2);
    this.radius = 3;
    this.buildControls();
    this.refreshGeometry(true);
  }

  // ---- on-screen rotate controls -----------------------------------------
  buildControls() {
    const pad = this.pad = document.createElement('div');
    pad.id = 'rotpad';
    pad.setAttribute('aria-label', 'Turn the clay');
    const defs = [
      ['up', 'Turn up', [-1, 0, 0]], ['left', 'Turn left', [0, -1, 0]], ['round', 'Make it round again', null],
      ['right', 'Turn right', [0, 1, 0]], ['down', 'Turn down', [1, 0, 0]],
    ];
    for (const [key, label, ax] of defs) {
      const b = document.createElement('button');
      b.className = 'icon-btn';
      b.setAttribute('aria-label', label);
      b.innerHTML = `<svg viewBox="0 0 36 36">${ICONS[key]}</svg>`;
      if (ax) {
        const v = new THREE.Vector3(...ax);
        const start = (e) => { e.preventDefault(); this.rotators.push(v); this._spinTarget(); this.quietT = 0; this.audio.marimba(this.audio.freq(ax[1] ? 7 : 9), 0.22, ax[1] * 0.5, 0.2); };
        const stop = () => { const i = this.rotators.indexOf(v); if (i >= 0) { this.rotators.splice(i, 1); this._spinTarget(); } };
        b.addEventListener('pointerdown', start);
        ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => b.addEventListener(t, stop));
        b.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) start(e); });
        b.addEventListener('keyup', stop);
      } else {
        b.addEventListener('click', () => { this.resetT = 2.5; this.audio.chime(this.audio.freq(10), 0.3, 0, 0.3, 1.8); });
      }
      pad.appendChild(b);
    }
    document.body.appendChild(pad);
  }
  _spinTarget() {
    this.spinTarget.set(0, 0, 0);
    for (const v of this.rotators) this.spinTarget.addScaledVector(v, 1.3);
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.backdrop.material.uniforms.uAspect.value = w / h;
    const vis = visibleSize(this.camera, 13);
    this.radius = Math.min(vis.w, vis.h) * 0.24;
    this.shadow.scale.set(this.radius * 2.8, this.radius * 1.4, 1);
    this.shadow.position.set(0, -this.radius * 1.35, 0);
  }

  // ---- input ---------------------------------------------------------------

  /** Pointer ray in the clay's local (unscaled, unrotated) space. */
  _localRay(p) {
    const ray = ndcRay(this.camera, p.nx, p.ny);
    this.inv.copy(this.root.quaternion).invert();
    const s = this.root.scale.x;
    this.o.copy(ray.origin).sub(this.root.position).applyQuaternion(this.inv).divideScalar(s);
    this.d.copy(ray.direction).applyQuaternion(this.inv).normalize();
  }

  /** Nearest front-facing surface vertex under the finger, or -1. */
  _hit() {
    const { pos, n, o, d } = this;
    let best = -1, bestT = Infinity;
    for (let i = 0; i < n; i++) {
      const qx = pos[i * 3] - o.x, qy = pos[i * 3 + 1] - o.y, qz = pos[i * 3 + 2] - o.z;
      const t = qx * d.x + qy * d.y + qz * d.z;
      if (t >= bestT) continue;
      const px = qx - t * d.x, py = qy - t * d.y, pz = qz - t * d.z;
      if (px * px + py * py + pz * pz < 0.016) { best = i; bestT = t; }
    }
    return best;
  }

  onPointerDown(p) {
    this.quietT = 0;
    this._localRay(p);
    const hit = this._hit();
    p.data = { grab: null, lx: p.x, ly: p.y };
    if (hit < 0) return; // empty space: dragging rotates (see onPointerMove)
    const g = this.grabs.find((q) => !q.active);
    if (!g) return;
    const { pos, n, P } = this;
    g.active = true; g.owner = p; g.t0 = performance.now() / 1000; g.D.set(0, 0, 0); g.step = 0;
    g.H.set(pos[hit * 3], pos[hit * 3 + 1], pos[hit * 3 + 2]);
    const nrm = this.clay.geometry.attributes.normal.array;
    g.N.set(nrm[hit * 3], nrm[hit * 3 + 1], nrm[hit * 3 + 2]).normalize();
    g.viewN.copy(this.d);
    // Gaussian patch around the hit point (and a wider ring for the soft rim).
    let c = 0;
    const i1 = 1 / (2 * SIGMA * SIGMA), i2 = 1 / (2 * SIGMA2 * SIGMA2);
    for (let i = 0; i < n; i++) {
      const dx = pos[i * 3] - g.H.x, dy = pos[i * 3 + 1] - g.H.y, dz = pos[i * 3 + 2] - g.H.z;
      const dd = dx * dx + dy * dy + dz * dz;
      const w2 = Math.exp(-dd * i2);
      if (w2 < 0.003) continue;
      g.idx[c++] = i;
      g.w[i] = Math.exp(-dd * i1); g.w2[i] = w2;
      g.p0[i * 3] = P[i * 3]; g.p0[i * 3 + 1] = P[i * 3 + 1]; g.p0[i * 3 + 2] = P[i * 3 + 2];
    }
    g.count = c;
    p.data.grab = g;
    const up = clamp((p.ny + 1) / 2, 0, 1);
    this.audio.squish(this.audio.freq(this.audio.stepFromUnit(up, -4, 5)), 0.55, p.nx * 0.6, 0.35);
  }

  onPointerMove(p) {
    if (!p.data) return;
    this.quietT = 0;
    const g = p.data.grab;
    if (g && g.owner === p) {
      // Intersect the finger ray with the view-facing plane through the grab point.
      this._localRay(p);
      const { o, d } = this, N = g.viewN;
      const den = d.dot(N);
      if (Math.abs(den) < 1e-4) return;
      const t = this.tmp.copy(g.H).sub(o).dot(N) / den;
      g.D.copy(o).addScaledVector(d, t).sub(g.H);
      if (g.D.length() > 1.1) g.D.setLength(1.1);
    } else if (!g) {
      // Drag on empty space turns the clay (trackball).
      const dx = p.x - p.data.lx, dy = p.y - p.data.ly;
      p.data.lx = p.x; p.data.ly = p.y;
      const ang = Math.hypot(dx, dy) * 0.006;
      if (ang > 0) {
        this.axis.set(dy, dx, 0).normalize();
        this.qd.setFromAxisAngle(this.axis, ang);
        this.root.quaternion.premultiply(this.qd);
        this.spin.copy(this.axis).multiplyScalar(Math.min(3, ang * 30));
      }
    }
  }

  onPointerUp(p) {
    if (!p.data) return;
    const g = p.data.grab;
    if (g && g.owner === p) {
      const stretch = g.D.length();
      g.active = false; g.owner = null;
      if (g.pad) { g.pad.stop(0.5); g.pad = null; }
      this.audio.bubble(this.audio.freq(this.audio.stepFromUnit(clamp(0.3 + stretch * 0.5, 0, 1), -2, 6)), 0.35, p.nx * 0.6);
    }
  }

  // ---- simulation ----------------------------------------------------------

  update(dt, time) {
    const { n, P, E, V } = this;
    // Rotation: buttons / fling momentum / slow idle turn.
    this.quietT += dt;
    const idle = this.rotators.length === 0 && this.quietT > 3 && !this.s.reducedMotion ? 0.07 : 0;
    const k = 1 - Math.exp(-dt * (this.rotators.length ? 6 : 2.5));
    this.spin.x += (this.spinTarget.x - this.spin.x) * k;
    this.spin.y += (this.spinTarget.y + idle - this.spin.y) * k;
    this.spin.z += (this.spinTarget.z - this.spin.z) * k;
    const sp = this.spin.length();
    if (sp > 1e-4) { this.qd.setFromAxisAngle(this.axis.copy(this.spin).divideScalar(sp), sp * dt); this.root.quaternion.premultiply(this.qd); }

    // Elastic springs.
    let active = false;
    for (let i = 0; i < n * 3; i++) {
      V[i] += (-K * E[i] - C * V[i]) * dt;
    }
    // Fingers: pull each grabbed patch towards its target and mould it in.
    const now = performance.now() / 1000;
    for (const g of this.grabs) {
      if (!g.active) continue;
      active = true;
      const held = now - g.t0, dl = g.D.length();
      const press = (1 - Math.min(1, dl / 0.35)) * Math.min(0.34, 0.1 + held * 0.16) * (0.8 + g.owner.pressure * 0.4);
      const tx = g.D.x - g.N.x * press, ty = g.D.y - g.N.y * press, tz = g.D.z - g.N.z * press;
      const mould = MOULD_RATE * dt;
      for (let c = 0; c < g.count; c++) {
        const i = g.idx[c], w = g.w[i], rim = (g.w2[i] - w) * press * 0.35;
        const r0x = this.rest[i * 3], r0y = this.rest[i * 3 + 1], r0z = this.rest[i * 3 + 2];
        for (let a = 0; a < 3; a++) {
          const j = i * 3 + a;
          const target = g.p0[j] + w * (a === 0 ? tx : a === 1 ? ty : tz) + rim * (a === 0 ? r0x : a === 1 ? r0y : r0z);
          const wantE = target - P[j];
          V[j] += KG * w * (wantE - E[j]) * dt;
          const m = E[j] * w * mould; P[j] += m; E[j] -= m;
        }
      }
      // Pulling hum: a warm pad climbing the scale as the clay stretches.
      const step = Math.round(dl * 6);
      if (dl > 0.08) {
        if (!g.pad || !g.pad.alive) g.pad = this.audio.pad('warm', this.audio.freq(-3));
        g.pad.set(Math.min(0.8, dl * 1.1), 0.12 + dl * 0.5, this.audio.freq(-3 + step), g.owner.nx * 0.6);
      } else if (g.pad) g.pad.set(0, 0.1);
      if (step !== g.step && dl > 0.08 && this.limiter.take(now)) this.audio.squish(this.audio.freq(-3 + step + 5), 0.18, g.owner.nx * 0.6, 0.3);
      g.step = step;
    }
    let energy = 0;
    const relax = Math.exp(-dt * (this.resetT > 0 ? 2.2 : RELAX));
    if (this.resetT > 0) this.resetT -= dt;
    for (let i = 0; i < n * 3; i++) {
      E[i] += V[i] * dt;
      P[i] *= relax;
      energy += Math.abs(V[i]);
    }
    if (energy / n > 0.0005 || active || this.resetT > 0) this.dirty = 2;
    if (this.dirty > 0 || (time * 2 | 0) !== this.lastRelax) { this.refreshGeometry(); this.dirty--; this.lastRelax = time * 2 | 0; }

    const breathe = this.s.reducedMotion ? 0 : Math.sin(time * 0.7) * 0.012;
    this.root.scale.setScalar(this.radius * (1 + breathe));
  }

  /** Write positions, colours and seam-consistent normals. */
  refreshGeometry(force) {
    const { n, rest, P, E, pos, cols, canon, nAcc } = this;
    const b = this.base, l = this.light;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const ox = P[j] + E[j], oy = P[j + 1] + E[j + 1], oz = P[j + 2] + E[j + 2];
      pos[j] = rest[j] + ox; pos[j + 1] = rest[j + 1] + oy; pos[j + 2] = rest[j + 2] + oz;
      const t = Math.min(1, Math.sqrt(ox * ox + oy * oy + oz * oz) * 1.4); // stretched / pressed clay looks lighter
      cols[j] = b.r + (l.r - b.r) * t; cols[j + 1] = b.g + (l.g - b.g) * t; cols[j + 2] = b.b + (l.b - b.b) * t;
    }
    const geo = this.clay.geometry;
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal.array;
    nAcc.fill(0);
    for (let i = 0; i < n; i++) { const c = canon[i] * 3, j = i * 3; nAcc[c] += nrm[j]; nAcc[c + 1] += nrm[j + 1]; nAcc[c + 2] += nrm[j + 2]; }
    for (let i = 0; i < n; i++) {
      const c = canon[i] * 3, j = i * 3;
      const x = nAcc[c], y = nAcc[c + 1], z = nAcc[c + 2], il = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
      nrm[j] = x * il; nrm[j + 1] = y * il; nrm[j + 2] = z * il;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    if (force) geo.computeBoundingSphere();
  }

  dispose() {
    for (const g of this.grabs) if (g.pad) g.pad.stop();
    if (this.pad) this.pad.remove();
  }
}
