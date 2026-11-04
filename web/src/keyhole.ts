// The keyhole: the shape of the viewer's aperture and of the mark on every slide. Pure geometry, no drawing.
//
// The proportions are those of the keyhole in the WOM logo (favicon/wom.favicon.png), measured along the middle of
// its outline: a round head on a body that tapers in to the neck and flares out to a flat base, with sharp corners
// where the head meets the neck and at the base, and a dot under it. All lengths are in units of the keyhole's
// height (`size`), laid out around (cx, cy), the middle of that height. The head is 0.43 wide, the neck opening
// 0.16, the base 0.38; the dot sits 0.1 under the base.
//
// Everything that grows or shrinks scales about the middle of the head (the "eye"), so the opening widens like an iris:
// when the head has grown past the corners of the stage, the stage is inside the keyhole.

/** Where a keyhole is: `size` is its height, (cx, cy) the middle of that height. */
export interface KeyholeGeo { cx: number; cy: number; size: number }

/** The keyhole at rest, in units of its height around the middle of that height. */
export const KEYHOLE = {
  /** Radius of the round head. */
  r: 0.215,
  /** The middle of the head; the head touches the top of the keyhole. */
  headY: -0.285,
  /** Half the width of the neck, where the body meets the head. */
  neckX: 0.08,
  /** Half the width of the base. */
  baseX: 0.19,
  /** Where the flat base is. */
  baseY: 0.5,
  /** The middle of the dot under the keyhole, and its radius. */
  dotY: 0.605,
  dotR: 0.023,
} as const;

/**
 * Before it is tapped a keyhole rests at this share of the size it has once open (an eighth of its height), and
 * never under `KEYHOLE_REST_MIN` screen px tall, so on a small screen it is still a keyhole. Tapping it grows it
 * to its full size (the slide's flight in the space, `wake` in the aperture).
 */
export const KEYHOLE_REST = 1 / 8;
export const KEYHOLE_REST_MIN = 20;

/** The keyhole at `g` as it rests, smaller about the same middle; `px` is how many screen px one unit is. */
export function restingKeyhole(g: KeyholeGeo, px = 1): KeyholeGeo {
  const least = KEYHOLE_REST_MIN / Math.max(0.02, px);
  return { cx: g.cx, cy: g.cy, size: Math.min(g.size, Math.max(g.size * KEYHOLE_REST, least)) };
}

/** The head's circle meets the body here. */
const NECK_Y = KEYHOLE.headY + Math.sqrt(KEYHOLE.r ** 2 - KEYHOLE.neckX ** 2);

const f = (n: number) => n.toFixed(2);

/** The keyhole's outline pulled in by `d` all round: the head's radius, the neck, the base. */
function profile(d: number) {
  const { r, headY, neckX, baseX, baseY } = KEYHOLE;
  // The left side runs up from the base corner to the neck. Pull it in along its inward normal, then find where
  // it meets the base line (pulled up by `d`) and the head's circle (pulled in by `d`).
  const ux = baseX - neckX, uy = NECK_Y - baseY;
  const len = Math.hypot(ux, uy);
  const dirX = ux / len, dirY = uy / len;
  const nx = -dirY, ny = dirX;
  const qx = -baseX + d * nx, qy = baseY + d * ny;
  const tBase = (baseY - d - qy) / dirY;
  const wx = qx, wy = qy - headY;
  const b = wx * dirX + wy * dirY;
  const rr = r - d;
  const tNeck = -b - Math.sqrt(Math.max(0, b * b - (wx * wx + wy * wy) + rr * rr));
  return {
    r: rr,
    baseX: -(qx + tBase * dirX),
    baseY: baseY - d,
    neckX: -(qx + tNeck * dirX),
    neckY: qy + tNeck * dirY,
  };
}

/** Where a point of the keyhole at rest lands for a keyhole at `g`, grown by `scale` about its head, moved by (dx, dy). */
function placer(g: KeyholeGeo, scale: number, dx: number, dy: number) {
  const ay = KEYHOLE.headY;
  return (ux: number, uy: number): [number, number] => [g.cx + ux * scale * g.size + dx, g.cy + (ay + (uy - ay) * scale) * g.size + dy];
}

/**
 * The keyhole as an SVG path: grown by `scale` about its head, pulled in by `inset` (in units of the height, before
 * it grows), moved by (dx, dy). Its corners are sharp.
 */
export function keyholePath(g: KeyholeGeo, scale = 1, inset = 0, dx = 0, dy = 0): string {
  const p = profile(inset);
  const at = placer(g, scale, dx, dy);
  const [blx, bly] = at(-p.baseX, p.baseY), [nlx, nly] = at(-p.neckX, p.neckY);
  const [nrx, nry] = at(p.neckX, p.neckY), [brx, bry] = at(p.baseX, p.baseY);
  const rr = f(p.r * g.size * scale);
  return `M${f(blx)},${f(bly)}L${f(nlx)},${f(nly)}A${rr},${rr} 0 1 1 ${f(nrx)},${f(nry)}L${f(brx)},${f(bry)}Z`;
}

/** The dot under the keyhole: its middle and radius, for a keyhole grown by `scale` about its head. */
export function keyholeDot(g: KeyholeGeo, scale = 1): { x: number; y: number; r: number } {
  const [x, y] = placer(g, scale, 0, 0)(0, KEYHOLE.dotY);
  return { x, y, r: KEYHOLE.dotR * g.size * scale };
}

/**
 * The outline as two open paths from the middle of the base to the top of the head, one up each side, equal in
 * length: two lights can rise along them and meet at the top.
 */
export function keyholeHalves(g: KeyholeGeo, scale = 1): { left: string; right: string } {
  const { r, baseX, baseY, neckX, headY } = KEYHOLE;
  const at = placer(g, scale, 0, 0);
  const [bcx, bcy] = at(0, baseY), [blx, bly] = at(-baseX, baseY), [brx, bry] = at(baseX, baseY);
  const [nlx, nly] = at(-neckX, NECK_Y), [nrx, nry] = at(neckX, NECK_Y), [tx, ty] = at(0, headY - r);
  const rr = f(r * g.size * scale);
  return {
    left: `M${f(bcx)},${f(bcy)}L${f(blx)},${f(bly)}L${f(nlx)},${f(nly)}A${rr},${rr} 0 0 1 ${f(tx)},${f(ty)}`,
    right: `M${f(bcx)},${f(bcy)}L${f(brx)},${f(bry)}L${f(nrx)},${f(nry)}A${rr},${rr} 0 0 0 ${f(tx)},${f(ty)}`,
  };
}

/** The middle of the head, which the light and the growth centre on. */
export function keyholeHeart(g: KeyholeGeo): { x: number; y: number } {
  return { x: g.cx, y: g.cy + KEYHOLE.headY * g.size };
}

/** The smallest box round the keyhole at rest and its dot. */
export function keyholeBox(g: KeyholeGeo) {
  const half = Math.max(KEYHOLE.r, KEYHOLE.baseX) * g.size;
  return { x: g.cx - half, y: g.cy - 0.5 * g.size, width: 2 * half, height: (0.5 + KEYHOLE.dotY + KEYHOLE.dotR) * g.size };
}

/**
 * The scale at which the head, grown about its middle, has every corner of a `w` × `h` stage inside it, and
 * `margin` px more for the light at its rim: from there on the whole stage is inside the keyhole.
 */
export function keyholeCover(g: KeyholeGeo, w: number, h: number, margin = 64): number {
  const eye = keyholeHeart(g);
  let far = 0;
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) far = Math.max(far, Math.hypot(x - eye.x, y - eye.y));
  return Math.max(1, ((far + margin) / (KEYHOLE.r * g.size)) * 1.04);
}
