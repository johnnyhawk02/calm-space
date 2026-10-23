/**
 * Scene 6 — Gravity Garden
 *
 * PHYSICS: floating gems (one InstancedMesh) are 2D circles with mass ∝ size².
 * Holding a finger creates a gravity well whose strength eases in over ~0.4 s:
 * a softened inverse-square pull plus a tangential swirl, so gems spiral in
 * and gather in a gentle orbiting cluster (extra drag near the well stops
 * slingshots). Lifting eases the well out, releasing gems softly. When two or
 * more fingers are held, every well becomes a soft repeller instead.
 * Gem–gem contacts are resolved with positional correction plus an impulse
 * (restitution 0.35) — O(n²) on ≤ ~110 gems is cheaper than a spatial hash
 * here and needs no physics engine. Soft walls keep everything on screen.
 *
 * SOUND: soft high clinks (short FM chimes) when two gems meet with enough
 * speed; pitch from the smaller gem's size (smaller = higher), volume from
 * impact speed, pan from x. Clinks are rate-limited (≤ 8/s). Each well also
 * hums a low warm pad that swells with its strength.
 *
 * IDLE: gems drift slowly in a smooth flow field, turning gently, and ease
 * back towards their own resting spots so the garden never stays piled up.
 */
import * as THREE from 'three';
import { makeBackdrop, clamp, visibleSize, rng, RateLimiter } from '../util.js';

const MAX_WELLS = 5;

export default class GravityGarden {
  init(renderer, audio, settings) {
    this.audio = audio; this.s = settings; this.pal = settings.palette;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.set(0, 0, 18);
    this.backdrop = makeBackdrop(this.pal);
    this.scene.add(this.backdrop);
    const hemi = new THREE.HemisphereLight('#ffffff', this.pal.dark ? '#2a2060' : '#cfc6e6', this.pal.dark ? 1.3 : 1.8);
    const key = new THREE.DirectionalLight('#ffffff', 2.0); key.position.set(-5, 8, 10);
    const rim = new THREE.DirectionalLight(this.pal.dark ? '#9fb6ff' : '#ffffff', 0.8); rim.position.set(6, -4, 4);
    this.scene.add(hemi, key, rim);

    const n = this.n = Math.round(70 * settings.densityFactor);
    const r = rng(21);
    this.x = new Float32Array(n); this.y = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n);
    this.rad = new Float32Array(n); this.mass = new Float32Array(n);
    this.rx = new Float32Array(n); this.ry = new Float32Array(n); this.wz = new Float32Array(n);
    this.z = new Float32Array(n);
    this.hx = new Float32Array(n); this.hy = new Float32Array(n); // normalised resting spots
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.3, metalness: 0.05, flatShading: true,
      emissive: this.pal.dark ? '#221a4a' : '#000000' });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    const cols = this.pal.colors.map((c) => new THREE.Color(c));
    for (let i = 0; i < n; i++) {
      this.hx[i] = r() * 1.8 - 0.9; this.hy[i] = r() * 1.8 - 0.9;
      this.x[i] = this.hx[i] * 10; this.y[i] = this.hy[i] * 7;
      this.rad[i] = 0.28 + r() * r() * 0.45;
      this.mass[i] = this.rad[i] * this.rad[i];
      this.rx[i] = r() * 6; this.ry[i] = r() * 6; this.wz[i] = (r() - 0.5) * 0.6;
      this.z[i] = (r() - 0.5) * 0.8;
      this.mesh.setColorAt(i, cols[i % cols.length]);
    }
    this.mesh.instanceColor.needsUpdate = true;
    this.scene.add(this.mesh);

    // Well rings (one per possible finger), drawn as soft shader rings.
    this.wells = [];
    const ringGeo = new THREE.PlaneGeometry(1, 1);
    for (let k = 0; k < MAX_WELLS; k++) {
      const m = new THREE.ShaderMaterial({
        uniforms: { uT: { value: 0 }, uS: { value: 0 }, uDir: { value: 1 }, uC: { value: cols[k % cols.length].clone() } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} ',
        fragmentShader: /* glsl */`
          uniform float uT; uniform float uS; uniform float uDir; uniform vec3 uC; varying vec2 vUv;
          void main() {
            float d = length(vUv - 0.5) * 2.0;
            float waves = 0.5 + 0.5 * sin(d * 14.0 + uDir * uT * 2.2);   // slow drifting rings (< 0.5 Hz)
            float a = smoothstep(1.0, 0.2, d) * (0.25 + 0.5 * waves) * uS;
            a += smoothstep(0.18, 0.0, d) * 0.6 * uS;
            gl_FragColor = vec4(uC, a * 0.55);
            #include <colorspace_fragment>
          }`,
        transparent: true, depthWrite: false,
        blending: this.pal.dark ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      const mesh = new THREE.Mesh(ringGeo, m);
      mesh.visible = false;
      mesh.position.z = -0.5;
      this.scene.add(mesh);
      this.wells.push({ mesh, owner: null, x: 0, y: 0, s: 0, pad: null });
    }
    this.limiter = new RateLimiter(8, 3);
    this.dummy = new THREE.Object3D();
    this.halfW = 12; this.halfH = 8;
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.backdrop.material.uniforms.uAspect.value = w / h;
    const v = visibleSize(this.camera, 18);
    this.halfW = v.w / 2; this.halfH = v.h / 2;
    // keep gems on screen after a rotation
    for (let i = 0; i < this.n; i++) { this.x[i] = clamp(this.x[i], -this.halfW + 1, this.halfW - 1); this.y[i] = clamp(this.y[i], -this.halfH + 1, this.halfH - 1); }
  }

  onPointerDown(p) {
    const w = this.wells.find((q) => !q.owner && q.s < 0.05) || this.wells.find((q) => !q.owner);
    if (!w) return;
    w.owner = p; w.x = p.nx * this.halfW; w.y = p.ny * this.halfH;
    w.mesh.material.uniforms.uC.value.set(this.pal.colors[p.colorIndex % this.pal.colors.length]);
    p.data = { w };
    if (!w.pad || !w.pad.alive) w.pad = this.audio.pad('warm', this.audio.freq(this.audio.stepFromUnit((p.ny + 1) / 2, -5, 2)));
    this.audio.marimba(this.audio.freq(this.audio.stepFromUnit((p.ny + 1) / 2, 3, 10)), 0.3, p.nx * 0.6, 0.2);
  }
  onPointerMove(p) {
    if (!p.data || p.data.w.owner !== p) return;
    p.data.w.x = p.nx * this.halfW; p.data.w.y = p.ny * this.halfH;
  }
  onPointerUp(p) {
    if (!p.data) return;
    const w = p.data.w;
    if (w.owner === p) { w.owner = null; if (w.pad) { w.pad.stop(0.8); w.pad = null; } }
  }

  update(dt, time) {
    const { n, x, y, vx, vy, rad, mass } = this;
    const W = this.wells;
    let held = 0;
    for (const w of W) if (w.owner) held++;
    const repel = held >= 2;
    let wellSum = 0;
    for (const w of W) {
      w.s += ((w.owner ? 1 : 0) - w.s) * (1 - Math.exp(-dt * (w.owner ? 5 : 3.5)));
      w.mesh.visible = w.s > 0.01;
      if (w.mesh.visible) {
        const sc = (repel ? 4.5 : 3.2) * (0.6 + 0.4 * w.s);
        w.mesh.position.set(w.x, w.y, -0.5); w.mesh.scale.set(sc, sc, 1);
        const u = w.mesh.material.uniforms; u.uT.value = time; u.uS.value = w.s; u.uDir.value = repel ? -1 : 1;
      }
      wellSum += w.s;
      if (w.pad && w.owner) w.pad.set(0.35 * w.s, 0.1 + 0.25 * w.s, null, w.owner.nx * 0.6);
    }

    const calm = this.s.reducedMotion ? 0.4 : 1;
    const hw = this.halfW - 0.4, hh = this.halfH - 0.4;
    for (let i = 0; i < n; i++) {
      let ax = Math.sin(y[i] * 0.25 + time * 0.1) * 0.35 * calm;
      let ay = Math.cos(x[i] * 0.21 - time * 0.08) * 0.35 * calm;
      let drag = 0.6;
      // with no wells, each gem drifts very slowly back towards its own resting spot
      const free = 1 - Math.min(1, wellSum);
      ax += (this.hx[i] * hw - x[i]) * 0.04 * free; ay += (this.hy[i] * hh - y[i]) * 0.04 * free;
      for (const w of W) {
        if (w.s < 0.01) continue;
        const dx = w.x - x[i], dy = w.y - y[i];
        const d2 = dx * dx + dy * dy, d = Math.sqrt(d2) + 1e-3;
        if (repel) {
          const f = (28 * w.s) / (d + 1.2);
          ax -= (dx / d) * f; ay -= (dy / d) * f;
        } else {
          const f = Math.min(40, (60 * w.s) / (d2 + 2.5));
          const swirl = f * 0.45;
          ax += (dx / d) * f - (dy / d) * swirl;
          ay += (dy / d) * f + (dx / d) * swirl;
          drag += (2.5 * w.s) / (1 + d2 * 0.08); // calm near the well
        }
      }
      // soft walls
      if (x[i] > hw) ax -= (x[i] - hw) * 12; else if (x[i] < -hw) ax -= (x[i] + hw) * 12;
      if (y[i] > hh) ay -= (y[i] - hh) * 12; else if (y[i] < -hh) ay -= (y[i] + hh) * 12;
      const k = Math.exp(-dt * drag);
      vx[i] = (vx[i] + ax * dt) * k; vy[i] = (vy[i] + ay * dt) * k;
      const sp = Math.hypot(vx[i], vy[i]);
      if (sp > 14) { vx[i] *= 14 / sp; vy[i] *= 14 / sp; }
      x[i] += vx[i] * dt; y[i] += vy[i] * dt;
    }

    // gem–gem collisions
    const now = performance.now() / 1000;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = x[j] - x[i], dy = y[j] - y[i], min = rad[i] + rad[j];
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min || d2 < 1e-8) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        const mi = mass[i], mj = mass[j], inv = 1 / (mi + mj);
        const overlap = min - d;
        x[i] -= nx * overlap * mj * inv; y[i] -= ny * overlap * mj * inv;
        x[j] += nx * overlap * mi * inv; y[j] += ny * overlap * mi * inv;
        const rv = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny;
        if (rv < 0) {
          const imp = (-(1 + 0.35) * rv) / (1 / mi + 1 / mj);
          vx[i] -= (imp / mi) * nx; vy[i] -= (imp / mi) * ny;
          vx[j] += (imp / mj) * nx; vy[j] += (imp / mj) * ny;
          this.wz[i] += rv * 0.15; this.wz[j] -= rv * 0.15;
          if (-rv > 1.4 && this.limiter.take(now)) {
            const small = Math.min(rad[i], rad[j]);
            const step = this.audio.stepFromUnit(1 - (small - 0.28) / 0.45, 12, 19);
            this.audio.chime(this.audio.freq(step), clamp(-rv / 12, 0.08, 0.5), clamp(x[i] / this.halfW, -1, 1) * 0.7, 0.5, 0.5);
          }
        }
      }
    }

    // write instance matrices
    const o = this.dummy;
    for (let i = 0; i < n; i++) {
      this.rx[i] += dt * (0.2 + vy[i] * 0.15); this.ry[i] += dt * (0.15 - vx[i] * 0.15);
      this.wz[i] *= Math.exp(-dt * 0.5);
      o.position.set(x[i], y[i], this.z[i]);
      o.rotation.set(this.rx[i], this.ry[i], this.wz[i] + time * 0.05);
      o.scale.setScalar(rad[i]);
      o.updateMatrix();
      this.mesh.setMatrixAt(i, o.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() { for (const w of this.wells) if (w.pad) w.pad.stop(); }
}
