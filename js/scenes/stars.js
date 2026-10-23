/**
 * Scene 3 — Star Swarm
 *
 * PHYSICS: thousands of particles flocking with a grid-based boids model.
 * Each frame particles are binned into a coarse grid and every cell's average
 * velocity gives O(N) alignment (neighbours steer together, so the swarm moves
 * as flowing streams). Cohesion comes from the shared attractors and a slow,
 * smooth flow field that keeps the swarm gently drifting; separation comes
 * from a short-range push around each finger. (Cell-centroid cohesion and
 * separation were tried and dropped: they left visible grid lines.) Each finger is an attractor with a tangential swirl, so
 * stars orbit the finger rather than collapse onto it; every finger has its
 * own colour and nearby stars slowly take it on. On release the attraction
 * stops and the flock drifts apart (each star is weakly drawn back to its own
 * resting spot), softly kept inside the screen.
 * Particles are rendered on the GPU as one Points draw call with a custom
 * soft-sprite shader; the simulation uses preallocated typed arrays only.
 *
 * SOUND: one shimmering pad (stacked sines with slow tremolo) that swells in
 * volume and brightness with the swarm's average speed; its pitch follows the
 * first finger's height on the pentatonic scale. A quiet chime marks each
 * finger landing.
 *
 * IDLE: the flock wanders slowly through the flow field, twinkling softly.
 */
import * as THREE from 'three';
import { makeBackdrop, clamp, visibleSize, rng } from '../util.js';

const CELL = 1.4;

export default class StarSwarm {
  init(renderer, audio, settings) {
    this.audio = audio; this.s = settings; this.pal = settings.palette;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.set(0, 0, 20);
    this.backdrop = makeBackdrop(this.pal);
    this.scene.add(this.backdrop);

    const n = this.n = Math.round(3000 * settings.densityFactor);
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.base = new Float32Array(n * 3);
    this.cell = new Int32Array(n);
    this.home = new Float32Array(n * 2); // normalised (-1..1) resting spot each star drifts back towards
    const size = new Float32Array(n);
    const phase = new Float32Array(n);
    const rand = rng(7);
    const cols = this.pal.colors.map((c) => new THREE.Color(c));
    const tint = new THREE.Color();
    this.halfW = 14; this.halfH = 10;
    for (let i = 0; i < n; i++) {
      this.pos[i * 3] = (rand() * 2 - 1) * this.halfW;
      this.pos[i * 3 + 1] = (rand() * 2 - 1) * this.halfH;
      this.pos[i * 3 + 2] = (rand() * 2 - 1) * 3;
      this.home[i * 2] = this.pos[i * 3] / this.halfW; this.home[i * 2 + 1] = this.pos[i * 3 + 1] / this.halfH;
      const a = rand() * Math.PI * 2;
      this.vel[i * 3] = Math.cos(a) * 0.8; this.vel[i * 3 + 1] = Math.sin(a) * 0.8;
      // Resting colour: a pale mix of the palette.
      tint.copy(cols[i % cols.length]).lerp(this.pal.dark ? new THREE.Color('#ffffff') : new THREE.Color(this.pal.ink), 0.3);
      if (this.pal.dark) tint.multiplyScalar(0.6);
      this.base[i * 3] = this.col[i * 3] = tint.r;
      this.base[i * 3 + 1] = this.col[i * 3 + 1] = tint.g;
      this.base[i * 3 + 2] = this.col[i * 3 + 2] = tint.b;
      size[i] = 0.5 + rand() * rand() * 1.4;
      phase[i] = rand() * 100;
    }
    this.fingerCols = cols.map((c) => (this.pal.dark ? c.clone() : c.clone().multiplyScalar(0.85)));

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 300 }, uTime: { value: 0 }, uAlpha: { value: this.pal.dark ? 0.9 : 0.8 } },
      vertexShader: /* glsl */`
        attribute float aSize; attribute float aPhase; attribute vec3 color;
        uniform float uScale; uniform float uTime;
        varying vec3 vCol; varying float vTw;
        void main() {
          vCol = color;
          vTw = 0.75 + 0.25 * sin(uTime * 1.3 + aPhase);   // slow twinkle (well under 1 Hz)
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(aSize * uScale / -mv.z, 1.0, 48.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uAlpha;
        varying vec3 vCol; varying float vTw;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = pow(clamp(1.0 - d, 0.0, 1.0), 1.8);
          float core = smoothstep(0.35, 0.0, d);
          vec3 c = vCol + core * 0.35;
          gl_FragColor = vec4(c, a * uAlpha * vTw);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
      blending: this.pal.dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    this.fingers = [];
    this.pad = null;
    this.speedAvg = 0;
    this.grid = null;
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.backdrop.material.uniforms.uAspect.value = w / h;
    const vis = visibleSize(this.camera, 20);
    this.halfW = vis.w / 2; this.halfH = vis.h / 2;
    this.material.uniforms.uScale.value = h * 0.2 * Math.min(2, window.devicePixelRatio || 1);
    this.gw = Math.ceil((this.halfW * 2 + 8) / CELL); this.gh = Math.ceil((this.halfH * 2 + 8) / CELL);
    const cells = this.gw * this.gh;
    this.gN = new Float32Array(cells); this.gVX = new Float32Array(cells); this.gVY = new Float32Array(cells);
  }

  _world(p) {
    if (!p.data) p.data = { x: 0, y: 0 };
    p.data.x = p.nx * this.halfW; p.data.y = p.ny * this.halfH;
  }
  onPointerDown(p) {
    this._world(p);
    this.fingers.push(p);
    const step = this.audio.stepFromUnit((p.ny + 1) / 2, 8, 17);
    this.audio.chime(this.audio.freq(step), 0.25, p.nx * 0.7, 0.2, 2.2);
  }
  onPointerMove(p) { if (p.data) this._world(p); }
  onPointerUp(p) { const i = this.fingers.indexOf(p); if (i >= 0) this.fingers.splice(i, 1); }

  update(dt, time) {
    const { n, pos, vel, col, base, cell, gN, gVX, gVY, gw, gh } = this;
    const hw = this.halfW, hh = this.halfH;
    const ox = hw + 4, oy = hh + 4;
    gN.fill(0); gVX.fill(0); gVY.fill(0);

    // 1) bin into grid
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1];
      const cx = clamp(Math.floor((x + ox) / CELL), 0, gw - 1), cy = clamp(Math.floor((y + oy) / CELL), 0, gh - 1);
      const c = cy * gw + cx;
      cell[i] = c;
      gN[c]++; gVX[c] += vel[i * 3]; gVY[c] += vel[i * 3 + 1];
    }
    for (let c = 0; c < gN.length; c++) { const k = gN[c]; if (k > 0) { gVX[c] /= k; gVY[c] /= k; } }

    // 2) steer
    const F = this.fingers, nf = F.length;
    const calm = this.s.reducedMotion ? 0.5 : 1;
    const t = time * 0.12;
    const colRate = 1 - Math.exp(-dt * 2.5), backRate = 1 - Math.exp(-dt * 0.35);
    const damp = Math.exp(-dt * (nf ? 1.4 : 0.9));
    let speedSum = 0;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const x = pos[i3], y = pos[i3 + 1], z = pos[i3 + 2];
      let vx = vel[i3], vy = vel[i3 + 1], vz = vel[i3 + 2];
      const c = cell[i];
      let ax = (gVX[c] - vx) * 0.5;
      let ay = (gVY[c] - vy) * 0.5;
      // smooth drifting flow field
      ax += Math.sin(y * 0.23 + t + z * 0.3) * 0.9 * calm;
      ay += Math.cos(x * 0.19 - t * 1.3) * 0.9 * calm;
      let az = -z * 0.3;

      if (nf) {
        // nearest finger attracts with a swirl
        let best = 1e9, bi = 0;
        for (let f = 0; f < nf; f++) {
          const d = F[f].data; const dx = d.x - x, dy = d.y - y; const dd = dx * dx + dy * dy;
          if (dd < best) { best = dd; bi = f; }
        }
        const fd = F[bi].data; const dx = fd.x - x, dy = fd.y - y;
        const d = Math.sqrt(best) + 0.3;
        const pull = 14 / (1 + d * 0.25);
        const swirl = (bi & 1 ? -1 : 1) * 6 / (1 + d * 0.4);
        ax += (dx / d) * pull - (dy / d) * swirl;
        ay += (dy / d) * pull + (dx / d) * swirl;
        if (d < 2.2) { ax -= (dx / d) * 18 * (2.2 - d); ay -= (dy / d) * 18 * (2.2 - d); } // don't pile on the finger
        // take on the finger's colour, more strongly when close
        if (d < 9) {
          const fc = this.fingerCols[F[bi].colorIndex];
          const k = colRate * (1 - d / 9);
          col[i3] += (fc.r - col[i3]) * k; col[i3 + 1] += (fc.g - col[i3 + 1]) * k; col[i3 + 2] += (fc.b - col[i3 + 2]) * k;
        }
      } else {
        // released: drift apart, back towards each star's own resting spot
        ax += (this.home[i * 2] * hw - x) * 0.06; ay += (this.home[i * 2 + 1] * hh - y) * 0.06;
        col[i3] += (base[i3] - col[i3]) * backRate; col[i3 + 1] += (base[i3 + 1] - col[i3 + 1]) * backRate; col[i3 + 2] += (base[i3 + 2] - col[i3 + 2]) * backRate;
      }
      // soft walls
      if (x > hw) ax -= (x - hw) * 3; else if (x < -hw) ax -= (x + hw) * 3;
      if (y > hh) ay -= (y - hh) * 3; else if (y < -hh) ay -= (y + hh) * 3;

      vx = (vx + ax * dt) * damp; vy = (vy + ay * dt) * damp; vz = (vz + az * dt) * damp;
      const sp = Math.sqrt(vx * vx + vy * vy);
      const max = nf ? 11 : 3;
      if (sp > max) { vx *= max / sp; vy *= max / sp; }
      speedSum += sp;
      vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
      pos[i3] = x + vx * dt; pos[i3 + 1] = y + vy * dt; pos[i3 + 2] = z + vz * dt;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.material.uniforms.uTime.value = time;

    // 3) shimmer pad swells with average swarm speed
    this.speedAvg += (speedSum / n - this.speedAvg) * (1 - Math.exp(-dt * 3));
    const level = clamp((this.speedAvg - 0.8) / 6, 0, 1);
    if (level > 0.02 || nf) {
      if (!this.pad || !this.pad.alive) this.pad = this.audio.pad('shimmer', this.audio.freq(10));
      const step = nf ? this.audio.stepFromUnit((F[0].ny + 1) / 2, 7, 14) : 10;
      this.pad.set(level * 0.9, 0.15 + level * 0.6, this.audio.freq(step), nf ? F[0].nx * 0.5 : 0, 0.25);
    } else if (this.pad && this.pad.alive) this.pad.set(0, 0.1);
  }

  dispose() { if (this.pad) this.pad.stop(); this.fingers.length = 0; }
}
