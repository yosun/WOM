// Close the gaps that open between two parts of one figure (a head and a body that were built separately) when the
// camera moves away from the photo's. At the photo's camera the parts overlap and cover each other, so nothing shows; from
// the side a thin see-through wedge can open at the join. A ray through that join would pass through the person, so
// something belongs there.
//
// The gaps are found by looking: the parts are rendered from a ring of cameras around the figure, and a pixel counts as
// a seam gap when it is inside the silhouette (covered pixels on both sides) and the gap touches both parts. Each gap is
// filled with a camera-facing patch of small Gaussians at the depth of the farther of the surfaces that bound it, in the
// colour of that boundary. A patch is kept only if it cannot be seen from the photo's camera, so the picture the parts were
// aligned to does not change. Later cameras see the patches of earlier ones, so a gap closed from one side is not
// reopened from the next.
import { apply, type Mat3, type Quat, type Vec3 } from './math.ts';
import {
  SH_C0, composite, compositeContrib, makeCamera, matFromQuat, prepareSplats, project, propIndex, quatFromMatrix, withExtraRows,
  type Composite, type Roi, type SplatCamera, type SplatPly, type SplatPose, type Splats,
} from './splat.ts';

/** A part of the figure: the Gaussians as they sit in the PLY, and where the part is in the scene. */
export interface FigurePart { ply: SplatPly; pose: SplatPose }

export interface OrbitSettings {
  /** Point the cameras look at (scene coordinates, m). */
  target: Vec3;
  /** Distance from the target (m). */
  dist: number;
  fovY: number;
  width: number;
  height: number;
}

/** A camera on a ring around the target: `deg` degrees round (0 = the photo's side), `rise` metres above the target. */
export function orbitCamera(o: OrbitSettings, deg: number, rise = 0): SplatCamera {
  const a = (deg * Math.PI) / 180;
  const pos: Vec3 = [o.target[0] + Math.sin(a) * o.dist, o.target[1] + rise, o.target[2] + Math.cos(a) * o.dist];
  const f = unit(sub(o.target, pos)), r = unit(cross(f, [0, 1, 0])), u = cross(r, f);
  // camera axes as columns: right, up, backward
  const R: Mat3 = [r[0], u[0], -f[0], r[1], u[1], -f[1], r[2], u[2], -f[2]];
  return makeCamera({ position: pos, quaternion: quatFromMatrix(R), fovY: o.fovY, width: o.width, height: o.height });
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/** 1 where a render drew something (more than half opaque). */
export const coverageOf = (c: { T: Float32Array }): Uint8Array => Uint8Array.from(c.T, (t) => (t < 0.5 ? 1 : 0));

/**
 * Pixels that are not covered but have covered pixels on both sides within R px, along a row or a column: gaps inside
 * a silhouette. (Dents in the outline do not count, because they are open on one side.)
 */
export function interiorHoles(c: Uint8Array, w: number, h: number, R = 18): Uint8Array {
  const out = new Uint8Array(w * h);
  const rowL = new Int32Array(w * h), rowR = new Int32Array(w * h), colU = new Int32Array(w * h), colD = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -1e9;
    for (let x = 0; x < w; x++) { if (c[y * w + x]) last = x; rowL[y * w + x] = x - last; }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (c[y * w + x]) last = x; rowR[y * w + x] = last - x; }
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) { if (c[y * w + x]) last = y; colU[y * w + x] = y - last; }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (c[y * w + x]) last = y; colD[y * w + x] = last - y; }
  }
  for (let i = 0; i < w * h; i++) if (!c[i] && ((rowL[i] <= R && rowR[i] <= R) || (colU[i] <= R && colD[i] <= R))) out[i] = 1;
  return out;
}

/** Chebyshev erosion: a pixel stays set only if every pixel within r of it is set (pixels past the border count as unset). */
export function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const pass = (src: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let ok = 1;
      for (let k = -r; k <= r && ok; k++) {
        const xx = horizontal ? x + k : x, yy = horizontal ? y : y + k;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || !src[yy * w + xx]) ok = 0;
      }
      out[y * w + x] = ok;
    }
    return out;
  };
  return pass(pass(mask, true), false);
}

/** 8-connected components of a mask: a label per pixel (0 = none) and the pixel indices of each component. */
function components(mask: Uint8Array, w: number, h: number): number[][] {
  const label = new Int32Array(w * h);
  const out: number[][] = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i]) continue;
    const id = out.length + 1, list: number[] = [], stack = [i];
    label[i] = id;
    while (stack.length) {
      const p = stack.pop()!;
      list.push(p);
      const x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (mask[q] && !label[q]) { label[q] = id; stack.push(q); }
      }
    }
    out.push(list);
  }
  return out;
}

/** Pixels within `r` (Chebyshev) of any pixel of `list`, as a mask. */
function nearMask(list: number[], w: number, h: number, r: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (const p of list) {
    const x = p % w, y = (p - x) / w;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) m[yy * w + xx] = 1;
    }
  }
  return m;
}

/** One new Gaussian, in scene coordinates: a small disc that faces the camera it was made from. */
export interface Filler { position: Vec3; sigma: number; rotation: Mat3; color: Vec3; src?: { view: string; x: number; y: number } }

export interface SeamGap { view: string; pixels: number; depth: number }

export interface FillOptions {
  /** Cameras to fill from, as [degrees round, rise in metres]. */
  views: [number, number][];
  /** Go round the cameras this many times: a patch made from one side can leave a crack when seen from another. */
  passes?: number;
  /** Skip gaps bigger than this many pixels in one view: those are openings, not seams. */
  maxGapPx?: number;
  /** A gap needs a pixel of each part within this many pixels. */
  touch?: number;
  /** Opacity of the patches. */
  opacity?: number;
  /** Size of a patch, in pixels of the camera it was made from. */
  sigmaPx?: number;
  /** The most any pixel of the photo's view may change (0..1, colour plus coverage, patches already kept included). Patches that would change more are dropped. */
  photoTolerance?: number;
  /** Depth range (m) searched along a gap's rays, relative to the farther surface that bounds the gap: [in front, behind]. */
  search?: [number, number];
  /** A patch has to lie this far (m) behind the surface the photo's camera sees there, and not more than `maxBehind`, to count as inside the person. */
  hiddenBy?: number;
  maxBehind?: number;
  /** Or it may sit within this far (m) of that surface, if it takes the surface's own colour there. */
  onSurface?: number;
  /** For diagnosis: told, for every gap pixel, what became of it. */
  trace?: (e: { view: string; x: number; y: number; outcome: 'no-spot' | 'visible' | 'kept'; far: number; surfaceMm?: number }) => void;
}

export interface FillResult {
  fillers: Filler[];
  gaps: SeamGap[];
  /** Candidate patches dropped because they would have changed the photo's view. */
  droppedVisible: number;
  /** The largest change to any pixel of the photo's view from all the patches together: the colour (any channel, 0..1) and, among pixels that were not yet opaque, the coverage. */
  photoChange: { colour: number; coverage: number };
}

/** The patches as Gaussians in scene coordinates, ready to project. */
export function fillerSplats(fillers: Filler[], opacity: number): Splats {
  const n = fillers.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), op = new Float32Array(n).fill(opacity), M = new Float32Array(n * 9), rows = new Int32Array(n);
  fillers.forEach((g, j) => {
    pos.set(g.position, j * 3);
    col.set([Math.min(1, Math.max(0, g.color[0])), Math.min(1, Math.max(0, g.color[1])), Math.min(1, Math.max(0, g.color[2]))], j * 3);
    const sc = [g.sigma, g.sigma, 0.35 * g.sigma];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[j * 9 + r * 3 + c] = g.rotation[r * 3 + c] * sc[c];
    rows[j] = j;
  });
  return { n, rows, pos, col, op, M };
}

const IDENTITY_POSE: SplatPose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 };

/**
 * Walk the cameras of `opts.views` and close the seam gaps between `a` and `b`. The patches are in scene coordinates;
 * `appendFillers` puts them into one of the parts. `photo` is the camera the parts were aligned to: no patch is kept that
 * would change what it sees by more than `photoTolerance`.
 */
export function fillSeamGaps(a: FigurePart, b: FigurePart, orbit: OrbitSettings, photo: SplatCamera, opts: FillOptions, log: (msg: string) => void = () => undefined): FillResult {
  const maxGap = opts.maxGapPx ?? 2600, touch = opts.touch ?? 3, opacity = opts.opacity ?? 0.95, sigmaPx = opts.sigmaPx ?? 0.9, tol = opts.photoTolerance ?? 2 / 255;
  const [searchFront, searchBack] = opts.search ?? [0.05, 0.06], hiddenBy = opts.hiddenBy ?? 0.004, maxBehind = opts.maxBehind ?? 0.08, onSurface = opts.onSurface ?? 0.005;
  const { width: w, height: h } = orbit;
  const roi: Roi = { x0: 0, y0: 0, x1: w, y1: h };
  const pa = prepareSplats(a.ply), pb = prepareSplats(b.ply);
  const photoFull: Roi = { x0: 0, y0: 0, x1: photo.width, y1: photo.height };
  const projA = project(pa, a.pose, photo, photoFull), projB = project(pb, b.pose, photo, photoFull);
  const photoRender = composite([projA, projB], photoFull, { depth: true });
  /**
   * Where a scene point stands with respect to what the photo's camera sees. 'hidden': well inside the person, behind a surface
   * that fully covers it (a patch there cannot show). 'surface': on that surface, where a patch in the surface's own colour
   * changes nothing; `color` is that colour. null: it would show.
   */
  const classify = (P: Vec3): { kind: 'hidden' | 'surface'; color?: Vec3 } | null => {
    const q = apply(photo.Rt, [P[0] - photo.pos[0], P[1] - photo.pos[1], P[2] - photo.pos[2]]);
    const d = -q[2];
    if (d <= photo.near) return null;
    const u = Math.floor(photo.cx + (photo.fx * q[0]) / d), v = Math.floor(photo.cy - (photo.fy * q[1]) / d);
    if (u < 2 || v < 2 || u >= photo.width - 2 || v >= photo.height - 2) return null;
    const c = v * photo.width + u;
    if (photoRender.T[c] > 0.02 || !photoRender.Wacc![c]) return null;
    const surfC = photoRender.Dacc![c] / photoRender.Wacc![c];
    if (Math.abs(d - surfC) <= onSurface) {
      const k = 1 - photoRender.T[c];
      return { kind: 'surface', color: [photoRender.C[c * 3] / k, photoRender.C[c * 3 + 1] / k, photoRender.C[c * 3 + 2] / k] };
    }
    // behind: every pixel the patch can reach must be fully covered, by a surface in front of it
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const i = (v + dy) * photo.width + u + dx;
      if (photoRender.T[i] > 0.004 || !photoRender.Wacc![i]) return null;
      const surf = photoRender.Dacc![i] / photoRender.Wacc![i];
      if (d < surf + hiddenBy || d > surf + maxBehind) return null;
    }
    return { kind: 'hidden' };
  };
  // The figure's filled silhouette (covered pixels and the gaps inside them) from every camera, without any patch. A patch has to
  // project inside all of them: a point outside one of them is outside the person, and would stick out of the outline from there.
  const hullViews = opts.views.map(([deg, rise]) => {
    const cam = orbitCamera(orbit, deg, rise);
    const cover = coverageOf(composite([project(pa, a.pose, cam, roi), project(pb, b.pose, cam, roi)], roi));
    const holes = interiorHoles(cover, w, h);
    const filled = new Uint8Array(w * h);
    for (let i = 0; i < filled.length; i++) filled[i] = cover[i] | holes[i];
    return { cam, mask: erode(filled, w, h, 2) };
  });
  const insideHull = (P: Vec3): boolean => {
    for (const hv of hullViews) {
      const q = apply(hv.cam.Rt, [P[0] - hv.cam.pos[0], P[1] - hv.cam.pos[1], P[2] - hv.cam.pos[2]]);
      const d = -q[2];
      if (d <= hv.cam.near) return false;
      const u = Math.floor(hv.cam.cx + (hv.cam.fx * q[0]) / d), v = Math.floor(hv.cam.cy - (hv.cam.fy * q[1]) / d);
      if (u < 0 || v < 0 || u >= w || v >= h || !hv.mask[v * w + u]) return false;
    }
    return true;
  };
  const accepted: Filler[] = [];
  /** The candidates that would push a pixel of the photo's view past the tolerance, with the patches kept so far counted in. */
  const photoCheck = (cands: Filler[], win: Roi) => {
    const only = (p: ReturnType<typeof project>) => cullTo(p, win);
    const ab = [only(projA), only(projB)];
    const ref = composite(ab, win);
    const fp = project(fillerSplats(accepted.concat(cands), opacity), IDENTITY_POSE, photo, win);
    const aft = compositeContrib([...ab, fp], win, 2);
    const bad = new Uint8Array(cands.length);
    let worst = 0;
    const bump = new Uint8Array(aft.w * aft.h);
    for (let i = 0; i < aft.w * aft.h; i++) {
      // a pixel that is 97% opaque and becomes 98.6% opaque cannot be told apart; one that was see-through must stay so
      const dT = Math.max(0, ref.T[i] - aft.T[i]) * (ref.T[i] > 0.1 ? 1 : 0);
      const d = Math.max(Math.abs(aft.C[i * 3] - ref.C[i * 3]), Math.abs(aft.C[i * 3 + 1] - ref.C[i * 3 + 1]), Math.abs(aft.C[i * 3 + 2] - ref.C[i * 3 + 2])) + dT;
      if (d > worst) worst = d;
      if (d > tol) bump[i] = 1;
    }
    // aft.ID counts projected Gaussians; fp.IDX maps those back to the list they came from (some are culled)
    for (let e = 0; e < aft.len; e++) {
      const src = fp.IDX[aft.ID[e]] - accepted.length;
      if (src >= 0 && bump[aft.PIX[e]] && aft.WG[e] >= 0.0012) bad[src] = 1;
    }
    return { worst, bad };
  };

  const gaps: SeamGap[] = [];
  let droppedVisible = 0;
  const passes = Math.max(1, opts.passes ?? 2);
  for (let pass = 0; pass < passes; pass++) {
    const before = accepted.length;
    for (const [deg, rise] of opts.views) {
      const cam = orbitCamera(orbit, deg, rise);
      const projF = accepted.length ? project(fillerSplats(accepted, opacity), IDENTITY_POSE, cam, roi) : null;
      const pA = project(pa, a.pose, cam, roi), pB = project(pb, b.pose, cam, roi);
      const all = composite(projF ? [pA, pB, projF] : [pA, pB], roi, { depth: true });
      const onlyA = coverageOf(composite([pA], roi)), onlyB = coverageOf(composite([pB], roi));
      const cover = coverageOf(all);
      const holes = interiorHoles(cover, w, h);
      const label = `${deg}°${rise ? ` ${rise > 0 ? '+' : ''}${rise} m` : ''}`;
      let cands: Filler[] = [];
      let noSpot = 0;
      for (const gap of components(holes, w, h)) {
        if (gap.length < 6 || gap.length > maxGap) continue;
        const near = nearMask(gap, w, h, touch);
        let touchA = false, touchB = false;
        for (let i = 0; i < near.length && !(touchA && touchB); i++) if (near[i]) { if (onlyA[i]) touchA = true; if (onlyB[i]) touchB = true; }
        if (!(touchA && touchB)) continue; // inside one part: not a seam
        // the surfaces that bound the gap
        const inGap = new Uint8Array(w * h);
        for (const p of gap) inGap[p] = 1;
        const ring = nearMask(gap, w, h, 2);
        const edge: { x: number; y: number; d: number; c: Vec3 }[] = [];
        for (let i = 0; i < ring.length; i++) {
          if (!ring[i] || inGap[i] || !cover[i] || !all.Wacc![i]) continue;
          const k = 1 - all.T[i];
          edge.push({ x: i % w, y: (i - (i % w)) / w, d: all.Dacc![i] / all.Wacc![i], c: [all.C[i * 3] / k, all.C[i * 3 + 1] / k, all.C[i * 3 + 2] / k] });
        }
        if (edge.length < 4) continue;
        const depths = edge.map((e) => e.d).sort((p, q) => p - q);
        const far = depths[Math.min(depths.length - 1, Math.floor(0.8 * depths.length))];
        gaps.push({ view: `${label}${pass ? ` (pass ${pass + 1})` : ''}`, pixels: gap.length, depth: far });
        for (const p of gap) {
          const x = p % w, y = (p - x) / w;
          let sw = 0, sr = 0, sg = 0, sb = 0;
          for (const e of edge) {
            const d2 = (e.x - x) ** 2 + (e.y - y) ** 2, dz = (e.d - far) / 0.012;
            const wt = Math.exp(-d2 / 50 - dz * dz) + 1e-6;
            sw += wt; sr += wt * e.c[0]; sg += wt * e.c[1]; sb += wt * e.c[2];
          }
          // the patch: a disc on the pixel's ray, facing the camera it came from, as close to the far surface as it can be while still hidden from the photo's camera
          let placed = false;
          for (let k = 0; k <= 80 && !placed; k++) {
            for (const sign of k === 0 ? [0] : [1, -1]) {
              const off = sign * k * 0.0015;
              if (off > searchBack || -off > searchFront) continue;
              const dist = far + off;
              const local = apply(cam.R, [((x + 0.5 - cam.cx) * dist) / cam.fx, (-(y + 0.5 - cam.cy) * dist) / cam.fy, -dist]);
              const position: Vec3 = [cam.pos[0] + local[0], cam.pos[1] + local[1], cam.pos[2] + local[2]];
              const where = classify(position);
              if (!where || !insideHull(position)) continue;
              cands.push({ position, sigma: sigmaPx * (dist / cam.fx), rotation: cam.R, color: where.color ?? [sr / sw, sg / sw, sb / sw], src: { view: label, x, y } });
              placed = true;
              break;
            }
          }
          if (!placed) { noSpot++; opts.trace?.({ view: label, x, y, outcome: 'no-spot', far }); }
        }
      }
      droppedVisible += noSpot;
      if (!cands.length) continue;
      // keep only the patches that leave the photo's view as it was
      for (let iter = 0; iter < 6 && cands.length; iter++) {
        const win = windowOf(cands, photo, 14);
        const { bad } = photoCheck(cands, win);
        const keep = cands.filter((_, i) => !bad[i]);
        if (keep.length === cands.length) break;
        droppedVisible += cands.length - keep.length;
        if (opts.trace) for (let i = 0; i < cands.length; i++) if (bad[i]) { const c = cands[i]; opts.trace({ view: label, x: c.src!.x, y: c.src!.y, outcome: 'visible', far: 0 }); }
        cands = keep;
      }
      if (opts.trace) for (const c of cands) opts.trace({ view: label, x: c.src!.x, y: c.src!.y, outcome: 'kept', far: 0 });
      accepted.push(...cands);
    }
    log(`seam fill, pass ${pass + 1}: ${accepted.length - before} patches added (${accepted.length} in all)`);
    if (accepted.length === before) break;
  }

  // the patches together, against the photo's view as it was
  const photoChange = { colour: 0, coverage: 0 };
  if (accepted.length) {
    const aft = composite([projA, projB, project(fillerSplats(accepted, opacity), IDENTITY_POSE, photo, photoFull)], photoFull);
    const ref = composite([projA, projB], photoFull);
    for (let i = 0; i < aft.w * aft.h; i++) {
      photoChange.colour = Math.max(photoChange.colour, Math.abs(aft.C[i * 3] - ref.C[i * 3]), Math.abs(aft.C[i * 3 + 1] - ref.C[i * 3 + 1]), Math.abs(aft.C[i * 3 + 2] - ref.C[i * 3 + 2]));
      if (ref.T[i] > 0.1) photoChange.coverage = Math.max(photoChange.coverage, Math.abs(aft.T[i] - ref.T[i]));
    }
  }
  return { fillers: accepted, gaps, droppedVisible, photoChange };
}

/** The Gaussians of a projection that can touch `win`: composite sorts all of them, so cutting them down saves time. */
function cullTo(p: ReturnType<typeof project>, win: Roi): ReturnType<typeof project> {
  const keep: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const r = p.RAD[i];
    if (p.U[i] + r >= win.x0 && p.U[i] - r <= win.x1 && p.V[i] + r >= win.y0 && p.V[i] - r <= win.y1) keep.push(i);
  }
  const n = keep.length;
  const out = { count: n, U: new Float32Array(n), V: new Float32Array(n), D: new Float32Array(n), CA: new Float32Array(n), CB: new Float32Array(n), CC: new Float32Array(n), AL: new Float32Array(n), RAD: new Float32Array(n), RGB: new Float32Array(n * 3), IDX: new Int32Array(n) };
  keep.forEach((i, j) => {
    out.U[j] = p.U[i]; out.V[j] = p.V[i]; out.D[j] = p.D[i]; out.CA[j] = p.CA[i]; out.CB[j] = p.CB[i]; out.CC[j] = p.CC[i]; out.AL[j] = p.AL[i]; out.RAD[j] = p.RAD[i]; out.IDX[j] = p.IDX[i];
    out.RGB[j * 3] = p.RGB[i * 3]; out.RGB[j * 3 + 1] = p.RGB[i * 3 + 1]; out.RGB[j * 3 + 2] = p.RGB[i * 3 + 2];
  });
  return out;
}

/** The part of the photo's view that the patches can touch, with a margin. */
function windowOf(fillers: Filler[], photo: SplatCamera, margin: number): Roi {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of fillers) {
    const q = apply(photo.Rt, [g.position[0] - photo.pos[0], g.position[1] - photo.pos[1], g.position[2] - photo.pos[2]]);
    const d = -q[2];
    if (d <= photo.near) continue;
    const u = photo.cx + (photo.fx * q[0]) / d, v = photo.cy - (photo.fy * q[1]) / d, r = (3 * g.sigma * photo.fx) / d + margin;
    x0 = Math.min(x0, u - r); x1 = Math.max(x1, u + r); y0 = Math.min(y0, v - r); y1 = Math.max(y1, v + r);
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 1, y1: 1 };
  return { x0: Math.max(0, Math.floor(x0)), y0: Math.max(0, Math.floor(y0)), x1: Math.min(photo.width, Math.ceil(x1)), y1: Math.min(photo.height, Math.ceil(y1)) };
}

/**
 * Append the patches to a part's PLY (in that part's own frame). The thin axis of each disc points at the camera it was
 * made from; the three scales are in the part's own units, which is the scene scale divided by the part's pose scale.
 */
export function appendFillers(ply: SplatPly, pose: SplatPose, fillers: Filler[], opacity = 0.95): SplatPly {
  const out = withExtraRows(ply, fillers.length);
  const F = ply.props.length;
  const iX = propIndex(ply, 'x'), iDC = propIndex(ply, 'f_dc_0'), iOp = propIndex(ply, 'opacity'), iS = propIndex(ply, 'scale_0'), iR = propIndex(ply, 'rot_0');
  const Ro = matFromQuat(pose.quaternion), s = pose.scale;
  const RoT: Mat3 = [Ro[0], Ro[3], Ro[6], Ro[1], Ro[4], Ro[7], Ro[2], Ro[5], Ro[8]];
  const logit = Math.log(opacity / (1 - opacity));
  fillers.forEach((g, j) => {
    const base = (ply.count + j) * F;
    const rel = apply(RoT, [(g.position[0] - pose.position[0]) / s, (g.position[1] - pose.position[1]) / s, (g.position[2] - pose.position[2]) / s]);
    for (let c = 0; c < 3; c++) {
      out.data[base + iX + c] = rel[c];
      out.data[base + iDC + c] = (Math.min(1, Math.max(0, g.color[c])) - 0.5) / SH_C0;
    }
    out.data[base + iOp] = logit;
    const sigma = g.sigma / s;
    out.data[base + iS] = Math.log(sigma); out.data[base + iS + 1] = Math.log(sigma); out.data[base + iS + 2] = Math.log(0.35 * sigma);
    // the disc's rotation in the part's frame: R_part^T * R_camera
    const m = new Array(9) as Mat3;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 3 + c] = RoT[r * 3] * g.rotation[c] + RoT[r * 3 + 1] * g.rotation[3 + c] + RoT[r * 3 + 2] * g.rotation[6 + c];
    const q: Quat = quatFromMatrix(m);
    out.data[base + iR] = q[3]; out.data[base + iR + 1] = q[0]; out.data[base + iR + 2] = q[1]; out.data[base + iR + 3] = q[2];
  });
  return out;
}

/* ---------------------------------------------------------------- measuring --------------------------------------------------------------- */

/** `big`: see-through pixels in gaps of 100 pixels or more, the ones a viewer notices (the rest is speckle). */
export interface HoleCount { deg: number; rise: number; holes: number; seam: number; big: number }

/** Interior see-through pixels from each camera, and how many of them touch two parts. Fewer is better. */
export function countHoles(parts: { splats: Splats; pose: SplatPose }[], orbit: OrbitSettings, views: [number, number][], touch = 3): HoleCount[] {
  const { width: w, height: h } = orbit;
  const roi: Roi = { x0: 0, y0: 0, x1: w, y1: h };
  return views.map(([deg, rise]) => {
    const cam = orbitCamera(orbit, deg, rise);
    const projs = parts.map((p) => project(p.splats, p.pose, cam, roi));
    const holes = interiorHoles(coverageOf(composite(projs, roi)), w, h);
    let n = 0, seam = 0, big = 0;
    const covers = projs.map((p) => coverageOf(composite([p], roi)));
    for (const gap of components(holes, w, h)) {
      n += gap.length;
      if (gap.length >= 100) big += gap.length;
      if (parts.length < 2) continue;
      const near = nearMask(gap, w, h, touch);
      const touching = covers.filter((c) => { for (let i = 0; i < near.length; i++) if (near[i] && c[i]) return true; return false; }).length;
      if (touching >= 2) seam += gap.length;
    }
    return { deg, rise, holes: n, seam, big };
  });
}

/** The cameras used to look for gaps and to check them. The fill views and the check views are different on purpose. */
export const FILL_VIEWS: [number, number][] = [-84, -72, -60, -48, -36, -24, -12, 12, 24, 36, 48, 60, 72, 84].map((d) => [d, 0] as [number, number]).concat([[-30, 0.18], [30, 0.18], [-30, -0.15], [30, -0.15], [0, 0.22], [0, -0.18]]);
