/**
 * Scene 2 — Jelly Blob
 *
 * PHYSICS: a sphere whose surface is displaced on the GPU from a handful of
 * spring-driven parameters (cheap, smooth, no per-vertex CPU work):
 *   • up to 5 "dents" (one per finger): direction + depth, each a damped spring.
 *     Releasing lets the depth overshoot into a small bulge before settling.
 *   • 3 low-order wobble modes (spherical-harmonic-like shapes), each a lightly
 *     damped oscillator that pokes and releases excite → jelly wobble.
 *   • a pinch "squish": volume-preserving scale along the axis between two
 *     fingers, also on a spring.
 *   • a lean: touches that miss the blob make it lean towards the finger.
 * Normals are rebuilt in the vertex shader by finite differences of the same
 * displacement function, so lighting follows every dent.
 *
 * SOUND: low, rounded "squish" tones (filtered triangle + sub) when poked —
 * pitch from where it is touched (low at the bottom, higher at the top), pan
 * from x. Release gives a soft low bubble. A pinch fades in a warm pad whose
 * brightness follows how hard it is squished.
 *
 * IDLE: the blob breathes slowly and turns very gently.
 */
import * as THREE from 'three';
import { makeBackdrop, ndcRay, clamp, RateLimiter, visibleSize } from '../util.js';

const MAX_DENTS = 5;

const VERT = /* glsl */`
  uniform vec4 uDent[${MAX_DENTS}];   // xyz = direction (unit, local), w = depth
  uniform float uDentCos;             // dent width (gaussian sigma in 1-cos units)
  uniform vec3 uWob;                  // wobble mode amplitudes
  uniform vec3 uSqAxis; uniform float uSq;
  uniform float uBreath; uniform float uTime;
  varying vec3 vN; varying vec3 vPos; varying float vDent; varying vec3 vLocal;

  float radiusAt(vec3 n, out float dent) {
    float r = 1.0 + uBreath;
    dent = 0.0;
    for (int i = 0; i < ${MAX_DENTS}; i++) {
      // Gaussian dent minus a wider, shallower Gaussian = smooth dimple with a soft
      // raised rim (a "Mexican hat"), infinitely smooth so lighting never creases.
      float e = 1.0 - dot(n, uDent[i].xyz);
      float w = exp(-e / uDentCos);
      float wide = exp(-e / (uDentCos * 3.0));
      float d = uDent[i].w;
      r -= d * w;
      r += d * 0.28 * (wide - w);
      dent += max(d, 0.0) * w;
    }
    // Low-order wobble modes.
    r += uWob.x * (1.5 * n.y * n.y - 0.5);
    r += uWob.y * 2.0 * n.x * n.z;
    r += uWob.z * sin(3.0 * atan(n.z, n.x) + uTime * 0.3) * (1.0 - n.y * n.y);
    return r;
  }
  vec3 shape(vec3 n, out float dent) {
    vec3 p = n * radiusAt(n, dent);
    float along = dot(p, uSqAxis);
    vec3 perp = p - uSqAxis * along;
    return uSqAxis * along * uSq + perp / sqrt(uSq);   // volume-preserving squish
  }
  void main() {
    vec3 n = normalize(position);
    vec3 t1 = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(n, t1);
    float dent, dd;
    vec3 p0 = shape(n, dent);
    vec3 p1 = shape(normalize(n + t1 * 0.02), dd);
    vec3 p2 = shape(normalize(n + t2 * 0.02), dd);
    vec3 nrm = normalize(cross(p1 - p0, p2 - p0));
    vDent = dent; vLocal = n;
    vN = normalize(normalMatrix * nrm);
    vec4 mv = modelViewMatrix * vec4(p0, 1.0);
    vPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */`
  uniform vec3 cTop; uniform vec3 cBottom; uniform vec3 cDeep; uniform float uDark;
  varying vec3 vN; varying vec3 vPos; varying float vDent; varying vec3 vLocal;
  void main() {
    vec3 N = normalize(vN);
    vec3 V = normalize(-vPos);
    vec3 L = normalize(vec3(-0.5, 0.75, 0.6));
    float wrap = clamp((dot(N, L) + 0.45) / 1.45, 0.0, 1.0);
    vec3 base = mix(cBottom, cTop, smoothstep(-0.9, 0.9, vLocal.y));
    vec3 col = mix(cDeep, base, wrap);
    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.5);
    col += base * fres * 0.55;                                    // soft translucent rim
    float spec = pow(clamp(dot(N, normalize(L + V)), 0.0, 1.0), 40.0);
    col += vec3(spec) * 0.55;
    col += base * clamp(vDent, 0.0, 1.0) * 0.6;                   // pressed areas glow softly
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;

class Spring {
  constructor(k, c) { this.x = 0; this.v = 0; this.target = 0; this.k = k; this.c = c; }
  step(dt) { this.v += (this.k * (this.target - this.x) - this.c * this.v) * dt; this.x += this.v * dt; }
}

export default class JellyBlob {
  init(renderer, audio, settings) {
    this.audio = audio; this.s = settings; this.pal = settings.palette;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.camera.position.set(0, 0.6, 13);
    this.camera.lookAt(0, 0, 0);
    this.backdrop = makeBackdrop(this.pal);
    this.scene.add(this.backdrop);

    const cols = this.pal.colors.map((c) => new THREE.Color(c));
    const deep = cols[4].clone().multiplyScalar(this.pal.dark ? 0.25 : 0.6);
    this.uniforms = {
      uDent: { value: Array.from({ length: MAX_DENTS }, () => new THREE.Vector4(0, 1, 0, 0)) },
      uDentCos: { value: 0.07 },
      uWob: { value: new THREE.Vector3() },
      uSqAxis: { value: new THREE.Vector3(1, 0, 0) },
      uSq: { value: 1 },
      uBreath: { value: 0 },
      uTime: { value: 0 },
      cTop: { value: cols[1] }, cBottom: { value: cols[4] }, cDeep: { value: deep },
      uDark: { value: this.pal.dark ? 1 : 0 },
    };
    const seg = this.s.density === 'low' ? 64 : this.s.density === 'high' ? 112 : 88;
    const geo = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.75));
    this.blob = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG }));
    this.blob.frustumCulled = false;
    this.root = new THREE.Group();
    this.root.add(this.blob);
    this.scene.add(this.root);

    // Soft contact shadow / glow under the blob.
    const shadowMat = new THREE.ShaderMaterial({
      uniforms: { c: { value: new THREE.Color(this.pal.dark ? cols[1] : '#5a5480') }, a: { value: this.pal.dark ? 0.18 : 0.16 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} ',
      fragmentShader: 'uniform vec3 c; uniform float a; varying vec2 vUv; void main(){ float d=length(vUv-0.5)*2.0; gl_FragColor=vec4(c, a*pow(1.0-clamp(d,0.0,1.0),2.0)); \n#include <colorspace_fragment>\n }',
      transparent: true, depthWrite: false,
      blending: this.pal.dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
    this.shadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.shadow);

    this.dents = Array.from({ length: MAX_DENTS }, () => ({ spring: new Spring(110, 9), dir: new THREE.Vector3(0, 1, 0), goal: new THREE.Vector3(0, 1, 0), owner: null }));
    this.wob = [new Spring(38, 1.6), new Spring(46, 1.8), new Spring(30, 1.4)];
    this.squish = new Spring(70, 5); this.squish.x = this.squish.target = 1;
    this.leanX = new Spring(20, 6); this.leanY = new Spring(20, 6);
    this.radius = 3;
    this.pointers = [];
    this.pinch = null;
    this.limiter = new RateLimiter(5, 2);
    this.pad = null;
    this.tmp = new THREE.Vector3(); this.tmp2 = new THREE.Vector3();
    this.inv = new THREE.Quaternion();
    this.spin = 0;
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.backdrop.material.uniforms.uAspect.value = w / h;
    const vis = visibleSize(this.camera, 13);
    this.radius = Math.min(vis.w, vis.h) * 0.27;
    this.root.scale.setScalar(this.radius);
    this.shadow.scale.set(this.radius * 2.6, this.radius * 1.3, 1);
    this.shadow.position.set(0, -this.radius * 1.12, 0);
  }

  // ---- input ---------------------------------------------------------------

  /** Ray–sphere hit in blob-local unit coordinates; returns true and writes dir. */
  _hit(p, outDir) {
    const ray = ndcRay(this.camera, p.nx, p.ny);
    const c = this.root.position, r = this.radius * 1.02;
    this.tmp.copy(ray.origin).sub(c);
    const b = this.tmp.dot(ray.direction), cc = this.tmp.lengthSq() - r * r;
    const disc = b * b - cc;
    if (disc < 0) return false;
    const t = -b - Math.sqrt(disc);
    outDir.copy(ray.direction).multiplyScalar(t).add(this.tmp).normalize();
    // Into the blob's rotating local frame so the dent stays under the finger.
    this.blob.getWorldQuaternion(this.inv).invert();
    outDir.applyQuaternion(this.inv);
    return true;
  }

  _ensurePad() { if (!this.pad || !this.pad.alive) this.pad = this.audio.pad('warm', this.audio.freq(-5)); return this.pad; }

  onPointerDown(p) {
    this.pointers.push(p);
    p.data = { dent: null, missX: p.nx, missY: p.ny };
    const dir = this.tmp2;
    if (this._hit(p, dir)) {
      const d = this.dents.find((q) => !q.owner) || this.dents[0];
      d.owner = p; d.dir.copy(dir); d.goal.copy(dir);
      d.spring.target = 0.2; d.spring.c = 9;
      p.data.dent = d;
      const up = clamp((p.ny + 1) / 2, 0, 1);
      this.audio.squish(this.audio.freq(this.audio.stepFromUnit(up, -4, 6)), 0.6, p.nx * 0.6, 0.35);
      this.wob[0].v += 0.25; this.wob[1].v += (dir.x * dir.z) * 0.6;
    } else {
      this.audio.squish(this.audio.freq(-6), 0.3, p.nx * 0.6, 0.2);
    }
    this._updateLean();
    // Two fingers → pinch squish along the line between them.
    if (this.pointers.length === 2) {
      const [a, b] = this.pointers;
      this.pinch = { a, b, d0: Math.max(40, Math.hypot(a.x - b.x, a.y - b.y)) };
      this.uniforms.uSqAxis.value.set(b.x - a.x, -(b.y - a.y), 0).normalize().applyQuaternion(this.blob.quaternion.clone().invert());
      this._ensurePad();
    }
  }

  onPointerMove(p) {
    if (!p.data) return;
    if (p.data.dent && this._hit(p, this.tmp2)) {
      const moved = p.data.dent.goal.angleTo(this.tmp2);
      p.data.dent.goal.copy(this.tmp2);
      if (moved > 0.08 && this.limiter.take(performance.now() / 1000)) {
        const up = clamp((p.ny + 1) / 2, 0, 1);
        this.audio.squish(this.audio.freq(this.audio.stepFromUnit(up, -4, 6)), clamp(p.speed / 2500, 0.15, 0.5), p.nx * 0.6, 0.3);
      }
    }
    this._updateLean();
  }

  onPointerUp(p) {
    const i = this.pointers.indexOf(p);
    if (i >= 0) this.pointers.splice(i, 1);
    if (p.data && p.data.dent) {
      const d = p.data.dent;
      d.owner = null; d.spring.target = 0; d.spring.c = 4; // under-damped → pops out & wobbles
      this.wob[0].v -= d.spring.x * 1.6; this.wob[2].v += d.spring.x * 1.2;
      this.audio.bubble(this.audio.freq(this.audio.stepFromUnit(clamp((p.ny + 1) / 2, 0, 1), 1, 8)), 0.35, p.nx * 0.6);
    }
    if (this.pinch && (p === this.pinch.a || p === this.pinch.b)) {
      this.pinch = null; this.squish.target = 1;
      this.wob[1].v += (1 - this.squish.x) * 2;
      if (this.pad) { this.pad.stop(0.6); this.pad = null; }
    }
    this._updateLean();
  }

  _updateLean() {
    let x = 0, y = 0, n = 0;
    for (const p of this.pointers) { if (!p.data.dent) { x += p.nx; y += p.ny; n++; } }
    this.leanX.target = n ? (x / n) * 0.5 : 0;
    this.leanY.target = n ? (y / n) * 0.35 : 0;
  }

  // ---- simulation ----------------------------------------------------------

  update(dt, time) {
    const u = this.uniforms;
    for (let i = 0; i < MAX_DENTS; i++) {
      const d = this.dents[i];
      if (d.owner) {
        // Pressing longer sinks a little deeper; a pressure-capable pen sinks more.
        const held = Math.min(1, (performance.now() / 1000 - d.owner.downTime) / 1.5);
        d.spring.target = 0.18 + 0.12 * held + (d.owner.pressure - 0.5) * 0.2;
        d.dir.lerp(d.goal, 1 - Math.exp(-dt * 18)).normalize();
      }
      d.spring.step(dt);
      u.uDent.value[i].set(d.dir.x, d.dir.y, d.dir.z, d.spring.x);
    }
    for (const w of this.wob) w.step(dt);
    u.uWob.value.set(this.wob[0].x * 0.12, this.wob[1].x * 0.12, this.wob[2].x * 0.08);

    if (this.pinch) {
      const { a, b, d0 } = this.pinch;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.squish.target = clamp(d / d0, 0.7, 1.25);
      const amt = Math.abs(1 - this.squish.x);
      this._ensurePad().set(clamp(amt * 3, 0, 0.9), 0.15 + amt * 1.5, this.audio.freq(this.squish.x < 1 ? -6 : -3), (a.nx + b.nx) * 0.3);
    }
    this.squish.step(dt);
    u.uSq.value = this.squish.x;

    this.leanX.step(dt); this.leanY.step(dt);
    this.root.position.set(this.leanX.x * this.radius * 0.5, this.leanY.x * this.radius * 0.35, 0);
    this.root.rotation.z = -this.leanX.x * 0.25;

    const calm = this.s.reducedMotion ? 0.3 : 1;
    u.uBreath.value = Math.sin(time * 0.7) * 0.025 * calm;
    u.uTime.value = time;
    this.spin += dt * 0.12 * calm;
    this.blob.rotation.set(Math.sin(time * 0.13) * 0.15 * calm, this.spin, 0);
    this.shadow.position.x = this.root.position.x;
  }

  dispose() { if (this.pad) this.pad.stop(); this.pointers.length = 0; }
}
