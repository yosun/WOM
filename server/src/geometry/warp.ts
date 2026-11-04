// Non-rigid alignment at the photo's camera. A rigid pose cannot match a generated head whose proportions differ from the
// photo's (here the face is about 11% short from brow to mouth). This measures the remaining offset between a part's render
// and the photo as a smooth displacement field (coarse-to-fine block matching on high-passed luminance, plus snapping the
// part's outline and its seam onto the masks), then moves each Gaussian's centre sideways in the image plane (its depth is
// unchanged) so the features land where the photo has them. Run twice; the second pass corrects the residual.
import { apply, transpose, type Mat3, type Vec3 } from './math.ts';
import {
  composite, makeCamera, matFromQuat, prepareSplats, project,
  type Roi, type SplatPly, type SplatPose, type Splats,
} from './splat.ts';

export interface WarpInput {
  width: number;
  height: number;
  fovY: number;
  /** The photo, RGB bytes. */
  photo: Uint8Array;
  ply: SplatPly;
  pose: SplatPose;
  /** This part's visible pixels, and the other part's, and her whole silhouette (all width * height, 0/1). */
  partMask: Uint8Array;
  otherMask: Uint8Array;
  woman: Uint8Array;
  /**
   * Pixels where the part's own render cannot be compared with the photo: whatever hides it (the other part, in front), grown by
   * `occluderGrow`. Default: the other part's pixels that this part does not claim.
   */
  occluder?: Uint8Array;
  occluderGrow?: number;
  passes?: number;
  /** Snap the part's outline and the seam onto the masks. */
  silhouette?: boolean;
}

export interface WarpPassStats {
  pass: number;
  level4: { anchors: number; kept: number; meanResidual: number };
  level2: { anchors: number; kept: number; meanResidual: number };
  level1: { anchors: number; kept: number; meanResidual: number };
  silhouette?: { anchors: number; seam: number; outward: number; inward: number; meanDistance: number; cells: number };
  moved: number;
  meanShift: number;
  maxShift: number;
}

const lum = (rgb: Uint8Array, n: number) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = (0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]) / 255; return o; };

function down(src: Float32Array, w: number, h: number, L: number) {
  if (L === 1) return { d: src, w, h };
  const ow = Math.floor(w / L), oh = Math.floor(h / L), out = new Float32Array(ow * oh), inv = 1 / (L * L);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) { let s = 0; for (let dy = 0; dy < L; dy++) for (let dx = 0; dx < L; dx++) s += src[(y * L + dy) * w + x * L + dx]; out[y * ow + x] = s * inv; }
  return { d: out, w: ow, h: oh };
}

function blur(src: Float32Array, w: number, h: number, sigma: number) {
  const r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let j = -r; j <= r; j++) a += src[y * w + Math.min(w - 1, Math.max(0, x + j))] * k[j + r]; tmp[y * w + x] = a; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let j = -r; j <= r; j++) a += tmp[Math.min(h - 1, Math.max(0, y + j)) * w + x] * k[j + r]; out[y * w + x] = a; }
  return out;
}

const highpass = (d: Float32Array, w: number, h: number, sigma: number) => { const b = blur(d, w, h, sigma); const o = new Float32Array(w * h); for (let i = 0; i < o.length; i++) o[i] = d[i] - b[i]; return o; };

/** A dense displacement field stored on a coarse grid (cell = `cell` full-res px); values in full-res px. */
class Field {
  cell: number; gw: number; gh: number; dx: Float32Array; dy: Float32Array;
  constructor(cell: number, W: number, H: number) {
    this.cell = cell; this.gw = Math.ceil(W / cell) + 1; this.gh = Math.ceil(H / cell) + 1;
    this.dx = new Float32Array(this.gw * this.gh); this.dy = new Float32Array(this.gw * this.gh);
  }
  at(x: number, y: number): [number, number] {
    const gx = Math.min(this.gw - 1.001, Math.max(0, x / this.cell)), gy = Math.min(this.gh - 1.001, Math.max(0, y / this.cell));
    const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0, i = y0 * this.gw + x0;
    const l = (a: Float32Array) => a[i] * (1 - fx) * (1 - fy) + a[i + 1] * fx * (1 - fy) + a[i + this.gw] * (1 - fx) * fy + a[i + this.gw + 1] * fx * fy;
    return [l(this.dx), l(this.dy)];
  }
}

interface Anchor { x: number; y: number; rdx: number; rdy: number; w: number }
interface SilAnchor { x: number; y: number; rdx: number; rdy: number; seam: boolean }

export interface WarpResult {
  ply: SplatPly;
  stats: WarpPassStats[];
}

export function warpAlign(input: WarpInput, log: (msg: string) => void = () => undefined): WarpResult {
  const { width: W, height: H, photo } = input;
  const PASSES = input.passes ?? 2, SILHOUETTE = input.silhouette ?? true;
  const N = W * H;
  const photoLum = lum(photo, N);
  const { partMask, otherMask, woman } = input;

  // pixels in which the part's own render can be compared with the photo: its visible mask, minus what hides it
  const valid = new Uint8Array(N);
  {
    const occluder = input.occluder ?? Uint8Array.from(partMask, (v, i) => (otherMask[i] && !v ? 1 : 0));
    const g = input.occluderGrow ?? 10;
    const grow = new Uint8Array(N);
    if (g > 0) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (occluder[y * W + x]) for (let dy = -g; dy <= g; dy += 2) for (let dx = -g; dx <= g; dx += 2) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < H && xx >= 0 && xx < W) grow[yy * W + xx] = 1; }
    }
    for (let i = 0; i < N; i++) valid[i] = partMask[i] && !grow[i] ? 1 : 0;
  }
  let bx0 = W, by0 = H, bx1 = 0, by1 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (partMask[y * W + x]) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
  const M = 48;
  const roi: Roi = { x0: Math.max(0, bx0 - M), y0: Math.max(0, by0 - M), x1: Math.min(W, bx1 + 1 + M), y1: Math.min(H, by1 + 1 + M) };

  /** One coarse-to-fine level: block-match the render against the photo around the current field; add the residual. */
  function matchLevel(L: number, field: Field, renderLum: Float32Array, covered: Uint8Array, p: { step: number; win: number; search: number; sigmaHP: number; nc: number; maxJump: number }) {
    const { step, win, search, sigmaHP, nc, maxJump } = p;
    const P = down(photoLum, W, H, L), R = down(renderLum, W, H, L);
    const Ph = highpass(P.d, P.w, P.h, sigmaHP), Rh = highpass(R.d, R.w, R.h, sigmaHP);
    const ok = new Float32Array(P.w * P.h); // 1 where the render is present and the photo is comparable
    const sub = Math.max(1, L >> 1), subN = L === 1 ? 1 : Math.ceil(L / sub) ** 2;
    for (let y = 0; y < P.h; y++) for (let x = 0; x < P.w; x++) {
      let a = 0;
      for (let dy = 0; dy < L; dy += sub) for (let dx = 0; dx < L; dx += sub) { const i = (y * L + dy) * W + (x * L + dx); a += covered[i] && valid[i] ? 1 : 0; }
      ok[y * P.w + x] = a / subN;
    }
    const anchors: Anchor[] = [];
    const rx0 = Math.floor(roi.x0 / L), ry0 = Math.floor(roi.y0 / L), rx1 = Math.floor(roi.x1 / L), ry1 = Math.floor(roi.y1 / L);
    const hw = win >> 1;
    for (let ay = ry0 + hw; ay < ry1 - hw; ay += step) for (let ax = rx0 + hw; ax < rx1 - hw; ax += step) {
      let cov = 0;
      for (let y = -hw; y < hw; y += 2) for (let x = -hw; x < hw; x += 2) cov += ok[(ay + y) * P.w + ax + x];
      cov /= (win / 2) ** 2;
      if (cov < 0.7) continue;
      const [fdx, fdy] = field.at(ax * L, ay * L);
      const ix = Math.round(fdx / L), iy = Math.round(fdy / L);
      // template: render patch (high-passed); candidate: photo patch shifted by (ix + sx, iy + sy)
      let tm = 0, n = 0;
      for (let y = -hw; y < hw; y++) for (let x = -hw; x < hw; x++) { tm += Rh[(ay + y) * P.w + ax + x]; n++; }
      tm /= n;
      let tv = 0;
      for (let y = -hw; y < hw; y++) for (let x = -hw; x < hw; x++) { const t = Rh[(ay + y) * P.w + ax + x] - tm; tv += t * t; }
      if (tv < 1e-6 * n) continue;
      const S = 2 * search + 1, sc = new Float32Array(S * S).fill(-1);
      let best = -2, bsx = 0, bsy = 0;
      for (let sy = -search; sy <= search; sy++) for (let sx = -search; sx <= search; sx++) {
        const ox = ax + ix + sx, oy = ay + iy + sy;
        if (ox - hw < 0 || oy - hw < 0 || ox + hw > P.w || oy + hw > P.h) continue;
        let pm = 0;
        for (let y = -hw; y < hw; y++) for (let x = -hw; x < hw; x++) pm += Ph[(oy + y) * P.w + ox + x];
        pm /= n;
        let pv = 0, cv = 0;
        for (let y = -hw; y < hw; y++) for (let x = -hw; x < hw; x++) { const t = Rh[(ay + y) * P.w + ax + x] - tm, q = Ph[(oy + y) * P.w + ox + x] - pm; pv += q * q; cv += t * q; }
        if (pv < 1e-9) continue;
        const c = cv / Math.sqrt(tv * pv);
        sc[(sy + search) * S + sx + search] = c;
        if (c > best) { best = c; bsx = sx; bsy = sy; }
      }
      if (best < 0.3) continue;
      const g = (sx: number, sy: number) => (Math.abs(sx) > search || Math.abs(sy) > search ? NaN : sc[(sy + search) * S + sx + search]);
      const par = (m: number, c: number, q: number) => { const d = m - 2 * c + q; return Number.isFinite(d) && d < 0 ? (0.5 * (m - q)) / d : 0; };
      const px = par(g(bsx - 1, bsy), best, g(bsx + 1, bsy)), py = par(g(bsx, bsy - 1), best, g(bsx, bsy + 1));
      // residual shift (full-res px) of the render's content toward the photo, relative to the current field
      anchors.push({ x: ax * L, y: ay * L, rdx: (ix + bsx + px) * L - fdx, rdy: (iy + bsy + py) * L - fdy, w: Math.max(0, best - 0.3) ** 2 });
    }
    // reject outliers against the local median of neighbours
    const keep = anchors.filter((a, i) => {
      const near = anchors.filter((b, j) => j !== i && Math.hypot(b.x - a.x, b.y - a.y) < step * L * 2.6);
      if (near.length < 3) return true;
      const mx = near.map((b) => b.rdx).sort((p, q) => p - q)[near.length >> 1], my = near.map((b) => b.rdy).sort((p, q) => p - q)[near.length >> 1];
      return Math.hypot(a.rdx - mx, a.rdy - my) <= maxJump;
    });
    // normalized convolution of the residuals into the field, with damping so it fades to zero away from anchors
    const sigma = nc;
    let mean = 0, cnt = 0;
    for (let gy = 0; gy < field.gh; gy++) for (let gx = 0; gx < field.gw; gx++) {
      const px = gx * field.cell, py = gy * field.cell;
      let sw = 0, sx = 0, sy = 0;
      for (const a of keep) {
        const d2 = (a.x - px) ** 2 + (a.y - py) ** 2;
        if (d2 > 9 * sigma * sigma) continue;
        const w = a.w * Math.exp(-d2 / (2 * sigma * sigma));
        sw += w; sx += w * a.rdx; sy += w * a.rdy;
      }
      const damp = 0.02, i = gy * field.gw + gx;
      field.dx[i] += sx / (sw + damp); field.dy[i] += sy / (sw + damp);
      if (sw > 0.05) { mean += Math.hypot(sx / (sw + damp), sy / (sw + damp)); cnt++; }
    }
    return { anchors: anchors.length, kept: keep.length, meanResidual: cnt ? mean / cnt : 0 };
  }

  // silhouette snapping: the free boundary is the part mask's pixels that touch the outside of her whole silhouette. Where the
  // render's edge lies next to it with nothing covered in between, the render edge should move onto the mask edge (normal direction).
  function silhouetteField(cov: Uint8Array, R = 28) {
    const seeds: number[] = [];
    const isSeam = new Uint8Array(N);
    for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
      const i = y * W + x;
      if (!partMask[i]) continue;
      const outer = !woman[i - 2] || !woman[i + 2] || !woman[i - 2 * W] || !woman[i + 2 * W];
      // seam: this part's boundary against the other part (the other part's pixels that this part does not own)
      const seam = !outer && ((otherMask[i - 2] && !partMask[i - 2]) || (otherMask[i + 2] && !partMask[i + 2]) || (otherMask[i - 2 * W] && !partMask[i - 2 * W]) || (otherMask[i + 2 * W] && !partMask[i + 2 * W]));
      if (outer || seam) { seeds.push(i); if (seam) isSeam[i] = 1; }
    }
    const CELL = 8, GW = Math.ceil(W / CELL), grid = new Map<number, number[]>();
    for (const i of seeds) { const k = Math.floor(((i / W) | 0) / CELL) * GW + Math.floor((i % W) / CELL); (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); }
    const anchors: SilAnchor[] = [];
    let inward = 0, outward = 0;
    for (let y = roi.y0 + 1; y < roi.y1 - 1; y++) for (let x = roi.x0 + 1; x < roi.x1 - 1; x++) {
      const i = y * W + x;
      if (!cov[i] || (cov[i - 1] && cov[i + 1] && cov[i - W] && cov[i + W])) continue; // render edge pixels only
      let best = 1e9, bi = -1;
      const cx0 = Math.floor((x - R) / CELL), cx1 = Math.floor((x + R) / CELL), cy0 = Math.floor((y - R) / CELL), cy1 = Math.floor((y + R) / CELL);
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const l = grid.get(cy * GW + cx);
        if (!l) continue;
        for (const j of l) { const dx = (j % W) - x, dy = ((j / W) | 0) - y, d2 = dx * dx + dy * dy; if (d2 < best) { best = d2; bi = j; } }
      }
      if (bi < 0 || best > R * R) continue;
      if (isSeam[bi] && !partMask[i]) continue; // along a seam only pull outward: reaching into the neighbour is harmless
      const sx = bi % W, sy = (bi / W) | 0, dx = sx - x, dy = sy - y, len = Math.hypot(dx, dy);
      // nothing of the render may lie between the edge pixel and the mask edge, or this edge is an interior gap
      let clear = true;
      if (len > 1.5 && partMask[i]) {
        for (let t = 1; t < len; t += 1) { const px = Math.round(x + (dx * t) / len), py = Math.round(y + (dy * t) / len); if (cov[py * W + px] && !(px === x && py === y)) { clear = false; break; } }
      }
      if (!clear) continue;
      if (partMask[i]) outward++; else inward++;
      anchors.push({ x, y, rdx: dx, rdy: dy, seam: isSeam[bi] === 1 });
    }
    return { anchors, outward, inward };
  }
  function addSilhouette(field: Field, anchors: SilAnchor[], sigma: number) {
    const bucket = new Map<number, SilAnchor[]>();
    const B = Math.ceil(3 * sigma);
    for (const a of anchors) { const k = Math.floor(a.y / B) * 1000 + Math.floor(a.x / B); (bucket.get(k) ?? bucket.set(k, []).get(k)!).push(a); }
    let applied = 0;
    for (let gy = 0; gy < field.gh; gy++) for (let gx = 0; gx < field.gw; gx++) {
      const px = gx * field.cell, py = gy * field.cell;
      let sw = 0, sx = 0, sy = 0;
      for (let by = Math.floor((py - B) / B); by <= Math.floor((py + B) / B); by++) for (let bx = Math.floor((px - B) / B); bx <= Math.floor((px + B) / B); bx++) {
        const l = bucket.get(by * 1000 + bx);
        if (!l) continue;
        for (const a of l) {
          const d2 = (a.x - px) ** 2 + (a.y - py) ** 2;
          if (d2 > 9 * sigma * sigma) continue;
          const w = Math.exp(-d2 / (2 * sigma * sigma));
          sw += w; sx += w * a.rdx; sy += w * a.rdy;
        }
      }
      if (sw > 0) { const damp = 3, i = gy * field.gw + gx; field.dx[i] += sx / (sw + damp); field.dy[i] += sy / (sw + damp); applied++; }
    }
    return applied;
  }

  // ---------- passes ----------
  const cam = makeCamera({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], fovY: input.fovY, width: W, height: H });
  const f = H / 2 / Math.tan((input.fovY * Math.PI) / 360), cx = W / 2, cy = H / 2;
  const pose = input.pose;
  const R = matFromQuat(pose.quaternion), s = pose.scale, t = pose.position;
  const Rt: Mat3 = transpose(R);

  let ply = input.ply;
  let splats: Splats = prepareSplats(ply);
  const stats: WarpPassStats[] = [];

  const renderPart = (sp: Splats) => {
    const r = composite([project(sp, pose, cam, roi)], roi);
    const rw = roi.x1 - roi.x0, rl = new Float32Array(N), cov = new Uint8Array(N);
    rl.set(photoLum);
    for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
      const p = (y - roi.y0) * rw + (x - roi.x0), tt = r.T[p], i = y * W + x;
      const cr = r.C[p * 3] + (tt * photo[i * 3]) / 255, cg = r.C[p * 3 + 1] + (tt * photo[i * 3 + 1]) / 255, cb = r.C[p * 3 + 2] + (tt * photo[i * 3 + 2]) / 255;
      rl[i] = 0.299 * cr + 0.587 * cg + 0.114 * cb;
      cov[i] = tt < 0.5 ? 1 : 0;
    }
    return { rl, cov };
  };

  for (let pass = 1; pass <= PASSES; pass++) {
    const t0 = Date.now();
    const { rl, cov } = renderPart(splats);
    const field = new Field(8, W, H);
    const l4 = matchLevel(4, field, rl, cov, { step: 6, win: 20, search: 7, sigmaHP: 2.5, nc: 40, maxJump: 14 });
    const l2 = matchLevel(2, field, rl, cov, { step: 10, win: 30, search: 4, sigmaHP: 3, nc: 28, maxJump: 7 });
    const l1 = matchLevel(1, field, rl, cov, { step: 16, win: 44, search: 3, sigmaHP: 4, nc: 22, maxJump: 4 });
    const st: WarpPassStats = { pass, level4: l4, level2: l2, level1: l1, moved: 0, meanShift: 0, maxShift: 0 };
    if (SILHOUETTE) {
      const sil = silhouetteField(cov);
      const mean = sil.anchors.length ? sil.anchors.reduce((a, b) => a + Math.hypot(b.rdx, b.rdy), 0) / sil.anchors.length : 0;
      const applied = addSilhouette(field, sil.anchors, 7);
      st.silhouette = { anchors: sil.anchors.length, seam: sil.anchors.filter((a) => a.seam).length, outward: sil.outward, inward: sil.inward, meanDistance: mean, cells: applied };
    }
    // move the Gaussians: same depth, projection shifted by the field (the field maps render position -> photo position)
    const F = ply.props.length;
    const data = Float32Array.from(ply.data);
    const next: SplatPly = { header: ply.header, props: ply.props, count: ply.count, data };
    let moved = 0, sum = 0, max = 0;
    for (let i = 0; i < ply.count; i++) {
      const b = i * F, px = data[b], py = data[b + 1], pz = data[b + 2];
      const X = t[0] + s * (R[0] * px + R[1] * py + R[2] * pz), Y = t[1] + s * (R[3] * px + R[4] * py + R[5] * pz), Z = t[2] + s * (R[6] * px + R[7] * py + R[8] * pz);
      const d = -Z;
      if (d <= 0.05) continue;
      const u = cx + (f * X) / d, v = cy - (f * Y) / d;
      if (u < roi.x0 || u >= roi.x1 || v < roi.y0 || v >= roi.y1) continue;
      const [du, dv] = field.at(u, v);
      if (Math.abs(du) < 0.01 && Math.abs(dv) < 0.01) continue;
      const X2 = ((u + du - cx) * d) / f, Y2 = (-(v + dv - cy) * d) / f;
      const local = apply(Rt, [(X2 - t[0]) / s, (Y2 - t[1]) / s, (Z - t[2]) / s] as Vec3);
      data[b] = local[0]; data[b + 1] = local[1]; data[b + 2] = local[2];
      moved++;
      const m = Math.hypot(du, dv);
      sum += m;
      if (m > max) max = m;
    }
    st.moved = moved; st.meanShift = sum / Math.max(1, moved); st.maxShift = max;
    stats.push(st);
    log(`warp pass ${pass}: level 4 ${l4.kept}/${l4.anchors} anchors, level 2 ${l2.kept}/${l2.anchors}, level 1 ${l1.kept}/${l1.anchors}${st.silhouette ? `, ${st.silhouette.anchors} edge pixels snapped (${st.silhouette.seam} along the seam)` : ''}; moved ${moved} Gaussians, mean ${st.meanShift.toFixed(1)} px, max ${max.toFixed(1)} px (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    ply = next;
    splats = prepareSplats(ply);
  }
  return { ply, stats };
}
