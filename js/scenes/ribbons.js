/**
 * Scene 5 — Silk Ribbons
 *
 * PHYSICS: each finger draws a ribbon from a trail of points (a short history
 * buffer, resampled at an even spacing so fast swipes stay smooth). Every
 * trail point keeps a little of the finger's velocity and then drifts in a
 * slow, smooth flow field, so drawn ribbons keep flowing like silk in water
 * while they fade out over ~6 s. The strip mesh is rebuilt each frame from the
 * trail: width tapers towards the tail, and the strip twists slowly around its
 * own path so the sheen rolls along it. Geometry is preallocated per ribbon
 * (a fixed pool) and only its buffers are rewritten — nothing is allocated.
 *
 * COLOUR: a soft rainbow along each ribbon, slowly shifting over time.
 *
 * SOUND: every live ribbon owns a warm pad. Its note comes from where the
 * finger started (height → pentatonic step); its volume and brightness follow
 * the ribbon's speed, so drawing faster swells the tone and stopping lets it
 * settle. Pads fade out gently when the finger lifts.
 *
 * IDLE: after a few quiet seconds a faint "ghost" ribbon drifts in a slow
 * figure-of-eight, silently.
 */
import * as THREE from 'three';
import { makeBackdrop, clamp, visibleSize } from '../util.js';

const SEG = 96;          // trail points per ribbon
const POOL = 10;         // ribbons in the pool
const LIFE = 6.5;        // seconds a trail point lives
const SPACING = 0.14;    // world units between trail points

const VERT = /* glsl */`
  attribute float aU; attribute float aAlpha; attribute float aShade;
  uniform float uTime; uniform float uHue;
  varying float vU; varying float vA; varying float vS;
  void main() {
    vU = aU; vA = aAlpha; vS = aShade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const FRAG = /* glsl */`
  uniform float uTime; uniform float uHue; uniform float uSat; uniform float uLight; uniform float uOpacity;
  varying float vU; varying float vA; varying float vS;
  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }
  void main() {
    float h = fract(uHue + vU * 0.35 + uTime * 0.015);
    vec3 col = hsl2rgb(h, uSat, uLight) * (0.65 + 0.45 * vS);
    col += vec3(pow(vS, 10.0) * 0.12);                  // soft sheen as the silk turns
    gl_FragColor = vec4(col, vA * uOpacity);
    #include <colorspace_fragment>
  }`;

class Ribbon {
  constructor(scene, pal, hue) {
    this.px = new Float32Array(SEG); this.py = new Float32Array(SEG); this.pz = new Float32Array(SEG);
    this.vx = new Float32Array(SEG); this.vy = new Float32Array(SEG);
    this.age = new Float32Array(SEG);
    this.count = 0; this.owner = null; this.ghost = false; this.alive = false;
    this.pad = null; this.speed = 0; this.phase = hue * 10;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(SEG * 2 * 3);
    this.alpha = new Float32Array(SEG * 2);
    this.shade = new Float32Array(SEG * 2);
    const u = new Float32Array(SEG * 2);
    for (let i = 0; i < SEG; i++) { u[i * 2] = u[i * 2 + 1] = i / (SEG - 1); }
    const idx = new Uint16Array((SEG - 1) * 6);
    for (let i = 0, o = 0; i < SEG - 1; i++) { const a = i * 2; idx[o++] = a; idx[o++] = a + 1; idx[o++] = a + 2; idx[o++] = a + 1; idx[o++] = a + 3; idx[o++] = a + 2; }
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    this.shadeAttr = new THREE.BufferAttribute(this.shade, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aAlpha', this.alphaAttr);
    geo.setAttribute('aShade', this.shadeAttr);
    geo.setAttribute('aU', new THREE.BufferAttribute(u, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    this.uniforms = {
      uTime: { value: 0 }, uHue: { value: hue },
      uSat: { value: pal.contrast ? 1.0 : pal.dark ? 0.7 : 0.75 },
      uLight: { value: pal.contrast ? 0.55 : pal.dark ? 0.62 : 0.6 },
      uOpacity: { value: 1 },
    };
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: pal.dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  start(x, y, owner, ghost) {
    this.count = 0; this.owner = owner; this.ghost = ghost; this.alive = true;
    this.uniforms.uOpacity.value = ghost ? 0.3 : 0.85;
    this.lastX = x; this.lastY = y;
    this.push(x, y, 0, 0);
  }

  /** Add a point at the head (index 0), shifting the trail back. */
  push(x, y, vx, vy) {
    const n = Math.min(this.count, SEG - 1);
    this.px.copyWithin(1, 0, n); this.py.copyWithin(1, 0, n); this.pz.copyWithin(1, 0, n);
    this.vx.copyWithin(1, 0, n); this.vy.copyWithin(1, 0, n); this.age.copyWithin(1, 0, n);
    this.px[0] = x; this.py[0] = y; this.pz[0] = 0;
    this.vx[0] = vx * 0.12; this.vy[0] = vy * 0.12; this.age[0] = 0;
    this.count = Math.min(SEG, this.count + 1);
  }

  /** Follow the finger: insert evenly spaced points from the last head to (x, y). */
  follow(x, y, vx, vy) {
    let dx = x - this.lastX, dy = y - this.lastY;
    let d = Math.hypot(dx, dy);
    let guard = 12;
    while (d >= SPACING && guard-- > 0) {
      this.lastX += (dx / d) * SPACING; this.lastY += (dy / d) * SPACING;
      this.push(this.lastX, this.lastY, vx, vy);
      dx = x - this.lastX; dy = y - this.lastY; d = Math.hypot(dx, dy);
    }
    if (guard <= 0) { this.lastX = x; this.lastY = y; }
  }

  update(dt, time, width, flow) {
    const { px, py, pz, vx, vy, age, pos, alpha, shade } = this;
    const n = this.count;
    let oldest = 0;
    const damp = Math.exp(-dt * 0.8);
    for (let i = 0; i < n; i++) {
      age[i] += dt;
      // keep a little of the finger's motion, then drift in a slow flow field
      vx[i] = vx[i] * damp + Math.sin(py[i] * 0.35 + time * 0.25) * flow * dt;
      vy[i] = vy[i] * damp + (Math.cos(px[i] * 0.3 - time * 0.2) * flow + 0.12 * flow) * dt;
      px[i] += vx[i] * dt; py[i] += vy[i] * dt;
      pz[i] = Math.sin(time * 0.6 + i * 0.12 + this.phase) * 0.4 * Math.min(1, age[i]);
      if (age[i] > oldest) oldest = age[i];
    }
    if (!this.owner && (n === 0 || age[0] > LIFE)) { this.alive = false; this.mesh.geometry.setDrawRange(0, 0); return; }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = px[a] - px[b], ty = py[a] - py[b];
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const twist = time * 0.45 + i * 0.035 + this.phase;
      const c = Math.cos(twist), s = Math.sin(twist);
      const life = clamp(1 - age[i] / LIFE, 0, 1);
      const taper = Math.sin(Math.min(1, (i + 1) / Math.max(4, n)) * Math.PI * 0.5 + 0.25) * Math.min(1, (n - i) / 6);
      const w = width * (0.3 + 0.7 * life) * taper;
      // side vector: perpendicular in the screen plane, rolled around the path by `twist`
      const sx = -ty * c * w, sy = tx * c * w, sz = s * w * 0.7;
      const o = i * 6;
      pos[o] = px[i] + sx; pos[o + 1] = py[i] + sy; pos[o + 2] = pz[i] + sz;
      pos[o + 3] = px[i] - sx; pos[o + 4] = py[i] - sy; pos[o + 5] = pz[i] - sz;
      const al = Math.min(1, life * 1.6) * Math.min(1, (n - i) / 3) * Math.min(1, (i + 1) / 3);
      alpha[i * 2] = alpha[i * 2 + 1] = al;
      shade[i * 2] = shade[i * 2 + 1] = Math.abs(c);
    }
    this.mesh.geometry.setDrawRange(0, Math.max(0, n - 1) * 6);
    this.posAttr.needsUpdate = true; this.alphaAttr.needsUpdate = true; this.shadeAttr.needsUpdate = true;
    this.uniforms.uTime.value = time;
  }
}

export default class SilkRibbons {
  init(renderer, audio, settings) {
    this.audio = audio; this.s = settings; this.pal = settings.palette;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.set(0, 0, 20);
    this.backdrop = makeBackdrop(this.pal);
    this.scene.add(this.backdrop);
    this.ribbons = Array.from({ length: POOL }, (_, i) => new Ribbon(this.scene, this.pal, (i * 0.17) % 1));
    this.next = 0;
    this.quiet = 0;
    this.ghost = null;
    this.halfW = 14; this.halfH = 10;
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.backdrop.material.uniforms.uAspect.value = w / h;
    const v = visibleSize(this.camera, 20);
    this.halfW = v.w / 2; this.halfH = v.h / 2;
    this.width = Math.min(v.w, v.h) * 0.04;
  }

  _take() {
    // Prefer a free ribbon; otherwise reuse the one that has been free longest.
    for (let k = 0; k < POOL; k++) { const r = this.ribbons[(this.next + k) % POOL]; if (!r.alive) { this.next = (this.next + k + 1) % POOL; return r; } }
    for (let k = 0; k < POOL; k++) { const r = this.ribbons[(this.next + k) % POOL]; if (!r.owner) { this.next = (this.next + k + 1) % POOL; return r; } }
    return null;
  }

  onPointerDown(p) {
    if (this.ghost) { this.ghost.owner = null; this.ghost = null; }
    const r = this._take();
    if (!r) return;
    const x = p.nx * this.halfW, y = p.ny * this.halfH;
    r.start(x, y, p, false);
    p.data = { r };
    const step = this.audio.stepFromUnit((p.ny + 1) / 2, 2, 12);
    if (r.pad) r.pad.stop();
    r.pad = this.audio.pad('warm', this.audio.freq(step));
    r.pad.set(0.25, 0.15, null, p.nx * 0.6, 0.08);
    this.quiet = 0;
  }
  onPointerMove(p) {
    if (!p.data || p.data.r.owner !== p) return;
    const k = (this.halfW * 2) / window.innerWidth;
    p.data.r.follow(p.nx * this.halfW, p.ny * this.halfH, p.vx * k, -p.vy * k);
  }
  onPointerUp(p) {
    if (!p.data) return;
    const r = p.data.r;
    if (r.owner === p) {
      r.owner = null;
      if (r.pad) { r.pad.stop(0.9); r.pad = null; }
    }
  }

  update(dt, time) {
    const flow = this.s.reducedMotion ? 0.25 : 0.6;
    let anyOwned = false;
    for (const r of this.ribbons) {
      if (!r.alive) continue;
      if (r.owner && !r.ghost) {
        anyOwned = true;
        // speed → pad level & brightness (pixels/s → 0..1), smoothed
        const sp = clamp(r.owner.speed / 1400, 0, 1);
        r.speed += (sp - r.speed) * (1 - Math.exp(-dt * 6));
        if (r.pad) r.pad.set(0.2 + r.speed * 0.8, 0.12 + r.speed * 0.7, null, r.owner.nx * 0.6);
      }
      r.update(dt, time, this.width, flow);
    }
    // Idle ghost ribbon after a few quiet seconds.
    this.quiet = anyOwned ? 0 : this.quiet + dt;
    if (this.quiet > 3 && !this.ghost) {
      const r = this._take();
      if (r) { this.ghost = r; this.ghostT = 0; r.start(0, 0, { ghost: true }, true); }
    }
    if (this.ghost) {
      this.ghostT += dt * (this.s.reducedMotion ? 0.12 : 0.22);
      const t = this.ghostT;
      const x = Math.sin(t) * this.halfW * 0.55, y = Math.sin(t * 2) * this.halfH * 0.35;
      this.ghost.follow(x, y, 0, 0);
    }
  }

  dispose() { for (const r of this.ribbons) if (r.pad) r.pad.stop(); }
}
