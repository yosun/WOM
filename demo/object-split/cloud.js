// A small software renderer for a sample of the real Gaussians (no WebGL, no DOM, so the same file runs in the page and in Node).
// Each point is one Gaussian's centre, colour and size, in scene coordinates: metres, the camera at the origin looking down -Z,
// exactly the frame the viewer uses. Points are drawn as z-buffered discs, so turning the cloud needs no sorting.
// Every point has two real positions: where the pipeline's silhouette fit put it (`pos0`) and where the pixel alignment moved it
// (`pos`). `morph` blends from one to the other, which is the alignment, Gaussian by Gaussian.
// The file is written by tools/make-hero.mjs: a JSON description plus one binary body.

/** Small seeded generator, so the scatter is the same on every visit. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Decode the cloud file. `meta.parts[name]` = { n, origin: [x,y,z], step, seed }; per part in order the body holds
 * n x 3 Int16 aligned positions, n x 3 Int16 silhouette-fit positions (both in units of `step` metres from `origin`),
 * n x 3 Uint8 colours and n x Uint8 radii (units of `radiusStep` metres), padded to an even length.
 */
export function parseCloud(meta, body) {
  const parts = {};
  let off = 0;
  for (const [name, m] of Object.entries(meta.parts)) {
    const n = m.n;
    const q = new Int16Array(body, off, n * 3); off += n * 6;
    const q0 = new Int16Array(body, off, n * 3); off += n * 6;
    const col = new Uint8Array(body, off, n * 3); off += n * 3;
    const rq = new Uint8Array(body, off, n); off += n;
    if (off % 2) off += 1;
    const pos = new Float32Array(n * 3), pos0 = new Float32Array(n * 3), rad = new Float32Array(n);
    for (let i = 0; i < n * 3; i++) { const a = i % 3; pos[i] = m.origin[a] + q[i] * m.step; pos0[i] = m.origin[a] + q0[i] * m.step; }
    for (let i = 0; i < n; i++) rad[i] = rq[i] * meta.radiusStep;
    // where each point comes from when the cloud assembles: a random direction and distance, and when it sets off
    const rnd = mulberry32(m.seed ?? 7), scatter = new Float32Array(n * 3), delay = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1), dist = 0.16 + 0.34 * Math.pow(rnd(), 0.7);
      scatter[i * 3] = Math.sin(ph) * Math.cos(th) * dist * 1.25; scatter[i * 3 + 1] = Math.sin(ph) * Math.sin(th) * dist; scatter[i * 3 + 2] = Math.cos(ph) * dist;
      delay[i] = rnd();
    }
    parts[name] = { name, n, pos, pos0, col, rad, scatter, delay, origin: m.origin };
  }
  return { parts, fovY: meta.fovY, photo: meta.photo };
}

const ease = (t) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return 1 - Math.pow(1 - t, 3); };

export class CloudRenderer {
  constructor(cloud) {
    this.cloud = cloud;
    this.f = (cloud.photo.h / 2) / Math.tan((cloud.fovY * Math.PI) / 360); // focal length in photo pixels
    this.zbuf = new Float32Array(0);
  }

  /**
   * Draw into `out` (RGBA bytes, w x h). `view`:
   *   cam: { x, y, w }   the photo-pixel window that fills the picture (square pictures: its height equals its width)
   *   yaw, pitch         turn about `pivot` (radians); pivot: [x, y, z] scene metres
   *   dot                scale on every point's size
   *   minRadius          smallest dot, in output pixels
   *   stride             draw every n-th point, with bigger dots to make up for it (a quality knob)
   *   parts: { [name]: { assemble: 0..1, morph: 0..1, lift: [dx, dy] photo pixels, alpha: 0..1, shade: 0..1 } }
   * Returns the number of points drawn.
   */
  render(out, w, h, view) {
    if (this.zbuf.length !== w * h) this.zbuf = new Float32Array(w * h);
    const zb = this.zbuf; zb.fill(Infinity); out.fill(0, 0, w * h * 4);
    const f = this.f, W = this.cloud.photo.w, H = this.cloud.photo.h;
    const sx = w / view.cam.w, ox = view.cam.x, oy = view.cam.y;
    const cy = Math.cos(view.yaw || 0), sy = Math.sin(view.yaw || 0), cp = Math.cos(view.pitch || 0), sp = Math.sin(view.pitch || 0);
    const [px, py, pz] = view.pivot, minR = view.minRadius ?? 0.7, stride = Math.max(1, view.stride | 0 || 1), dot = (view.dot ?? 1) * Math.sqrt(stride);
    let drawn = 0;
    for (const [name, st] of Object.entries(view.parts)) {
      const part = this.cloud.parts[name];
      if (!part || st.alpha <= 0) continue;
      const { n, pos, pos0, col, rad, scatter, delay } = part;
      const a = st.assemble, m = st.morph ?? 1, lx = st.lift[0] * sx, ly = st.lift[1] * sx, alpha = Math.round(255 * st.alpha), shade = st.shade ?? 0;
      for (let i = 0; i < n; i += stride) {
        const i3 = i * 3;
        // arrival: each point sets off at its own time and eases in
        const e = a >= 1 ? 1 : ease((a - delay[i] * 0.6) / 0.4);
        const k = 1 - e;
        let X = pos0[i3] + (pos[i3] - pos0[i3]) * m + scatter[i3] * k, Y = pos0[i3 + 1] + (pos[i3 + 1] - pos0[i3 + 1]) * m + scatter[i3 + 1] * k, Z = pos0[i3 + 2] + (pos[i3 + 2] - pos0[i3 + 2]) * m + scatter[i3 + 2] * k;
        // turn about the pivot: yaw about Y, then pitch about X
        X -= px; Y -= py; Z -= pz;
        const X1 = X * cy + Z * sy, Z1 = -X * sy + Z * cy;
        const Y2 = Y * cp - Z1 * sp, Z2 = Y * sp + Z1 * cp;
        X = X1 + px; Y = Y2 + py; Z = Z2 + pz;
        const d = -Z;
        if (d < 0.2) continue;
        const inv = f / d;
        const x = (W / 2 + X * inv - ox) * sx + lx, y = (H / 2 - Y * inv - oy) * sx + ly;
        let r = rad[i] * inv * sx * dot * (0.4 + 0.6 * e);
        if (r < minR) r = minR;
        if (x < -r || y < -r || x > w + r || y > h + r) continue;
        const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(w - 1, Math.ceil(x + r)), y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(h - 1, Math.ceil(y + r));
        const r2 = r * r;
        const dim = shade ? 1 - shade * Math.min(1, Math.max(0, (d - 1.2) / 0.3)) : 1; // farther points a touch darker, to read as depth
        const R = col[i3] * dim, G = col[i3 + 1] * dim, B = col[i3 + 2] * dim;
        for (let yy = y0; yy <= y1; yy++) {
          const dy = yy + 0.5 - y;
          for (let xx = x0; xx <= x1; xx++) {
            const dx = xx + 0.5 - x;
            if (dx * dx + dy * dy > r2 && r > 0.75) continue;
            const p = yy * w + xx;
            if (d < zb[p]) { zb[p] = d; const o = p * 4; out[o] = R; out[o + 1] = G; out[o + 2] = B; out[o + 3] = alpha; }
          }
        }
        drawn++;
      }
    }
    return drawn;
  }
}
