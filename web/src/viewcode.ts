// A view is where the camera stands and which way it looks: seven numbers, "x,y,z,qx,qy,qz,qw", in the
// viewer's scene coordinates. It travels in a public world path such as /u/<handle>/<world>?view=…, so a person
// can reopen the exact camera without signing in.
import { worldHref } from './routes.ts';

export interface ViewPose {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

const trim = (v: number, digits: number) => String(Number(v.toFixed(digits)));

export function encodeView(p: ViewPose): string {
  return [...p.position.map((v) => trim(v, 3)), ...p.quaternion.map((v) => trim(v, 4))].join(',');
}

/** The pose a code stands for, or null when it is not seven finite numbers with a usable quaternion. */
export function decodeView(code: string | null | undefined): ViewPose | null {
  if (!code) return null;
  const n = code.split(',').map((s) => (s.trim() === '' ? Number.NaN : Number(s)));
  if (n.length !== 7 || !n.every(Number.isFinite)) return null;
  const len = Math.hypot(n[3], n[4], n[5], n[6]);
  if (len < 0.5 || len > 1.5) return null;
  return { position: [n[0], n[1], n[2]], quaternion: [n[3] / len, n[4] / len, n[5] / len, n[6] / len] };
}

/**
 * In-app link that opens a world at a view. With `compare` (the id of a flag made from that view) the viewer
 * lays the flagged frame over the live view, to wipe between what was flagged and what the world shows now.
 */
export function viewLink(world: string, p: ViewPose, compare?: string): string {
  const query = new URLSearchParams({ view: encodeView(p) });
  if (compare) query.set('compare', compare);
  return worldHref(world, { query });
}
