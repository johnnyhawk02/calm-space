/**
 * Scene 9 — Squishy Mirror
 *
 * The front camera's live picture (mirrored, like a mirror) is drawn on a
 * finely divided sheet, and that sheet is a soft 2D mass–spring grid:
 *   • every vertex has a displacement held by a damped spring, coupled to its
 *     neighbours (discrete Laplacian), so the picture behaves like jelly;
 *   • a finger grabs a smooth Gaussian patch: dragging pulls and smears it
 *     after the finger, holding still makes the patch swell outwards like a
 *     magnifying bubble (bigger the longer you hold);
 *   • letting go springs it back with a gentle wobble. The border is pinned.
 * The picture always returns to normal: nothing is moulded permanently here.
 *
 * CAMERA: front or back, switched with the button on the left (shown only when
 * the device has two cameras). Only the front camera is mirrored.
 *
 * PRIVACY: the camera is only requested when this scene opens, the picture
 * never leaves the device (it is not recorded, saved or uploaded), and the
 * camera is switched off as soon as you leave the scene. If there is no
 * camera, or permission is refused, a soft colourful pattern is used instead,
 * so the scene still works.
 *
 * SOUND: prods give soft squish tones (pitch from height on screen), pulling
 * fades in a warm pad that climbs the pentatonic scale with the stretch, and
 * release gives a soft bloop.
 */
import * as THREE from 'three';
import { clamp, RateLimiter } from '../util.js';

const MAX_GRABS = 5;
const K = 38, C = 3.0, KC = 140;   // spring, damping, neighbour coupling
const KG = 260;                     // how firmly a finger holds its patch
const SIGMA = 0.16;                 // patch size (fraction of screen height)

// Which camera to use ('user' = front, 'environment' = back), remembered on this device.
const FACING_KEY = 'calm-space-camera';
const loadFacing = () => { try { return localStorage.getItem(FACING_KEY) === 'environment' ? 'environment' : 'user'; } catch (e) { return 'user'; } };
const saveFacing = (f) => { try { localStorage.setItem(FACING_KEY, f); } catch (e) { /* private mode */ } };

export default class SquishyMirror {
  init(renderer, audio, settings) {
    this.audio = audio; this.s = settings; this.pal = settings.palette;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.pal.bg);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
    this.limiter = new RateLimiter(5, 2);
    this.grabs = [];
    this.disposed = false;
    this.aspect = 1;
    this.fallback = this.makePattern();
    this.uniforms = {
      uTex: { value: this.fallback },
      uScale: { value: new THREE.Vector2(1, 1) },
      uMirror: { value: 0 },
      uDark: { value: this.pal.dark ? 1 : 0 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute float aStretch;
        varying vec2 vUv; varying float vS;
        void main() { vUv = uv; vS = aStretch; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uTex; uniform vec2 uScale; uniform float uMirror; uniform float uDark;
        varying vec2 vUv; varying float vS;
        void main() {
          vec2 uv = (vUv - 0.5) * uScale + 0.5;           // cover-fit the picture
          if (uMirror > 0.5) uv.x = 1.0 - uv.x;            // selfie mirror
          vec3 col = texture2D(uTex, uv).rgb;
          col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 0.9); // slightly softer colour
          col *= 1.0 + clamp(vS, 0.0, 1.0) * 0.18;         // squished areas catch a little light
          vec2 v = vUv - 0.5;
          col *= 1.0 - dot(v, v) * (0.55 + 0.25 * uDark);  // soft vignette
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = null;
    this.startCamera();
  }

  /** Soft pastel pattern used until (or instead of) the camera picture. */
  makePattern() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 512;
    const g = cv.getContext('2d');
    g.fillStyle = this.pal.bg; g.fillRect(0, 0, 512, 512);
    const cols = this.pal.colors;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      g.fillStyle = cols[(x + y * 3) % cols.length];
      g.globalAlpha = this.pal.dark ? 0.55 : 0.7;
      g.beginPath(); g.arc(32 + x * 64, 32 + y * 64, 22, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 0.25; g.strokeStyle = this.pal.ink; g.lineWidth = 2;
    for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, 512); g.moveTo(0, i * 64); g.lineTo(512, i * 64); g.stroke(); }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /**
   * Start (or switch to) the front or back camera. The choice is remembered on
   * this device. Only the front camera is mirrored, like a real mirror.
   */
  async startCamera(facing = loadFacing()) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || this.switching) return;
    this.switching = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (this.disposed) { stream.getTracks().forEach((t) => t.stop()); return; }
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = stream;
      const real = stream.getVideoTracks()[0]?.getSettings?.().facingMode;
      this.facing = real === 'environment' || real === 'user' ? real : facing;
      let v = this.video;
      if (!v) {
        v = this.video = document.createElement('video');
        v.setAttribute('playsinline', ''); v.muted = true; v.autoplay = true;
        v.addEventListener('resize', () => this.fit());
      }
      v.srcObject = stream;
      await v.play();
      if (this.disposed) return;
      if (!this.videoTex) {
        const tex = new THREE.VideoTexture(v);
        tex.colorSpace = THREE.SRGBColorSpace;
        this.videoTex = tex;
        this.uniforms.uTex.value = tex;
      }
      this.uniforms.uMirror.value = this.facing === 'user' ? 1 : 0;
      this.fit();
      this.buildCamButton();
    } catch (e) {
      console.info('[calm] camera not available, using pattern:', e && e.name);
    } finally {
      this.switching = false;
    }
  }

  /** Front/back switch on the left edge, shown only when there is more than one camera. */
  async buildCamButton() {
    if (this.camPad || this.disposed) return;
    let cams = 0;
    try { cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').length; } catch (e) { /* ignore */ }
    if (cams < 2 || this.camPad || this.disposed) return;
    const pad = this.camPad = document.createElement('div');
    pad.id = 'campad';
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.setAttribute('aria-label', 'Switch between front and back camera');
    b.innerHTML = '<svg viewBox="0 0 36 36"><rect x="5" y="10" width="26" height="19" rx="5"/><path d="M14 10l2-3h4l2 3"/><path d="M13 20a5 5 0 0 1 9-3M23 19a5 5 0 0 1-9 3"/><path d="M22 14v3h-3M14 25v-3h3"/></svg>';
    b.addEventListener('click', () => {
      const next = this.facing === 'user' ? 'environment' : 'user';
      saveFacing(next);
      this.audio.marimba(this.audio.freq(next === 'user' ? 9 : 7), 0.22, 0, 0.2);
      this.startCamera(next);
    });
    pad.appendChild(b);
    document.body.appendChild(pad);
  }

  /** Cover-fit the source picture to the screen. */
  fit() {
    const v = this.video;
    const srcA = v && v.videoWidth ? v.videoWidth / v.videoHeight : 1;
    const a = this.aspect;
    if (a > srcA) this.uniforms.uScale.value.set(1, srcA / a); else this.uniforms.uScale.value.set(a / srcA, 1);
  }

  /** Build the sheet grid for the current screen shape. */
  build() {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    const a = this.aspect;
    const rows = this.s.density === 'low' ? 44 : this.s.density === 'high' ? 80 : 60;
    const cols = Math.max(20, Math.round(rows * a));
    const geo = new THREE.PlaneGeometry(2 * a, 2, cols, rows);
    const n = geo.attributes.position.count;
    Object.assign(this, { cols, rows, n, W: cols + 1 });
    this.base = Float32Array.from(geo.attributes.position.array);
    this.dx = new Float32Array(n); this.dy = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n);
    this.pinned = new Uint8Array(n);
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) if (i === 0 || j === 0 || i === cols || j === rows) this.pinned[j * this.W + i] = 1;
    this.stretch = new Float32Array(n);
    geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aStretch', new THREE.BufferAttribute(this.stretch, 1).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    for (const g of this.grabs) g.alive = false;
    this.grabs.length = 0;
  }

  resize(w, h) {
    this.aspect = w / h;
    Object.assign(this.camera, { left: -this.aspect, right: this.aspect, top: 1, bottom: -1 });
    this.camera.updateProjectionMatrix();
    this.fit();
    this.build();
  }

  // ---- input ---------------------------------------------------------------
  _world(p, out) { out.x = p.nx * this.aspect; out.y = p.ny; return out; }

  onPointerDown(p) {
    if (this.grabs.length >= MAX_GRABS) return;
    const g = { alive: true, owner: p, ox: 0, oy: 0, Dx: 0, Dy: 0, t0: performance.now() / 1000, pad: null, step: 0 };
    const w = this._world(p, { x: 0, y: 0 });
    g.ox = w.x; g.oy = w.y;
    this.grabs.push(g);
    p.data = g;
    this.audio.squish(this.audio.freq(this.audio.stepFromUnit((p.ny + 1) / 2, -2, 7)), 0.45, p.nx * 0.6, 0.35);
  }
  onPointerMove(p) {
    const g = p.data;
    if (!g || !g.alive) return;
    g.Dx = p.nx * this.aspect - g.ox; g.Dy = p.ny - g.oy;
    const l = Math.hypot(g.Dx, g.Dy);
    if (l > 0.6) { g.Dx *= 0.6 / l; g.Dy *= 0.6 / l; }
  }
  onPointerUp(p) {
    const g = p.data;
    if (!g || !g.alive) return;
    g.alive = false;
    this.grabs.splice(this.grabs.indexOf(g), 1);
    if (g.pad) g.pad.stop(0.5);
    const st = Math.hypot(g.Dx, g.Dy);
    this.audio.bubble(this.audio.freq(this.audio.stepFromUnit(clamp(0.3 + st, 0, 1), 0, 8)), 0.3, p.nx * 0.6);
  }

  // ---- simulation ----------------------------------------------------------
  update(dt) {
    if (!this.mesh) return;
    const { n, W, dx, dy, vx, vy, base, pinned } = this;
    // springs + neighbour coupling
    for (let k = 0; k < n; k++) {
      if (pinned[k]) continue;
      const lx = dx[k - 1] + dx[k + 1] + dx[k - W] + dx[k + W] - 4 * dx[k];
      const ly = dy[k - 1] + dy[k + 1] + dy[k - W] + dy[k + W] - 4 * dy[k];
      vx[k] += (-K * dx[k] - C * vx[k] + KC * lx) * dt;
      vy[k] += (-K * dy[k] - C * vy[k] + KC * ly) * dt;
    }
    // fingers
    const now = performance.now() / 1000;
    const inv = 1 / (2 * SIGMA * SIGMA), R = SIGMA * 3;
    for (const g of this.grabs) {
      const held = now - g.t0, dl = Math.hypot(g.Dx, g.Dy);
      const bulge = (1 - Math.min(1, dl / 0.06)) * Math.min(0.11, 0.03 + held * 0.05);
      // only visit vertices near the grab origin
      const i0 = Math.max(1, Math.floor((g.ox - R + this.aspect) / (2 * this.aspect) * this.cols));
      const i1 = Math.min(this.cols - 1, Math.ceil((g.ox + R + this.aspect) / (2 * this.aspect) * this.cols));
      const j0 = Math.max(1, Math.floor((1 - (g.oy + R)) / 2 * this.rows));
      const j1 = Math.min(this.rows - 1, Math.ceil((1 - (g.oy - R)) / 2 * this.rows));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * W + i;
        const rx = base[k * 3] - g.ox, ry = base[k * 3 + 1] - g.oy;
        const w = Math.exp(-(rx * rx + ry * ry) * inv);
        if (w < 0.004) continue;
        const tx = w * g.Dx + rx * (bulge / SIGMA) * w, ty = w * g.Dy + ry * (bulge / SIGMA) * w;
        vx[k] += KG * w * (tx - dx[k]) * dt;
        vy[k] += KG * w * (ty - dy[k]) * dt;
      }
      // pulling hum
      const step = Math.round(dl * 12);
      if (dl > 0.05) {
        if (!g.pad || !g.pad.alive) g.pad = this.audio.pad('warm', this.audio.freq(-2));
        g.pad.set(Math.min(0.75, dl * 2.2), 0.12 + dl, this.audio.freq(-2 + step), g.owner.nx * 0.6);
      } else if (g.pad) g.pad.set(0, 0.1);
      if (step !== g.step && dl > 0.05 && this.limiter.take(now)) this.audio.squish(this.audio.freq(3 + step), 0.16, g.owner.nx * 0.6, 0.3);
      g.step = step;
    }
    // integrate + write
    const pos = this.mesh.geometry.attributes.position.array, st = this.stretch;
    for (let k = 0; k < n; k++) {
      if (!pinned[k]) { dx[k] += vx[k] * dt; dy[k] += vy[k] * dt; }
      pos[k * 3] = base[k * 3] + dx[k];
      pos[k * 3 + 1] = base[k * 3 + 1] + dy[k];
      st[k] = Math.min(1, Math.hypot(dx[k], dy[k]) * 6);
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.aStretch.needsUpdate = true;
  }

  dispose() {
    this.disposed = true;
    if (this.camPad) this.camPad.remove();
    for (const g of this.grabs) if (g.pad) g.pad.stop();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    if (this.videoTex) this.videoTex.dispose();
    this.fallback.dispose();
  }
}
