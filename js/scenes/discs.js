/**
 * Scene 1 — Disc Field
 *
 * PHYSICS: a lattice of soft discs lying on a gently tilted plane. Every disc
 * has a 3D displacement (x, y, z) and a 2-axis tilt, each held by a damped
 * spring (slightly under-damped, so it wobbles before settling). Neighbouring
 * discs are coupled with a discrete Laplacian (mass–spring lattice): a pushed
 * disc tugs and bumps its neighbours, so pushes travel outward as soft waves.
 * Fingers apply a radial push with a smooth (1-d/R)² falloff, press discs down
 * in z and tilt them away. All state lives in typed arrays; matrices are
 * written straight into the InstancedMesh buffer (no per-frame allocation).
 *
 * SOUND: soft FM chimes. Pitch follows the column under the finger (left = low,
 * right = high, on the shared pentatonic scale), brightness follows the row,
 * volume follows push strength (finger speed), pan follows x. Notes fire when
 * the finger enters a new disc, through a token-bucket limiter (≈12 notes/s),
 * so a fast swipe becomes a shimmer rather than noise.
 *
 * IDLE: a very slow travelling swell lifts the discs, and their glow breathes.
 */
import * as THREE from 'three';
import { makeBackdrop, ndcToPlane, RateLimiter, clamp } from '../util.js';

const K = 42;       // position spring stiffness
const C = 3.4;      // position damping (under-damped → gentle wobble)
const KC = 22;      // neighbour coupling
const KT = 55;      // tilt spring
const CT = 3.6;     // tilt damping

export default class DiscField {
  init(renderer, audio, settings) {
    this.audio = audio; this.s = settings; this.pal = settings.palette;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
    this.camBase = new THREE.Vector3(0, -8, 21);
    this.camera.position.copy(this.camBase);
    this.camera.lookAt(0, 0, 0);
    this.backdrop = makeBackdrop(this.pal);
    this.scene.add(this.backdrop);
    this.plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this.tmp = new THREE.Vector3();
    this.limiter = new RateLimiter(12, 3);
    this.pointers = [];
    this.time = 0;
    this.mesh = null;
  }

  /** (Re)build the lattice so it covers the visible plane for the current aspect. */
  build() {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.dispose(); }
    // Find the visible region of the z=0 plane by casting the 4 screen corners.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [nx, ny] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      if (!ndcToPlane(this.camera, nx, ny, this.plane, this.tmp)) continue;
      minX = Math.min(minX, this.tmp.x); maxX = Math.max(maxX, this.tmp.x);
      minY = Math.min(minY, this.tmp.y); maxY = Math.max(maxY, this.tmp.y);
    }
    const target = Math.round(560 * this.s.densityFactor);
    const sp = Math.sqrt(((maxX - minX) * (maxY - minY)) / target);
    const cols = Math.ceil((maxX - minX) / sp) + 2;
    const rows = Math.ceil((maxY - minY) / (sp * 0.88)) + 2;
    const n = cols * rows;
    Object.assign(this, { sp, cols, rows, n, x0: minX - sp * 0.5, y0: minY - sp * 0.5, rowH: sp * 0.88 });

    const f32 = () => new Float32Array(n);
    this.bx = f32(); this.by = f32();
    this.dx = f32(); this.dy = f32(); this.dz = f32();
    this.vx = f32(); this.vy = f32(); this.vz = f32();
    this.ax = f32(); this.ay = f32(); this.az = f32();
    this.tx = f32(); this.ty = f32(); this.wx = f32(); this.wy = f32();
    this.energy = f32();
    this.nb = new Int32Array(n * 4);

    const radius = sp * 0.36;
    const quad = radius * 2 * 1.6; // quad is larger than the disc to leave room for the halo
    const geo = new THREE.PlaneGeometry(quad, quad);
    const energyAttr = new THREE.InstancedBufferAttribute(this.energy, 1);
    energyAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aEnergy', energyAttr);

    const mat = new THREE.ShaderMaterial({
      uniforms: { uGlow: { value: this.pal.glow ? 1 : 0 }, uContrast: { value: this.pal.contrast ? 1 : 0 } },
      vertexShader: /* glsl */`
        attribute float aEnergy;
        varying vec2 vUv; varying vec3 vN; varying vec3 vCol; varying float vE;
        void main() {
          vUv = uv; vE = aEnergy; vCol = instanceColor;
          vN = normalize(mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0));
          gl_Position = projectionMatrix * viewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float uGlow; uniform float uContrast;
        varying vec2 vUv; varying vec3 vN; varying vec3 vCol; varying float vE;
        void main() {
          float d = length(vUv - 0.5) * 2.0 * 1.6;       // 1.0 = disc edge
          vec3 L = normalize(vec3(-0.45, 0.6, 0.75));
          vec3 V = normalize(vec3(0.0, -0.35, 0.94));
          vec3 N = normalize(vN);
          float lam = clamp(dot(N, L), 0.0, 1.0);
          float spec = pow(clamp(dot(N, normalize(L + V)), 0.0, 1.0), 40.0);
          float body = smoothstep(1.0, 0.9, d);
          float dome = 1.0 - d * d * 0.35;
          vec3 base = vCol * mix(0.62, 1.0, 1.0 - uGlow);
          vec3 col = base * (0.45 + 0.6 * lam) * dome;
          col += vec3(spec) * 0.35 * body;
          col += vCol * vE * 0.6;                              // pushed discs glow
          col = mix(col, vCol, uContrast * 0.6);
          float rim = smoothstep(0.7, 0.95, d) * body * 0.25;
          col += rim * vCol;
          float halo = (1.0 - smoothstep(0.95, 1.6, d)) * (1.0 - body);
          halo *= halo * (0.08 + 0.6 * vE) * (1.0 - uContrast * 0.7);
          float a = max(body, halo);
          vec3 haloCol = mix(vCol, vec3(1.0), 1.0 - uGlow) ;
          col = mix(haloCol, col, body);
          if (a < 0.004) discard;
          gl_FragColor = vec4(col, a);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
      blending: this.pal.glow ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    const cols6 = this.pal.colors.map((c) => new THREE.Color(c));
    const c = new THREE.Color();
    for (let r = 0, i = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++, i++) {
        const x = this.x0 + q * sp + (r & 1 ? sp * 0.5 : 0);
        const y = this.y0 + r * this.rowH;
        this.bx[i] = x; this.by[i] = y;
        // Neighbours (clamped at the edges by pointing at self).
        this.nb[i * 4] = q > 0 ? i - 1 : i;
        this.nb[i * 4 + 1] = q < cols - 1 ? i + 1 : i;
        this.nb[i * 4 + 2] = r > 0 ? i - cols : i;
        this.nb[i * 4 + 3] = r < rows - 1 ? i + cols : i;
        // Colour: slow diagonal blend through the palette.
        const t = ((x * 0.035 + y * 0.025) % 1 + 1) % 1 * cols6.length;
        const a = Math.floor(t), b = (a + 1) % cols6.length;
        c.copy(cols6[a]).lerp(cols6[b], t - a);
        mesh.setColorAt(i, c);
      }
    }
    mesh.instanceColor.needsUpdate = true;
    this.mesh = mesh;
    this.mats = mesh.instanceMatrix.array;
    this.energyAttr = energyAttr;
    this.scene.add(mesh);
    this.writeMatrices();
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    // Pull back a little in portrait so the field still feels spacious.
    this.camBase.set(0, -8, w < h ? 26 : 21);
    this.camera.position.copy(this.camBase);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(); // build() casts rays through the camera
    this.backdrop.material.uniforms.uAspect.value = w / h;
    this.build();
  }

  // ---- input ---------------------------------------------------------------

  _world(p) {
    if (!p.data) p.data = { wx: 0, wy: 0, cell: -1, ok: false };
    p.data.ok = !!ndcToPlane(this.camera, p.nx, p.ny, this.plane, this.tmp);
    p.data.wx = this.tmp.x; p.data.wy = this.tmp.y;
  }
  _cell(x, y) {
    const r = clamp(Math.round((y - this.y0) / this.rowH), 0, this.rows - 1);
    const q = clamp(Math.round((x - this.x0 - (r & 1 ? this.sp * 0.5 : 0)) / this.sp), 0, this.cols - 1);
    return r * this.cols + q;
  }
  _note(p, cell, vel) {
    const q = cell % this.cols, r = Math.floor(cell / this.cols);
    const step = this.audio.stepFromUnit(q / (this.cols - 1), 5, 17);
    this.audio.chime(this.audio.freq(step), vel, p.nx * 0.7, 0.25 + 0.5 * (r / this.rows), 1.4);
  }
  onPointerDown(p) {
    this._world(p);
    this.pointers.push(p);
    const cell = this._cell(p.data.wx, p.data.wy);
    p.data.cell = cell;
    this._note(p, cell, 0.45);
  }
  onPointerMove(p) {
    if (!p.data) return;
    this._world(p);
    const cell = this._cell(p.data.wx, p.data.wy);
    if (cell !== p.data.cell) {
      p.data.cell = cell;
      if (this.limiter.take(performance.now() / 1000)) this._note(p, cell, clamp(0.15 + p.speed / 2200, 0.15, 0.85));
    }
  }
  onPointerUp(p) { const i = this.pointers.indexOf(p); if (i >= 0) this.pointers.splice(i, 1); }

  // ---- simulation ----------------------------------------------------------

  update(dt, time) {
    this.time = time;
    const { n, nb, dx, dy, dz, vx, vy, vz, ax, ay, az, tx, ty, wx, wy, energy, bx, by, sp } = this;
    const pxToWorld = (this.cols * sp) / window.innerWidth;

    // 1) spring + neighbour coupling accelerations
    for (let i = 0; i < n; i++) {
      const a = nb[i * 4], b = nb[i * 4 + 1], c = nb[i * 4 + 2], d = nb[i * 4 + 3];
      ax[i] = -K * dx[i] - C * vx[i] + KC * (dx[a] + dx[b] + dx[c] + dx[d] - 4 * dx[i]);
      ay[i] = -K * dy[i] - C * vy[i] + KC * (dy[a] + dy[b] + dy[c] + dy[d] - 4 * dy[i]);
      az[i] = -K * dz[i] - C * vz[i] + KC * (dz[a] + dz[b] + dz[c] + dz[d] - 4 * dz[i]);
    }

    // 2) finger pushes (only discs inside each finger's bounding box are visited)
    for (const p of this.pointers) {
      if (!p.data || !p.data.ok) continue;
      const spd = clamp((p.speed * pxToWorld) / (sp * 25), 0, 1); // 0..1 normalised push speed
      const R = sp * (2.3 + 1.2 * spd);
      const S = K * sp * (0.95 + 0.7 * spd);
      const r0 = Math.max(0, Math.floor((p.data.wy - R - this.y0) / this.rowH));
      const r1 = Math.min(this.rows - 1, Math.ceil((p.data.wy + R - this.y0) / this.rowH));
      const q0 = Math.max(0, Math.floor((p.data.wx - R - this.x0) / sp) - 1);
      const q1 = Math.min(this.cols - 1, Math.ceil((p.data.wx + R - this.x0) / sp) + 1);
      for (let r = r0; r <= r1; r++) {
        for (let q = q0; q <= q1; q++) {
          const i = r * this.cols + q;
          const rx = bx[i] + dx[i] - p.data.wx, ry = by[i] + dy[i] - p.data.wy;
          const d = Math.sqrt(rx * rx + ry * ry) + 1e-4;
          if (d >= R) continue;
          const f = (1 - d / R) * (1 - d / R);
          const ux = rx / d, uy = ry / d;
          ax[i] += ux * f * S; ay[i] += uy * f * S;
          az[i] -= f * S * 0.7;
          wx[i] += uy * f * 40 * dt; wy[i] -= ux * f * 40 * dt;
          energy[i] = Math.min(1, energy[i] + f * (0.6 + spd) * dt * 7);
        }
      }
    }

    // 3) integrate (semi-implicit Euler) + tilt springs, coupled to lateral motion
    const eDecay = Math.exp(-dt * 1.3);
    for (let i = 0; i < n; i++) {
      vx[i] += ax[i] * dt; vy[i] += ay[i] * dt; vz[i] += az[i] * dt;
      dx[i] += vx[i] * dt; dy[i] += vy[i] * dt; dz[i] += vz[i] * dt;
      wx[i] += (-KT * tx[i] - CT * wx[i] + vy[i] * 2.2) * dt;
      wy[i] += (-KT * ty[i] - CT * wy[i] - vx[i] * 2.2) * dt;
      tx[i] = clamp(tx[i] + wx[i] * dt, -0.9, 0.9);
      ty[i] = clamp(ty[i] + wy[i] * dt, -0.9, 0.9);
      energy[i] *= eDecay;
    }

    // Very slow camera drift (none with reduced motion).
    if (!this.s.reducedMotion) {
      this.camera.position.x = this.camBase.x + Math.sin(time * 0.05) * 0.6;
      this.camera.position.y = this.camBase.y + Math.sin(time * 0.037) * 0.4;
      this.camera.lookAt(0, 0, 0);
    }
    this.writeMatrices();
  }

  /** Write instance matrices directly: T · Ry(ty) · Rx(tx) · S. */
  writeMatrices() {
    const m = this.mats, { n, bx, by, dx, dy, dz, tx, ty, energy } = this;
    const t = this.time;
    const swell = this.s.reducedMotion ? 0 : this.sp * 0.22;
    for (let i = 0, o = 0; i < n; i++, o += 16) {
      const ca = Math.cos(tx[i]), sa = Math.sin(tx[i]), cb = Math.cos(ty[i]), sb = Math.sin(ty[i]);
      const s = 1 + energy[i] * 0.12;
      const idle = swell * Math.sin(t * 0.55 - bx[i] * 0.22 - by[i] * 0.15);
      m[o] = cb * s; m[o + 1] = 0; m[o + 2] = -sb * s; m[o + 3] = 0;
      m[o + 4] = sb * sa * s; m[o + 5] = ca * s; m[o + 6] = cb * sa * s; m[o + 7] = 0;
      m[o + 8] = sb * ca * s; m[o + 9] = -sa * s; m[o + 10] = cb * ca * s; m[o + 11] = 0;
      m[o + 12] = bx[i] + dx[i]; m[o + 13] = by[i] + dy[i]; m[o + 14] = dz[i] + idle; m[o + 15] = 1;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.energyAttr.needsUpdate = true;
  }

  dispose() { this.pointers.length = 0; }
}
