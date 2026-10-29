// Shared helpers: colour themes, disposal, screen→world mapping, backdrop and
// small maths utilities used by every scene. Nothing here allocates per frame.
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Themes. `glow` themes use additive blending on dark backgrounds; the light
// Pastel theme uses normal alpha blending so colours stay soft, never washed out.
// ---------------------------------------------------------------------------
export const THEMES = {
  pastel: {
    name: 'Pastel', dark: false, glow: false,
    bg: '#ece6f2', bg2: '#dbe4f0', ink: '#6d6a92',
    colors: ['#f4a3b5', '#9ccfee', '#b5dea8', '#ffd09c', '#c3aef0', '#9fe0d4'],
  },
  neon: {
    name: 'Soft Neon Dark', dark: true, glow: true,
    bg: '#0c0f22', bg2: '#1b1640', ink: '#c9d4ff',
    colors: ['#63eed4', '#7ea4ff', '#ff90cc', '#ffd27a', '#b494ff', '#8ef3a2'],
  },
  contrast: {
    name: 'High Contrast', dark: true, glow: true, contrast: true,
    bg: '#000000', bg2: '#000000', ink: '#ffffff',
    colors: ['#ffffff', '#ffe600', '#00e1ff', '#ff4fa3', '#6cff3d', '#ff9a1f'],
  },
};

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** Frame-rate independent exponential approach factor. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

/** Deterministic pseudo-random generator so layouts are identical every visit (predictability). */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Free every GPU resource under `root` (geometries, materials, textures, instance buffers). */
export function disposeObject(root) {
  if (!root) return;
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
        if (m.uniforms) for (const k in m.uniforms) { const v = m.uniforms[k].value; if (v && v.isTexture) v.dispose(); }
        m.dispose();
      }
    }
    if (o.isInstancedMesh) o.dispose();
  });
  if (root.background && root.background.isTexture) root.background.dispose();
  root.clear();
}

// Reused objects for the screen→world helpers (no per-call allocation).
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

/** Intersect the ray under NDC (nx, ny) with `plane`; writes into `out`, returns null if parallel. */
export function ndcToPlane(camera, nx, ny, plane, out) {
  _ndc.set(nx, ny);
  _ray.setFromCamera(_ndc, camera);
  return _ray.ray.intersectPlane(plane, out);
}

/** Ray for an NDC point (shared instance — copy it if you need to keep it). */
export function ndcRay(camera, nx, ny) {
  _ndc.set(nx, ny);
  _ray.setFromCamera(_ndc, camera);
  return _ray.ray;
}

/** Visible world-space width/height of a perspective camera at distance `d`. */
export function visibleSize(camera, d) {
  const h = 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  return { w: h * camera.aspect, h };
}

/**
 * Full-screen gradient backdrop drawn behind everything (clip-space quad).
 * A tiny amount of dithering noise prevents banding on dark gradients.
 */
export function makeBackdrop(palette) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      c1: { value: new THREE.Color(palette.bg) },
      c2: { value: new THREE.Color(palette.bg2) },
      uAspect: { value: 1 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.99999, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform vec3 c1; uniform vec3 c2; uniform float uAspect;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
        float r = clamp(length(p) * 1.15, 0.0, 1.0);
        vec3 col = mix(c2, c1, smoothstep(0.0, 1.0, r));
        col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
    depthWrite: false, depthTest: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

/** Simple rate limiter: returns true at most `perSecond` times per second (token bucket). */
export class RateLimiter {
  constructor(perSecond, burst = 2) { this.rate = perSecond; this.burst = burst; this.tokens = burst; this.last = 0; }
  take(now) {
    this.tokens = Math.min(this.burst, this.tokens + (now - this.last) * this.rate);
    this.last = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}

// ---------------------------------------------------------------------------
// On-screen controls that some scenes add (clay turn pad, camera switch, fire
// button). Each scene removes its own elements in dispose().
// ---------------------------------------------------------------------------

/** A rounded panel on the left edge (styled by #rotpad / #campad in index.html). */
export function sidePad(id, label) {
  const pad = document.createElement('div');
  pad.id = id;
  if (label) pad.setAttribute('aria-label', label);
  document.body.appendChild(pad);
  return pad;
}

/** A round icon button; `svg` is the inner markup of a 36×36 viewBox. */
export function iconButton(label, svg) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.setAttribute('aria-label', label);
  b.innerHTML = `<svg viewBox="0 0 36 36">${svg}</svg>`;
  return b;
}

/**
 * Press-and-hold behaviour: `start` on finger down (or Enter/Space), `stop` when
 * the finger lifts, is cancelled or slides off (or the key is released).
 */
export function holdButton(el, start, stop) {
  const down = (e) => { e.preventDefault(); start(e); };
  el.addEventListener('pointerdown', down);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => el.addEventListener(t, stop));
  el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) down(e); });
  el.addEventListener('keyup', stop);
}
