/**
 * Scene 10 — Bubble Cannon
 *
 * The same live camera picture as Squishy Mirror (front or back camera, the
 * same soft jelly sheet), with a friendly round cannon near the bottom of the
 * screen. Touch anywhere: the cannon turns to face your finger and lobs a soft
 * ball there. Keep holding and it keeps firing, gently, about twice a second.
 * Where a ball lands the picture is pressed in, then wobbles back out in soft
 * ripples. The ball squashes flat and fades: nothing is ever left behind.
 *
 * Gentle on purpose: balls are slow, there is no flash, bang or shake, and the
 * number of balls in the air is capped.
 *
 * SOUND: a soft "plip" when a ball leaves the cannon, and a round squish tone
 * when it lands (pitch from how high up the screen it lands).
 */
import * as THREE from 'three';
import { clamp, damp, RateLimiter } from '../util.js';
import SquishyMirror from './mirror.js';

const MAX_BALLS = 12;
const FIRE_EVERY = 0.5;        // seconds between balls while a finger is held
const HIT_SIGMA = 0.13;        // size of the dent (fraction of screen height)
const HIT_PUSH = 7;            // strength of the dent
const MAX_AIM = 1.3;           // radians either side of straight up

export default class BubbleCannon extends SquishyMirror {
  init(renderer, audio, settings) {
    super.init(renderer, audio, settings);
    this.fireLimiter = new RateLimiter(5, 3);
    this.aim = 0; this.aimTarget = 0;
    this.balls = [];
    this.shooters = [];
    this.recoil = 0;
    this.t = 0;
    this.buildCannon();
  }

  buildCannon() {
    const pal = this.pal, cols = pal.colors;
    const mat = (c, o = 1) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthTest: false, depthWrite: false });
    const g = this.cannon = new THREE.Group();
    g.renderOrder = 5;
    // Barrel: a rounded tube, pivoting at the centre of the base.
    this.barrel = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1.5, 6, 20), mat(cols[1]));
    tube.position.y = 1.1;
    const ring = new THREE.Mesh(new THREE.CapsuleGeometry(0.58, 0.2, 6, 20), mat(cols[4]));
    ring.position.y = 1.8;
    this.barrel.add(tube, ring);
    // Base: a dome with a soft shine.
    const dome = new THREE.Mesh(new THREE.CircleGeometry(1, 40, 0, Math.PI), mat(cols[0]));
    const shine = new THREE.Mesh(new THREE.CircleGeometry(0.22, 20), mat('#ffffff', pal.dark ? 0.25 : 0.45));
    shine.position.set(-0.4, 0.5, 0);
    const foot = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 0.22), mat(cols[4]));
    foot.position.y = -0.04;
    g.add(this.barrel, dome, shine, foot);
    g.traverse((o) => { o.renderOrder = 5; });
    this.scene.add(g);
    // Shared ball geometry; each ball gets its own material for its own fade.
    this.ballGeo = new THREE.CircleGeometry(1, 32);
    this.shineGeo = new THREE.CircleGeometry(0.32, 16);
  }

  resize(w, h) {
    super.resize(w, h);
    this.h = h;
    // Cannon sits above the scene buttons (about 130px from the bottom).
    const u = 2 / h;                      // world units per CSS pixel
    this.size = 46 * u;
    this.cannon.scale.setScalar(this.size);
    this.cannon.position.set(0, -1 + 130 * u, 1);
    for (const b of this.balls) this.removeBall(b);
    this.balls.length = 0;
  }

  // ---- input: every finger aims and fires --------------------------------
  onPointerDown(p) {
    const s = { owner: p, x: p.nx * this.aspect, y: p.ny, wait: 0 };
    this.shooters.push(s);
    p.data = s;
    this.fire(s);
    s.wait = FIRE_EVERY;
  }
  onPointerMove(p) {
    const s = p.data;
    if (!s || !s.owner) return;
    s.x = p.nx * this.aspect; s.y = p.ny;
  }
  onPointerUp(p) {
    const s = p.data;
    const i = this.shooters.indexOf(s);
    if (i >= 0) this.shooters.splice(i, 1);
  }

  angleTo(x, y) {
    const c = this.cannon.position;
    return clamp(Math.atan2(-(x - c.x), Math.max(0.02, y - c.y)), -MAX_AIM, MAX_AIM);
  }

  fire(s) {
    const now = performance.now() / 1000;
    if (this.balls.length >= MAX_BALLS || !this.fireLimiter.take(now)) return;
    const c = this.cannon.position;
    const a = this.aimTarget = this.angleTo(s.x, s.y);
    // Muzzle position along the barrel.
    const L = 2.0 * this.size;
    const sx = c.x - Math.sin(a) * L, sy = c.y + Math.cos(a) * L;
    // Land on the finger, but never below the muzzle.
    const tx = s.x, ty = Math.max(s.y, sy + 0.05);
    const dist = Math.hypot(tx - sx, ty - sy);
    const color = this.pal.colors[(this.colorI = ((this.colorI || 0) + 1) % this.pal.colors.length)];
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(this.ballGeo, mat);
    const shineMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: this.pal.dark ? 0.3 : 0.5, depthTest: false, depthWrite: false });
    const shine = new THREE.Mesh(this.shineGeo, shineMat);
    shine.position.set(-0.35, 0.35, 0.01);
    mesh.add(shine);
    mesh.renderOrder = 4; shine.renderOrder = 4;
    mesh.position.set(sx, sy, 0.5);
    this.scene.add(mesh);
    this.balls.push({ mesh, mat, shineMat, sx, sy, tx, ty, t: 0, T: 0.45 + dist * 0.35, arc: 0.12 * dist, hit: false, fade: 0 });
    this.recoil = 1;
    this.audio.drop(this.audio.freq(-1), 0.25, clamp(sx / this.aspect, -1, 1) * 0.5, 0.3);
  }

  /** Press the sheet in around (x, y): neighbours are pulled towards the hit, then spring back. */
  dent(x, y) {
    const { W, base, vx, vy, pinned } = this;
    const R = HIT_SIGMA * 3, inv = 1 / (2 * HIT_SIGMA * HIT_SIGMA);
    const i0 = Math.max(1, Math.floor((x - R + this.aspect) / (2 * this.aspect) * this.cols));
    const i1 = Math.min(this.cols - 1, Math.ceil((x + R + this.aspect) / (2 * this.aspect) * this.cols));
    const j0 = Math.max(1, Math.floor((1 - (y + R)) / 2 * this.rows));
    const j1 = Math.min(this.rows - 1, Math.ceil((1 - (y - R)) / 2 * this.rows));
    const push = HIT_PUSH * (this.s.reducedMotion ? 0.6 : 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * W + i;
      if (pinned[k]) continue;
      const rx = base[k * 3] - x, ry = base[k * 3 + 1] - y;
      const w = Math.exp(-(rx * rx + ry * ry) * inv);
      if (w < 0.004) continue;
      vx[k] -= rx * w * push;
      vy[k] -= ry * w * push;
    }
  }

  removeBall(b) {
    this.scene.remove(b.mesh);
    b.mat.dispose(); b.shineMat.dispose();
  }

  update(dt, time) {
    super.update(dt, time);
    this.t += dt;
    // Held fingers keep firing, gently.
    for (const s of this.shooters) {
      s.wait -= dt;
      if (s.wait <= 0) { this.fire(s); s.wait = FIRE_EVERY; }
    }
    if (this.shooters.length) this.aimTarget = this.angleTo(this.shooters[this.shooters.length - 1].x, this.shooters[this.shooters.length - 1].y);
    this.aim += (this.aimTarget - this.aim) * damp(10, dt);
    this.recoil *= 1 - damp(7, dt);
    this.barrel.rotation.z = this.aim;
    this.barrel.position.y = -0.25 * this.recoil;
    this.barrel.scale.set(1 + 0.08 * this.recoil, 1 - 0.06 * this.recoil, 1);
    // Balls: fly in a soft arc, getting smaller as they go "into" the picture.
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      if (!b.hit) {
        b.t += dt;
        const u = Math.min(1, b.t / b.T), e = u * (2 - u) * 0.6 + u * 0.4;
        b.mesh.position.x = b.sx + (b.tx - b.sx) * e;
        b.mesh.position.y = b.sy + (b.ty - b.sy) * e + Math.sin(Math.PI * u) * b.arc;
        b.mesh.scale.setScalar(this.size * (0.55 - 0.2 * u));
        if (u >= 1) {
          b.hit = true;
          this.dent(b.tx, b.ty);
          const pan = clamp(b.tx / this.aspect, -1, 1) * 0.6;
          this.audio.squish(this.audio.freq(this.audio.stepFromUnit((b.ty + 1) / 2, -2, 7)), 0.5, pan, 0.4);
        }
      } else {
        // Squash flat and fade away.
        b.fade += dt / 0.55;
        const r = this.size * 0.35;
        b.mesh.scale.set(r * (1 + 0.6 * b.fade), r * (1 - 0.5 * b.fade), 1);
        b.mat.opacity = b.shineMat.opacity = Math.max(0, 1 - b.fade) * (b.fade < 0.05 ? 1 : 0.85);
        if (b.fade >= 1) { this.removeBall(b); this.balls.splice(i, 1); }
      }
    }
  }

  dispose() {
    for (const b of this.balls) this.removeBall(b);
    this.balls.length = 0;
    this.ballGeo.dispose(); this.shineGeo.dispose();
    super.dispose();
  }
}
