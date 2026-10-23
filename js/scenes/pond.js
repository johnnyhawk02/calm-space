/**
 * Scene 4 — Ripple Pond
 *
 * PHYSICS: a classic two-buffer height-field wave simulation on the grid of
 * the water mesh:  next = (sum of 4 neighbours)/2 − previous, then damped.
 * It runs at a fixed, slowish rate (45 steps/s) so rings always spread at the
 * same calm speed whatever the frame rate. Touches press a smooth Gaussian dip
 * into the surface; dragging leaves a trail of small dips; holding a finger
 * still sends a slow ring every ~0.9 s. Normals are computed from the height
 * field by central differences straight into the vertex buffer.
 * Lily pads and gems sample the height field (bilinear) to bob on the waves,
 * tilt with its slope, are nudged down-slope (so ripples push them away), are
 * gently pulled back home and softly repel each other.
 *
 * SOUND: soft water drops. Pitch follows x (left = low, right = high), pan
 * follows x, volume follows how fast the finger moves. Dragging plays drops
 * through a rate limiter (≤ 6/s) so it never becomes a patter of noise.
 *
 * IDLE: a tiny, silent raindrop lands every few seconds; pads drift and turn.
 */
import * as THREE from 'three';
import { makeBackdrop, ndcToPlane, RateLimiter, clamp, rng } from '../util.js';

const SIM_HZ = 45;
const DAMP = 0.986;

export default class RipplePond {
  init(renderer, audio, settings) {
    this.audio = audio; this.s = settings; this.pal = settings.palette;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.backdrop = makeBackdrop(this.pal);
    this.scene.add(this.backdrop);
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.tmp = new THREE.Vector3();
    this.limiter = new RateLimiter(6, 2);
    this.pointers = [];
    this.acc = 0;
    this.rand = rng(11);
    this.nextRain = 2;
    this.water = null;

    const hemi = new THREE.HemisphereLight(this.pal.dark ? '#b8c6ff' : '#ffffff', this.pal.dark ? '#1a1640' : '#c9c2dd', this.pal.dark ? 1.4 : 2.0);
    const sun = new THREE.DirectionalLight('#ffffff', this.pal.dark ? 1.6 : 1.4);
    sun.position.set(-4, 10, 6);
    this.scene.add(hemi, sun);
    this.makeFloaters();
  }

  /** Lily pads (notched discs, some with a flower) and floating gems. */
  makeFloaters() {
    const cols = this.pal.colors.map((c) => new THREE.Color(c));
    const padGeo = new THREE.CircleGeometry(1, 40, 0.35, Math.PI * 2 - 0.5);
    padGeo.rotateX(-Math.PI / 2);
    const padCol = this.pal.contrast ? new THREE.Color('#6cff3d') : cols[5].clone().lerp(new THREE.Color('#5fbf7a'), 0.6);
    const padMat = new THREE.MeshStandardMaterial({ color: padCol, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
    const flowerGeo = new THREE.IcosahedronGeometry(0.28, 1);
    const flowerMat = new THREE.MeshStandardMaterial({ color: cols[2], roughness: 0.5, emissive: cols[2], emissiveIntensity: this.pal.dark ? 0.35 : 0.1, flatShading: true });
    const gemGeo = new THREE.OctahedronGeometry(0.42, 0);
    this.floaters = [];
    const r = rng(5);
    const nPads = 6, nGems = Math.round(8 * Math.min(1.4, this.s.densityFactor));
    for (let i = 0; i < nPads + nGems; i++) {
      let mesh;
      const isPad = i < nPads;
      if (isPad) {
        mesh = new THREE.Group();
        const pad = new THREE.Mesh(padGeo, padMat);
        const sc = 0.65 + r() * 0.4; pad.scale.setScalar(sc);
        mesh.add(pad);
        if (i % 2 === 0) { const f = new THREE.Mesh(flowerGeo, flowerMat); f.position.set(0.15 * sc, 0.16, 0.1 * sc); mesh.add(f); }
        mesh.rotation.y = r() * Math.PI * 2;
      } else {
        const c = cols[i % cols.length];
        const mat = new THREE.MeshStandardMaterial({ color: c, roughness: 0.25, metalness: 0.1, emissive: c, emissiveIntensity: this.pal.dark ? 0.35 : 0.12, flatShading: true });
        mesh = new THREE.Mesh(gemGeo, mat);
      }
      this.scene.add(mesh);
      this.floaters.push({ mesh, isPad, hx: r() * 2 - 1, hz: r() * 2 - 1, x: 0, z: 0, vx: 0, vz: 0, spin: (r() - 0.5) * 0.3, rad: isPad ? 1.1 : 0.5, phase: r() * 6 });
    }
  }

  /** Build (or rebuild) the water grid so it covers the visible part of the y=0 plane. */
  build() {
    if (this.water) { this.scene.remove(this.water); this.water.geometry.dispose(); this.water.material.dispose(); }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [nx, ny] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      if (!ndcToPlane(this.camera, nx, ny, this.plane, this.tmp)) continue;
      minX = Math.min(minX, this.tmp.x); maxX = Math.max(maxX, this.tmp.x);
      minZ = Math.min(minZ, this.tmp.z); maxZ = Math.max(maxZ, this.tmp.z);
    }
    minX -= 1; maxX += 1; minZ -= 1; maxZ += 1;
    const cells = { low: 70, medium: 100, high: 130 }[this.s.density] * (this.s.reducedMotion ? 0.8 : 1);
    const W = maxX - minX, D = maxZ - minZ;
    const d = Math.sqrt((W * D) / (cells * cells));
    const gw = Math.ceil(W / d), gh = Math.ceil(D / d);
    Object.assign(this, { gw, gh, x0: minX, z0: minZ, d, minX, maxX, minZ, maxZ });
    const nv = (gw + 1) * (gh + 1);
    this.h = new Float32Array(nv); this.hp = new Float32Array(nv); this.hn = new Float32Array(nv);
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
    for (let j = 0, k = 0; j <= gh; j++) for (let i = 0; i <= gw; i++, k++) {
      pos[k * 3] = minX + i * d; pos[k * 3 + 1] = 0; pos[k * 3 + 2] = minZ + j * d; nrm[k * 3 + 1] = 1;
    }
    const idx = new Uint32Array(gw * gh * 6);
    for (let j = 0, o = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const a = j * (gw + 1) + i, b = a + 1, c = a + gw + 1, e = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = e;
    }
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.nrmAttr = new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('normal', this.nrmAttr);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const cols = this.pal.colors.map((c) => new THREE.Color(c));
    const deep = this.pal.dark ? cols[1].clone().multiplyScalar(0.05) : cols[1].clone().lerp(new THREE.Color('#ffffff'), 0.1);
    const shallow = this.pal.dark ? cols[0].clone().multiplyScalar(0.16) : cols[5].clone().lerp(new THREE.Color('#ffffff'), 0.35);
    const sky = this.pal.dark ? cols[4].clone().multiplyScalar(0.4) : new THREE.Color('#ffffff');
    if (this.pal.contrast) { // clear, dark-blue water so floaters stand out strongly
      deep.set('#00101f'); shallow.set('#00335c'); sky.set('#2f7fb8');
    }
    const mat = new THREE.ShaderMaterial({
      uniforms: { cDeep: { value: deep }, cShallow: { value: shallow }, cSky: { value: sky }, uSpec: { value: this.pal.dark ? 0.9 : 0.6 } },
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vW; varying float vH;
        void main() {
          vN = normal; vH = position.y;
          vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 cDeep; uniform vec3 cShallow; uniform vec3 cSky; uniform float uSpec;
        varying vec3 vN; varying vec3 vW; varying float vH;
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(cameraPosition - vW);
          float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
          vec3 col = mix(cDeep, cShallow, clamp(0.35 + vH * 1.8 + N.x * 0.3, 0.0, 1.0));
          col = mix(col, cSky, clamp(fres * 0.6, 0.0, 0.5));
          vec3 L = normalize(vec3(-0.4, 1.0, 0.6));
          float spec = pow(clamp(dot(N, normalize(L + V)), 0.0, 1.0), 120.0);
          col += vec3(spec) * uSpec;
          col += cSky * clamp(length(N.xz) * 4.0, 0.0, 1.0) * 0.3;   // ripple slopes catch the light
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.water = new THREE.Mesh(geo, mat);
    this.water.frustumCulled = false;
    this.scene.add(this.water);
    const spanX = (maxX - minX) * 0.36, spanZ = (maxZ - minZ) * 0.32;
    for (const f of this.floaters) { f.x = f.hx * spanX; f.z = f.hz * spanZ; f.homeX = f.x; f.homeZ = f.z; }
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    const portrait = w < h;
    this.camera.position.set(0, portrait ? 21 : 15, portrait ? 13 : 11);
    this.camera.lookAt(0, 0, 0.5);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(); // build() casts rays through the camera
    this.backdrop.material.uniforms.uAspect.value = w / h;
    this.build();
  }

  // ---- interaction --------------------------------------------------------

  /** Press a smooth Gaussian dip into the surface at world (x, z). */
  disturb(x, z, amount, radiusCells = 2.6) {
    const { gw, gh, d, h } = this;
    const ci = (x - this.x0) / d, cj = (z - this.z0) / d;
    const R = Math.ceil(radiusCells * 2);
    const i0 = Math.max(1, Math.floor(ci - R)), i1 = Math.min(gw - 1, Math.ceil(ci + R));
    const j0 = Math.max(1, Math.floor(cj - R)), j1 = Math.min(gh - 1, Math.ceil(cj + R));
    const inv = 1 / (radiusCells * radiusCells);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const di = i - ci, dj = j - cj;
      h[j * (gw + 1) + i] -= amount * Math.exp(-(di * di + dj * dj) * inv);
    }
  }

  _world(p) {
    if (!p.data) p.data = { x: 0, z: 0, lx: 0, lz: 0, ok: false, pulse: 0 };
    p.data.ok = !!ndcToPlane(this.camera, p.nx, p.ny, this.plane, this.tmp);
    p.data.x = this.tmp.x; p.data.z = this.tmp.z;
  }
  _drop(p, vel) {
    const u = clamp((p.data.x - this.minX) / (this.maxX - this.minX), 0, 1);
    this.audio.drop(this.audio.freq(this.audio.stepFromUnit(u, 6, 16)), vel, p.nx * 0.7, 0.4 + vel * 0.4);
  }
  onPointerDown(p) {
    this._world(p);
    this.pointers.push(p);
    if (!p.data.ok) return;
    this.disturb(p.data.x, p.data.z, 0.55);
    p.data.lx = p.data.x; p.data.lz = p.data.z; p.data.pulse = 0;
    this._drop(p, 0.5);
  }
  onPointerMove(p) {
    if (!p.data) return;
    this._world(p);
    if (!p.data.ok) return;
    const dist = Math.hypot(p.data.x - p.data.lx, p.data.z - p.data.lz);
    if (dist > this.d * 1.6) {
      this.disturb(p.data.x, p.data.z, clamp(0.12 + p.speed / 4000, 0.12, 0.4), 2.0);
      p.data.lx = p.data.x; p.data.lz = p.data.z;
      if (dist > this.d * 1.6 && p.speed > 150 && this.limiter.take(performance.now() / 1000)) this._drop(p, clamp(p.speed / 2500, 0.15, 0.7));
    }
  }
  onPointerUp(p) { const i = this.pointers.indexOf(p); if (i >= 0) this.pointers.splice(i, 1); }

  // ---- simulation ---------------------------------------------------------

  step() {
    const { gw, gh } = this; const W = gw + 1;
    let h = this.h, hp = this.hp, hn = this.hn;
    for (let j = 1; j < gh; j++) {
      for (let i = 1, k = j * W + 1; i < gw; i++, k++) {
        hn[k] = ((h[k - 1] + h[k + 1] + h[k - W] + h[k + W]) * 0.5 - hp[k]) * DAMP;
      }
    }
    // rotate buffers: prev ← current, current ← next
    this.hp = h; this.h = hn; this.hn = hp;
  }

  sample(x, z) {
    const { gw, gh, d } = this;
    const fi = clamp((x - this.x0) / d, 0, gw - 1.001), fj = clamp((z - this.z0) / d, 0, gh - 1.001);
    const i = fi | 0, j = fj | 0, tx = fi - i, tz = fj - j, W = gw + 1, k = j * W + i, h = this.h;
    return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - tz) + (h[k + W] * (1 - tx) + h[k + W + 1] * tx) * tz;
  }

  update(dt, time) {
    // Held fingers send a slow ring now and then.
    for (const p of this.pointers) {
      if (!p.data || !p.data.ok) continue;
      p.data.pulse += dt;
      if (p.data.pulse > 0.9 && p.speed < 60) { p.data.pulse = 0; this.disturb(p.data.x, p.data.z, 0.3); }
    }
    // Idle rain: a tiny silent drop every few seconds.
    this.nextRain -= dt;
    if (this.nextRain < 0) {
      this.nextRain = 3 + this.rand() * 4;
      const a = this.s.reducedMotion ? 0.07 : 0.14;
      this.disturb(this.minX + (0.15 + 0.7 * this.rand()) * (this.maxX - this.minX), this.minZ + (0.15 + 0.7 * this.rand()) * (this.maxZ - this.minZ), a, 1.8);
    }
    // Fixed-rate wave steps (at most 3 per frame).
    this.acc = Math.min(this.acc + dt, 3 / SIM_HZ);
    while (this.acc >= 1 / SIM_HZ) { this.step(); this.acc -= 1 / SIM_HZ; }

    // Write heights + normals into the mesh.
    const { gw, gh, d } = this; const W = gw + 1; const h = this.h;
    const pos = this.posAttr.array, nrm = this.nrmAttr.array;
    const HS = 0.55, inv2d = HS / (2 * d);
    for (let j = 0, k = 0; j <= gh; j++) {
      for (let i = 0; i <= gw; i++, k++) {
        pos[k * 3 + 1] = h[k] * HS;
        const hl = h[i > 0 ? k - 1 : k], hr = h[i < gw ? k + 1 : k];
        const hu = h[j > 0 ? k - W : k], hd = h[j < gh ? k + W : k];
        const nx = -(hr - hl) * inv2d, nz = -(hd - hu) * inv2d;
        const il = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        nrm[k * 3] = nx * il; nrm[k * 3 + 1] = il; nrm[k * 3 + 2] = nz * il;
      }
    }
    this.posAttr.needsUpdate = true; this.nrmAttr.needsUpdate = true;

    // Floaters: bob, tilt, slide down-slope, return home, repel each other.
    const F = this.floaters, e = d;
    for (let a = 0; a < F.length; a++) {
      const f = F[a];
      const y = this.sample(f.x, f.z);
      const gx = (this.sample(f.x + e, f.z) - this.sample(f.x - e, f.z)) / (2 * e);
      const gz = (this.sample(f.x, f.z + e) - this.sample(f.x, f.z - e)) / (2 * e);
      let ax = -gx * 30 + (f.homeX - f.x) * 0.25, az = -gz * 30 + (f.homeZ - f.z) * 0.25;
      for (let b = a + 1; b < F.length; b++) {
        const o = F[b]; const dx = f.x - o.x, dz = f.z - o.z; const dd = Math.hypot(dx, dz) + 1e-3; const min = f.rad + o.rad;
        if (dd < min) { const push = (min - dd) * 4 / dd; ax += dx * push; az += dz * push; o.vx -= dx * push * dt; o.vz -= dz * push * dt; }
      }
      const k = Math.exp(-dt * 1.2);
      f.vx = (f.vx + ax * dt) * k; f.vz = (f.vz + az * dt) * k;
      f.x += f.vx * dt; f.z += f.vz * dt;
      const bob = this.s.reducedMotion ? 0 : Math.sin(time * 0.8 + f.phase) * 0.03;
      f.mesh.position.set(f.x, y * HS + (f.isPad ? 0.04 : 0.12) + bob, f.z);
      f.mesh.rotation.x = clamp(gz * HS * 2.5, -0.5, 0.5);
      f.mesh.rotation.z = clamp(-gx * HS * 2.5, -0.5, 0.5);
      f.mesh.rotation.y += f.spin * dt;
    }
  }

  dispose() { this.pointers.length = 0; }
}
