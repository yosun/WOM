// Split a person into a head and a body. A 3D model built from the whole person gets the face only a few dozen pixels wide, so eyes,
// brows and lips come out as smears. Built from the head alone, the face fills the model's input. SAM 3.1 finds the person's parts
// (face, neck, hands, clothing, arms); this file turns them into two masks that overlap across the neck, paints in the jaw that a
// hand hides, and replaces the person in the world with the two objects. Everything is computed first and written last, so a failure
// anywhere leaves the person as one object.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { SAM_IMAGE_PRICE_USD, samSegment, toDataUrl } from '../clients/meta.ts';
import { cleanComponents, dilateMask, gridBoxToPixels, maskArea, maskBox, maskFromPng, maskToPng, type Mask } from '../geometry/mask.ts';
import type { WorldHandle } from '../store.ts';
import type { Box, ObjectRecord, PlannedObject } from '../types.ts';
import { errorMessage, writeFileAtomic } from '../util.ts';
import { parseSamOutput } from './segment.ts';

/** The head's cutout is made from this picture (the photo with the jaw painted in), see `cutouts` in run.ts. */
export const FILLED_SOURCE = 'source-filled.png';
/** Where the detail corrector looks for its regions, one mask per name. */
export const REGION_DIR = 'regions';

/** What SAM is asked for. Plural prompts ("eyes", "eyebrows") return one mask for both sides. */
export const PART_CONCEPTS = ['face', 'neck', 'hand', 'clothing', 'arm'] as const;
export const REGION_CONCEPTS: Record<string, string> = { eyes: 'eyes', brows: 'eyebrows', lips: 'lips', nose: 'nose' };

export type SamInstances = { mask: Mask; confidence?: number }[];
/** One SAM concept prompt on the photo. Swappable, so the geometry below can be tested without the network. */
export type SamConcept = (concept: string) => Promise<SamInstances>;

export function samConceptFor(photoJpeg: Buffer, width: number, height: number): SamConcept {
  const url = toDataUrl(photoJpeg, 'image/jpeg');
  return async (concept) => parseSamOutput(await samSegment(url, concept), width, height).map((i) => ({ mask: i.mask, confidence: i.confidence }));
}

/* ---------------------------------------------------------------- small mask helpers --------------------------------------------------------------- */

const area = (d: Uint8Array) => { let n = 0; for (let i = 0; i < d.length; i++) n += d[i]; return n; };
const mk = (width: number, height: number, data: Uint8Array): Mask => ({ width, height, data });

/** Share of an instance's pixels that lie inside `within`. */
function fractionInside(m: Mask, within: Mask): number {
  let n = 0, t = 0;
  for (let i = 0; i < m.data.length; i++) if (m.data[i]) { t++; n += within.data[i]; }
  return t ? n / t : 0;
}

function centroid(d: Uint8Array, w: number): [number, number] | null {
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < d.length; i++) if (d[i]) { sx += i % w; sy += Math.floor(i / w); n++; }
  return n ? [sx / n, sy / n] : null;
}

/** The instances that lie on the person (and, when given, whose centre lies in `near`), best first. */
export function onPerson(insts: SamInstances, person: Mask, opts: { minInside?: number; near?: Box } = {}): SamInstances {
  const minInside = opts.minInside ?? 0.8;
  return insts
    .filter((i) => {
      if (fractionInside(i.mask, person) < minInside) return false;
      if (!opts.near) return true;
      const c = centroid(i.mask.data, i.mask.width);
      return Boolean(c && c[0] >= opts.near.x0 && c[0] <= opts.near.x1 && c[1] >= opts.near.y0 && c[1] <= opts.near.y1);
    })
    .sort((a, b) => maskArea(b.mask) - maskArea(a.mask));
}

const unionOf = (w: number, h: number, masks: Mask[]): Uint8Array => {
  const out = new Uint8Array(w * h);
  for (const m of masks) for (let i = 0; i < out.length; i++) out[i] |= m.data[i];
  return out;
};

function gaussBlurZero(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let j = -r; j <= r; j++) { const xx = x + j; if (xx >= 0 && xx < w) a += src[y * w + xx] * k[j + r]; } tmp[y * w + x] = a; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let j = -r; j <= r; j++) { const yy = y + j; if (yy >= 0 && yy < h) a += tmp[yy * w + x] * k[j + r]; } out[y * w + x] = a; }
  return out;
}

/** Convex hull of 2D points (monotone chain). */
export function convexHull2D(points: [number, number][]): [number, number][] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of pts.slice().reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Fill a convex polygon: each row between the leftmost and rightmost edge crossing. */
export function fillConvexPolygon(poly: [number, number][], w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  if (poly.length < 3) return out;
  let y0 = h, y1 = -1;
  for (const [, y] of poly) { y0 = Math.min(y0, Math.floor(y)); y1 = Math.max(y1, Math.ceil(y)); }
  for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
    const yc = y + 0.5;
    let xa = Infinity, xb = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) { const x = ax + ((yc - ay) / (by - ay)) * (bx - ax); xa = Math.min(xa, x); xb = Math.max(xb, x); }
    }
    for (let x = Math.max(0, Math.ceil(xa - 0.5)); x <= Math.min(w - 1, Math.floor(xb - 0.5)); x++) out[y * w + x] = 1;
  }
  return out;
}

/* ---------------------------------------------------------------- the masks --------------------------------------------------------------- */

export interface SplitInput {
  width: number;
  height: number;
  /** The photo, RGB bytes. */
  rgb: Uint8Array;
  person: Mask;
  /** SAM's part masks, already limited to this person. */
  face: Uint8Array;
  neck: Uint8Array;
  hands: Uint8Array;
  clothing: Uint8Array;
  arms: Uint8Array;
}

export interface SplitMasks {
  /** The head as it is seen, with the overlap band below the cut; and the body, with its band above the cut. */
  head: Mask;
  body: Mask;
  /** Head plus the jaw a hand hides: the head's cutout. */
  headCutout: Mask;
  /** The hidden jaw (and cheek) painted in. */
  fill: Mask;
  /** Pixels in both masks: the overlap across the neck. */
  seam: Mask;
  /** The photo with the hidden jaw painted in, RGB bytes (the head's cutout is made from this). */
  filled: Uint8Array;
  yCut: number;
  band: number;
  chinY: number;
  notes: string[];
}

/** Why a person cannot be split, or the two masks. */
export function buildSplit(inp: SplitInput): SplitMasks | { failure: string } {
  const { width: W, height: H, rgb, person } = inp;
  const N = W * H, notes: string[] = [];
  const rowOf = (i: number) => Math.floor(i / W);
  const personArea = area(person.data);

  // where the head ends: the chin, and part of the way down the neck
  let chinY = -1;
  for (let i = 0; i < N; i++) if (inp.face[i] && person.data[i] && !inp.hands[i]) { const y = rowOf(i); if (y > chinY) chinY = y; }
  let neckBottom = -1;
  for (let i = 0; i < N; i++) if (inp.neck[i]) { const y = rowOf(i); if (y > neckBottom) neckBottom = y; }
  if (chinY < 0) return { failure: 'SAM found no face on the person' };
  if (neckBottom <= chinY + 10) return { failure: 'SAM found no neck below the chin' };
  const yCut = Math.round(chinY + 0.55 * (neckBottom - chinY));
  const band = Math.max(6, Math.round(0.008 * Math.max(W, H)));

  // the head is upright: from the face down to the clothing is (nearly) straight down
  const cf = centroid(inp.face, W), cb = centroid(Uint8Array.from(inp.clothing, (v, i) => v | inp.arms[i]), W);
  if (!cf || !cb) return { failure: 'SAM found no clothing or arms' };
  const tilt = (Math.atan2(Math.abs(cb[0] - cf[0]), cb[1] - cf[1]) * 180) / Math.PI;
  if (cb[1] <= cf[1] || tilt > 35) return { failure: `the head is not above the body (${tilt.toFixed(0)}° off vertical)` };

  // the head: everything of the person above the cut that no body part claims; the hand is claimed with a 2 px margin (skin against skin)
  const handWide = dilateMask(mk(W, H, inp.hands), 2).data;
  const bodyClaim = new Uint8Array(N);
  for (let i = 0; i < N; i++) bodyClaim[i] = (inp.clothing[i] | inp.arms[i] | handWide[i]) & person.data[i];
  const H0 = new Uint8Array(N);
  for (let i = 0; i < N; i++) H0[i] = person.data[i] && !bodyClaim[i] && rowOf(i) < yCut + band ? 1 : 0;
  const H1 = cleanComponents(mk(W, H, H0), undefined, 200).data;
  const headVis = new Uint8Array(N);
  for (let i = 0; i < N; i++) headVis[i] = H1[i] && rowOf(i) < yCut + band ? 1 : 0;

  // the jaw and cheek the hand hides: the hand's pixels inside the convex hull of the visible face
  const faceOnly = new Uint8Array(N);
  for (let i = 0; i < N; i++) faceOnly[i] = inp.face[i] & person.data[i] & (1 - inp.hands[i]);
  const boundary: [number, number][] = [];
  for (let i = W; i < N - W; i++) if (faceOnly[i] && !(faceOnly[i - 1] && faceOnly[i + 1] && faceOnly[i - W] && faceOnly[i + W])) boundary.push([i % W, rowOf(i)]);
  if (boundary.length < 20) return { failure: 'the visible face is too small' };
  const hullMask = fillConvexPolygon(convexHull2D(boundary), W, H);
  const fill = new Uint8Array(N);
  for (let i = 0; i < N; i++) fill[i] = hullMask[i] && handWide[i] && !headVis[i] && rowOf(i) < yCut ? 1 : 0;

  // one piece: the largest connected piece of head and fill; thin wisps the hand cuts off go to the body
  {
    const both = new Uint8Array(N);
    for (let i = 0; i < N; i++) both[i] = headVis[i] | fill[i];
    const label = new Int32Array(N);
    const sizes = [0];
    let next = 1;
    for (let i = 0; i < N; i++) {
      if (!both[i] || label[i]) continue;
      const st = [i];
      label[i] = next;
      let n = 0;
      while (st.length) {
        const p = st.pop()!;
        n++;
        const x = p % W, y = (p - x) / W;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const q = yy * W + xx;
          if (both[q] && !label[q]) { label[q] = next; st.push(q); }
        }
      }
      sizes.push(n);
      next++;
    }
    let big = 1;
    for (let l = 1; l < sizes.length; l++) if (sizes[l] > sizes[big]) big = l;
    let moved = 0;
    for (let i = 0; i < N; i++) if (both[i] && label[i] !== big) { if (headVis[i]) { headVis[i] = 0; moved++; } fill[i] = 0; }
    if (moved) notes.push(`${moved} px of stray pieces went to the body`);
  }
  const bodyVis = new Uint8Array(N);
  for (let i = 0; i < N; i++) bodyVis[i] = person.data[i] && !(headVis[i] && rowOf(i) < yCut - band) ? 1 : 0;

  const headArea = area(headVis), bodyArea = area(bodyVis);
  if (headArea < 0.08 * personArea) return { failure: `the head is only ${((100 * headArea) / personArea).toFixed(0)}% of the person` };
  if (bodyArea < 0.15 * personArea) return { failure: `the body is only ${((100 * bodyArea) / personArea).toFixed(0)}% of the person` };
  let uncovered = 0;
  for (let i = 0; i < N; i++) if (person.data[i] && !headVis[i] && !bodyVis[i]) uncovered++;
  if (uncovered) return { failure: `${uncovered} px of the person are in neither part` };

  // colour for the hidden jaw: skin from the visible face and neck around it (normalized convolution at three widths)
  const filled = Uint8Array.from(rgb);
  const fillArea = area(fill);
  if (fillArea > 0) {
    const fb = maskBox(mk(W, H, fill))!;
    const pad = 110;
    const x0 = Math.max(0, Math.floor(fb.x0 - pad)), y0 = Math.max(0, Math.floor(fb.y0 - pad)), x1 = Math.min(W, Math.ceil(fb.x1 + pad)), y1 = Math.min(H, Math.ceil(fb.y1 + pad));
    const cw = x1 - x0, ch = y1 - y0;
    const skin = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const i = (y + y0) * W + x + x0; skin[y * cw + x] = (inp.face[i] | inp.neck[i]) && headVis[i] && !fill[i] && !inp.hands[i] ? 1 : 0; }
    const painted = new Uint8Array(N);
    for (const sigma of [10, 24, 60]) {
      const wgt = gaussBlurZero(skin, cw, ch, sigma);
      const chan = [0, 1, 2].map((c) => { const v = new Float32Array(cw * ch); for (let k = 0; k < v.length; k++) { const gi = (Math.floor(k / cw) + y0) * W + (k % cw) + x0; v[k] = skin[k] * rgb[gi * 3 + c]; } return gaussBlurZero(v, cw, ch, sigma); });
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const gi = (y + y0) * W + x + x0;
        if (!fill[gi] || painted[gi]) continue;
        const wv = wgt[y * cw + x];
        if (wv < 0.02) continue; // too far from any skin at this width; a wider one takes it
        for (let c = 0; c < 3; c++) filled[gi * 3 + c] = Math.max(0, Math.min(255, Math.round(chan[c][y * cw + x] / wv)));
        painted[gi] = 1;
      }
    }
    let unpainted = 0;
    for (let i = 0; i < N; i++) if (fill[i] && !painted[i]) unpainted++;
    notes.push(`hidden jaw: ${fillArea} px painted in${unpainted ? `, ${unpainted} left as photographed` : ''}`);
  }

  const headCutout = new Uint8Array(N), seam = new Uint8Array(N);
  for (let i = 0; i < N; i++) { headCutout[i] = headVis[i] | fill[i]; seam[i] = headVis[i] & bodyVis[i]; }
  return { head: mk(W, H, headVis), body: mk(W, H, bodyVis), headCutout: mk(W, H, headCutout), fill: mk(W, H, fill), seam: mk(W, H, seam), filled, yCut, band, chinY, notes };
}

/* ---------------------------------------------------------------- the face regions for the corrector --------------------------------------------------------------- */

/** Masks of the head's eyes, brows, lips and nose from SAM. A region that is missing or implausible is left out. */
export function pickRegions(found: Record<string, SamInstances>, head: Mask): { masks: Record<string, Mask>; notes: string[] } {
  const masks: Record<string, Mask> = {};
  const notes: string[] = [];
  const headArea = maskArea(head);
  for (const [name, insts] of Object.entries(found)) {
    const on = onPerson(insts, head, { minInside: 0.9 });
    if (!on.length) { notes.push(`${name}: not found on the head`); continue; }
    // eyes and brows come as one mask or one per side; lips and nose as one
    const take = name === 'eyes' || name === 'brows' ? on.slice(0, 2) : on.slice(0, 1);
    const data = unionOf(head.width, head.height, take.map((t) => t.mask));
    const n = area(data);
    if (n < 150) { notes.push(`${name}: only ${n} px, left out`); continue; }
    if (n > 0.06 * headArea) { notes.push(`${name}: ${n} px is too much of the head, left out`); continue; }
    masks[name] = mk(head.width, head.height, data);
  }
  return { masks, notes };
}

/* ---------------------------------------------------------------- the step --------------------------------------------------------------- */

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'person';

function pixelPoint(m: Mask): { x: number; y: number } {
  const c = centroid(m.data, m.width)!;
  let best = Infinity, bx = 0, by = 0;
  for (let i = 0; i < m.data.length; i++) if (m.data[i]) { const x = i % m.width, y = Math.floor(i / m.width), d = (x - c[0]) ** 2 + (y - c[1]) ** 2; if (d < best) { best = d; bx = x; by = y; } }
  return { x: bx, y: by };
}

/** Split every person the plan marked, replacing each with a head and a body. Returns the step's message. */
export async function splitPeople(world: WorldHandle, sam?: SamConcept): Promise<string> {
  const m = world.manifest;
  const plan = m.plan;
  if (!m.options.splitPeople) return 'Off for this world';
  if (!plan) return 'No plan';
  const todo = plan.objects.filter((p) => p.splitHeadBody && !p.part && m.objects.find((o) => o.id === p.id)?.mask);
  if (!todo.length) return 'No person to split';
  const { width: W, height: H } = m.image;
  // The photo's own bytes and pixels. (sharp(file).toBuffer() would re-encode the JPEG, and its noise would reach the head's cutout.)
  const photoBytes = await readFile(world.file(m.image.file));
  const decoded = await sharp(photoBytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.width !== W || decoded.info.height !== H) throw new Error(`the photo is ${decoded.info.width}x${decoded.info.height}, the manifest says ${W}x${H}`);
  const rgb = new Uint8Array(decoded.data);
  const ask = sam ?? samConceptFor(photoBytes, W, H);
  const done: string[] = [];
  let unreachable = false;

  for (const planned of todo) {
    const rec = m.objects.find((o) => o.id === planned.id)!;
    let requests = 0, failures = 0;
    const call = async (concept: string): Promise<SamInstances> => {
      requests++;
      try { return await ask(concept); } catch (err) { failures++; world.log(`SAM could not find "${concept}" for ${planned.name}: ${errorMessage(err)}`); return []; }
    };
    try {
      const person = await maskFromPng(world.file(rec.mask!.file));
      const headBox = gridBoxToPixels(planned.splitHeadBody!.headBox, W, H);
      const near: Box = { x0: headBox.x0 - 0.15 * (headBox.x1 - headBox.x0), y0: headBox.y0 - 0.15 * (headBox.y1 - headBox.y0), x1: headBox.x1 + 0.15 * (headBox.x1 - headBox.x0), y1: headBox.y1 + 0.15 * (headBox.y1 - headBox.y0) };
      const [face, neck, hand, clothing, arm] = await Promise.all(PART_CONCEPTS.map(call));
      if (failures >= PART_CONCEPTS.length) { unreachable = true; throw new Error('SAM 3.1 did not answer'); }
      const faceOn = onPerson(face, person, { near });
      const neckOn = onPerson(neck, person, { near: { x0: near.x0, x1: near.x1, y0: near.y0, y1: near.y1 + (headBox.y1 - headBox.y0) } });
      if (!faceOn.length) throw new Error('SAM found no face inside the planned head box');
      const parts: SplitInput = {
        width: W, height: H, rgb, person,
        face: faceOn[0].mask.data,
        neck: neckOn.length ? neckOn[0].mask.data : new Uint8Array(W * H),
        hands: unionOf(W, H, onPerson(hand, person).map((i) => i.mask)),
        clothing: unionOf(W, H, onPerson(clothing, person).map((i) => i.mask)),
        arms: unionOf(W, H, onPerson(arm, person).map((i) => i.mask)),
      };
      const built = buildSplit(parts);
      if ('failure' in built) throw new Error(built.failure);

      // the corrector's regions, on the head
      const regionCalls = await Promise.all(Object.entries(REGION_CONCEPTS).map(async ([name, concept]) => [name, await call(concept)] as const));
      const { masks: regions, notes: regionNotes } = pickRegions(Object.fromEntries(regionCalls), built.headCutout);
      await world.addCost({ label: `SAM 3.1 part masks: ${planned.name}`, usd: (requests - failures) * SAM_IMAGE_PRICE_USD, provider: 'meta', estimated: false });

      // write the files, then swap the objects in one update
      const headId = `${planned.id}-head`, bodyId = `${planned.id}-body`;
      const box = (mask: Mask) => maskBox(mask)!;
      const writeMask = async (rel: string, mask: Mask) => writeFileAtomic(world.file(rel), await maskToPng(mask));
      await writeMask(`objects/${headId}/mask.png`, built.head);
      await writeMask(`objects/${headId}/mask-cutout.png`, built.headCutout);
      await writeMask(`objects/${headId}/jaw-fill.png`, built.fill);
      await writeMask(`objects/${headId}/seam-band.png`, built.seam);
      await writeFileAtomic(world.file(`objects/${headId}/${FILLED_SOURCE}`), await sharp(Buffer.from(built.filled), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer());
      for (const [name, mask] of Object.entries(regions)) await writeMask(`objects/${headId}/${REGION_DIR}/${name}.png`, mask);
      await writeMask(`objects/${bodyId}/mask.png`, built.body);

      const personBox = box(person), headPx = box(built.head), bodyPx = box(built.body);
      const toGrid = (b: Box): Box => ({ x0: Math.floor((b.x0 / W) * 1000), y0: Math.floor((b.y0 / H) * 1000), x1: Math.ceil((b.x1 / W) * 1000), y1: Math.ceil((b.y1 / H) * 1000) });
      const hRatio = (headPx.y1 - headPx.y0) / Math.max(1, personBox.y1 - personBox.y0);
      const hh = Math.max(0.05, planned.approxSizeM.height * hRatio);
      const make = (id: string, name: string, desc: string, mask: Mask, role: 'head' | 'body'): { plan: PlannedObject; rec: ObjectRecord } => {
        const b = box(mask), gb = toGrid(b), pt = pixelPoint(mask);
        return {
          plan: {
            id, name, segmentPrompt: role === 'head' ? 'head' : 'torso and arms', description: desc, box: gb,
            point: { x: Math.round((pt.x / W) * 1000), y: Math.round((pt.y / H) * 1000) },
            // the hidden jaw is painted in and IDOL handles the frame's edge, so neither part is sent to image completion
            occluded: false, truncated: false,
            contact: role === 'head' ? 'free' : planned.contact, importance: planned.importance,
            approxSizeM: role === 'head' ? { width: hh * 0.85, height: hh, depth: hh * 0.9 } : planned.approxSizeM,
            part: { of: planned.id, role },
          },
          rec: { id, name, status: 'pending', mask: { file: `objects/${id}/mask.png`, box: b, area: maskArea(mask), method: 'concept' } },
        };
      };
      const head = make(headId, `${planned.name}'s head and neck`, `The head and neck of ${planned.name}: hair, face and ears. ${planned.description}`.trim(), built.head, 'head');
      const body = make(bodyId, `${planned.name}'s torso and arms`, `The torso, arms and hands of ${planned.name}, without the head. ${planned.description}`.trim(), built.body, 'body');
      await world.update((mm) => {
        const at = mm.objects.findIndex((o) => o.id === planned.id);
        mm.objects.splice(at < 0 ? mm.objects.length : at, 1, head.rec, body.rec);
        const pi = mm.plan!.objects.findIndex((o) => o.id === planned.id);
        mm.plan!.objects.splice(pi < 0 ? mm.plan!.objects.length : pi, 1, head.plan, body.plan);
      });
      const regionList = Object.keys(regions);
      world.log(`Split ${planned.name} into a head and a body (cut ${built.yCut - built.chinY} px below the chin, ${2 * built.band} px overlap); ${built.notes.join('; ') || 'nothing hidden to fill'}; corrector regions: ${regionList.join(', ') || 'none'}${regionNotes.length ? ` (${regionNotes.join('; ')})` : ''}`);
      // The two parts still need cutouts and 3D models. On a retry those steps can already be done (for the person as one object), so open them again.
      await world.update((mm) => {
        for (const id of ['cutouts', 'meshes'] as const) if (mm.steps[id] && mm.steps[id].status !== 'running') mm.steps[id] = { ...mm.steps[id], status: 'pending', message: undefined, error: undefined };
      });
      if (rec.mesh?.file) world.log(`${planned.name} had already been built as one object; that asset (${rec.mesh.file}) stays on disk but is no longer shown`);
      done.push(planned.name);
    } catch (err) {
      world.log(`${planned.name} stays one object: ${errorMessage(err)}`);
      await world.addCost({ label: `SAM 3.1 part masks: ${planned.name}`, usd: (requests - failures) * SAM_IMAGE_PRICE_USD, provider: 'meta', estimated: false });
    }
  }
  if (unreachable && !done.length) throw new Error('SAM 3.1 did not answer, so the person stays one object; retry to try again');
  return done.length ? `${done.length} person split into a head and a body` : 'No person could be split; kept whole';
}

/**
 * What an object's cutout is made from. The head of a split person, on the mask the split gave it, is cut from the photo with the jaw its
 * hand hides painted in, and its cutout includes that jaw. Once its mask has been redone by hand it is cut like any other object.
 */
export function cutoutInputs(world: WorldHandle, o: ObjectRecord, planned: PlannedObject | undefined): { maskFile: string; sourceFile: string | null } {
  const plain = { maskFile: world.file(o.mask!.file), sourceFile: null };
  if (planned?.part?.role !== 'head' || (o.maskVersion ?? 1) !== 1) return plain;
  const filled = world.file(`objects/${o.id}/${FILLED_SOURCE}`), cut = world.file(`objects/${o.id}/mask-cutout.png`);
  return existsSync(filled) && existsSync(cut) ? { maskFile: cut, sourceFile: filled } : plain;
}
