/**
 * Scene 8 — Kaleidoscope
 *
 * GEOMETRY: touches paint soft shapes (circle, petal, diamond, ring, star) that
 * are mirrored into an N-fold radial symmetry (N = 6–12, set by parents):
 * every painted shape becomes 2·N instances — N rotations plus their mirror
 * images. All instances live in one InstancedMesh; each instance stores its
 * birth time, so fading in (0.35 s) and out (over ~10 s) happens entirely in
 * the shader with no per-frame CPU work. The whole pattern turns very slowly.
 * Shapes use a ring buffer: the oldest (already faded) slots are reused.
 *
 * SOUND: soft bells (FM chimes). Pitch follows distance from the centre —
 * low near the middle, higher towards the edge — pan follows x, volume
 * follows stroke speed. Bells are rate-limited (≤ 7/s) so long strokes ring
 * like a gentle wind chime.
 *
 * IDLE: a faint seed mandala breathes slowly at the centre while the
 * kaleidoscope turns.
 */
import * as THREE from 'three';
import { makeBackdrop, clamp, RateLimiter } from '../util.js';

const SHAPE_GLSL = /* glsl */`
  float shapeAlpha(vec2 p, float kind) {
    float d;
    if (kind < 0.5) d = length(p);                                         // circle
    else if (kind < 1.5) d = length(vec2(p.x * 0.62, p.y * 1.7));          // petal
    else if (kind < 2.5) d = (abs(p.x) + abs(p.y)) * 1.05;                 // diamond
    else if (kind < 3.5) d = abs(length(p) - 0.68) * 3.2;                  // ring
    else { float a = atan(p.y, p.x); d = length(p) / (0.72 + 0.28 * cos(5.0 * a)); } // star
    return smoothstep(1.0, 0.72, d);
  }`;

export default class Kaleidoscope {
  init(renderer, audio, settings) {
    this.audio = audio; this.s = settings; this.pal = settings.palette;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -10, 10);
    this.backdrop = makeBackdrop(this.pal);
    this.scene.add(this.backdrop);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    const seg = this.seg = clamp(Math.round(settings.kaleidoSegments || 8), 6, 12);
    this.per = seg * 2;
    this.maxShapes = Math.round(150 * settings.densityFactor);
    const count = this.maxShapes * this.per;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.birth = new Float32Array(count).fill(-1000);
    this.kind = new Float32Array(count);
    this.birthAttr = new THREE.InstancedBufferAttribute(this.birth, 1).setUsage(THREE.DynamicDrawUsage);
    this.kindAttr = new THREE.InstancedBufferAttribute(this.kind, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aBirth', this.birthAttr);
    geo.setAttribute('aKind', this.kindAttr);
    this.uniforms = { uTime: { value: 0 }, uGlow: { value: this.pal.dark ? 1 : 0 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute float aBirth; attribute float aKind;
        uniform float uTime;
        varying vec2 vUv; varying float vA; varying float vKind; varying vec3 vCol;
        void main() {
          vUv = uv; vKind = aKind; vCol = instanceColor;
          float age = uTime - aBirth;
          vA = smoothstep(0.0, 0.35, age) * (1.0 - smoothstep(6.0, 10.0, age));
          float grow = 0.75 + 0.25 * smoothstep(0.0, 0.5, age);
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position * grow, 1.0);
          if (vA <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);  // cull invisible instances
        }`,
      fragmentShader: /* glsl */`
        uniform float uGlow;
        varying vec2 vUv; varying float vA; varying float vKind; varying vec3 vCol;
        ${SHAPE_GLSL}
        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          float a = shapeAlpha(p, vKind) * vA;
          if (a < 0.003) discard;
          vec3 col = vCol * (0.85 + 0.3 * (1.0 - length(p)));
          gl_FragColor = vec4(col, a * mix(0.85, 0.6, uGlow));
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, depthTest: false,
      blending: this.pal.dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.mesh);
    this.slot = 0;

    this.makeSeed();
    // on the light theme, deepen colours a little so shapes don't wash out
    this.cols6 = this.pal.colors.map((c) => (this.pal.dark ? new THREE.Color(c) : new THREE.Color(c).multiplyScalar(0.8)));
    this.limiter = new RateLimiter(7, 3);
    this.dummy = new THREE.Object3D();
    this.strokes = 0;
    this.time = 0;
    this.halfW = 10; this.halfH = 10;
  }

  /** The idle "seed" mandala: a few rings of faint dots, breathing slowly. */
  makeSeed() {
    const per = this.per, rings = 3, n = rings * per + 1;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.seedU = { uTime: { value: 0 }, uC: { value: new THREE.Color(this.pal.colors[4]) }, uA: { value: this.pal.dark ? 0.22 : 0.3 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.seedU,
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);} ',
      fragmentShader: /* glsl */`
        uniform float uTime; uniform vec3 uC; uniform float uA; varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.3, d) * uA * (0.65 + 0.35 * sin(uTime * 0.6));
          gl_FragColor = vec4(uC, a);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, depthTest: false,
      blending: this.pal.dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.seed = new THREE.InstancedMesh(geo, mat, n);
    const o = new THREE.Object3D();
    let i = 0;
    o.position.set(0, 0, 0); o.scale.setScalar(2.2); o.updateMatrix(); this.seed.setMatrixAt(i++, o.matrix);
    for (let r = 0; r < rings; r++) {
      for (let k = 0; k < per; k++) {
        const a = (k / per) * Math.PI * 2 + (r & 1 ? Math.PI / per : 0);
        const rad = 1.8 + r * 1.6;
        o.position.set(Math.cos(a) * rad, Math.sin(a) * rad, 0);
        o.scale.setScalar(0.5 + r * 0.15); o.updateMatrix(); this.seed.setMatrixAt(i++, o.matrix);
      }
    }
    this.seed.renderOrder = -1;
    this.root.add(this.seed);
  }

  resize(w, h) {
    const aspect = w / h;
    this.halfH = 10; this.halfW = 10 * aspect;
    if (aspect < 1) { this.halfW = 10; this.halfH = 10 / aspect; }
    Object.assign(this.camera, { left: -this.halfW, right: this.halfW, top: this.halfH, bottom: -this.halfH });
    this.camera.updateProjectionMatrix();
    this.backdrop.material.uniforms.uAspect.value = aspect;
    this.maxR = Math.min(this.halfW, this.halfH);
  }

  /** Paint one shape at world (wx, wy), mirrored into every segment. */
  paint(wx, wy, size, colorIdx, kind, speed01, nx) {
    // into the rotating frame, so the shape appears exactly under the finger
    const rot = this.root.rotation.z, c = Math.cos(-rot), s = Math.sin(-rot);
    const lx = wx * c - wy * s, ly = wx * s + wy * c;
    const r = Math.hypot(lx, ly), th = Math.atan2(ly, lx);
    const spin = th * 2.0;
    const base = this.slot * this.per;
    const col = this.cols6[colorIdx % this.cols6.length];
    const o = this.dummy;
    for (let k = 0; k < this.seg; k++) {
      const off = (k / this.seg) * Math.PI * 2;
      for (let m = 0; m < 2; m++) {
        const a = (m ? -th : th) + off;
        const i = base + k * 2 + m;
        o.position.set(Math.cos(a) * r, Math.sin(a) * r, 0);
        o.rotation.set(0, 0, (m ? -spin : spin) + off);
        o.scale.set(size, size, 1);
        o.updateMatrix();
        this.mesh.setMatrixAt(i, o.matrix);
        this.mesh.setColorAt(i, col);
        this.birth[i] = this.time; this.kind[i] = kind;
      }
    }
    // upload only the changed range (the renderer clears the ranges after uploading)
    const n = this.per;
    this.mesh.instanceMatrix.addUpdateRange(base * 16, n * 16); this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.addUpdateRange(base * 3, n * 3); this.mesh.instanceColor.needsUpdate = true;
    this.birthAttr.addUpdateRange(base, n); this.birthAttr.needsUpdate = true;
    this.kindAttr.addUpdateRange(base, n); this.kindAttr.needsUpdate = true;
    this.slot = (this.slot + 1) % this.maxShapes;

    if (this.limiter.take(performance.now() / 1000)) {
      const step = this.audio.stepFromUnit(r / this.maxR, 4, 16);
      this.audio.chime(this.audio.freq(step), 0.2 + 0.4 * speed01, nx * 0.7, 0.35 + 0.3 * speed01, 2.0);
    }
  }

  onPointerDown(p) {
    this.strokes++;
    p.data = { lx: p.nx * this.halfW, ly: p.ny * this.halfH, kind: this.strokes % 5, ci: p.colorIndex + this.strokes };
    this.paint(p.data.lx, p.data.ly, 1.1, p.data.ci, p.data.kind, 0.3, p.nx);
  }
  onPointerMove(p) {
    if (!p.data) return;
    const x = p.nx * this.halfW, y = p.ny * this.halfH;
    const d = Math.hypot(x - p.data.lx, y - p.data.ly);
    if (d < 0.75) return;
    p.data.lx = x; p.data.ly = y;
    const sp = clamp(p.speed / 1500, 0, 1);
    p.data.ci += d > 1.5 ? 1 : 0;
    this.paint(x, y, 0.8 + 0.5 * sp, Math.floor(p.data.ci), p.data.kind, sp, p.nx);
  }
  onPointerUp() {}

  update(dt, time) {
    this.time = time;
    this.uniforms.uTime.value = time;
    this.seedU.uTime.value = time;
    this.root.rotation.z += dt * (this.s.reducedMotion ? 0.012 : 0.035);
  }

  dispose() {}
}
