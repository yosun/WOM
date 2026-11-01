// Load a 3D Gaussian-splat PLY (TripoSplat and similar) as a point cloud for fitting and previews.
import { readFile } from 'node:fs/promises';

export interface PointCloud {
  count: number;
  positions: Float32Array; // xyz, model space
  colors: Uint8Array; // rgb
  radii: Float32Array; // approximate visual radius per point (model units)
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

const SH_C0 = 0.28209479177387814;
const TYPE_SIZE: Record<string, number> = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

export async function loadPlyCloud(file: string, opts: { maxPoints?: number; minOpacity?: number } = {}): Promise<PointCloud> {
  const buf = await readFile(file);
  const end = buf.indexOf('end_header');
  if (end < 0) throw new Error('not a PLY file');
  const headerEnd = buf.indexOf('\n', end) + 1;
  const header = buf.subarray(0, headerEnd).toString('latin1');
  if (!/format binary_little_endian/.test(header)) throw new Error('only binary little-endian PLY is supported');
  const count = Number(/element vertex (\d+)/.exec(header)?.[1] ?? 0);
  // Properties of the vertex element (stop at the next element).
  const vertexSection = header.slice(header.indexOf('element vertex'));
  const nextElement = vertexSection.indexOf('element ', 10);
  const lines = (nextElement > 0 ? vertexSection.slice(0, nextElement) : vertexSection).split('\n');
  const props: { name: string; type: string; offset: number }[] = [];
  let stride = 0;
  for (const line of lines) {
    const m = /^property (\w+) (\w+)$/.exec(line.trim());
    if (!m) continue;
    props.push({ type: m[1], name: m[2], offset: stride });
    stride += TYPE_SIZE[m[1]] ?? 4;
  }
  const off = (name: string) => props.find((p) => p.name === name)?.offset ?? -1;
  const ox = off('x'), oy = off('y'), oz = off('z');
  if (ox < 0 || oy < 0 || oz < 0) throw new Error('PLY has no x/y/z');
  const odc = [off('f_dc_0'), off('f_dc_1'), off('f_dc_2')];
  const orgb = [off('red'), off('green'), off('blue')];
  const oop = off('opacity');
  const osc = [off('scale_0'), off('scale_1'), off('scale_2')];
  const dv = new DataView(buf.buffer, buf.byteOffset + headerEnd, Math.min(count * stride, buf.byteLength - headerEnd));
  const minOpacity = opts.minOpacity ?? 0.1;

  const keep: number[] = [];
  for (let i = 0; i < count; i++) {
    if (oop >= 0) {
      const a = 1 / (1 + Math.exp(-dv.getFloat32(i * stride + oop, true)));
      if (a < minOpacity) continue;
    }
    keep.push(i);
  }
  const step = Math.max(1, Math.floor(keep.length / (opts.maxPoints ?? keep.length)));
  const n = Math.ceil(keep.length / step);
  const positions = new Float32Array(n * 3);
  const colors = new Uint8Array(n * 3);
  const radii = new Float32Array(n);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let j = 0;
  for (let t = 0; t < keep.length; t += step, j++) {
    const base = keep[t] * stride;
    const p = [dv.getFloat32(base + ox, true), dv.getFloat32(base + oy, true), dv.getFloat32(base + oz, true)];
    for (let k = 0; k < 3; k++) {
      positions[j * 3 + k] = p[k];
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
      let c = 0.5;
      if (odc[k] >= 0) c = 0.5 + SH_C0 * dv.getFloat32(base + odc[k], true);
      else if (orgb[k] >= 0) c = dv.getUint8(base + orgb[k]) / 255;
      colors[j * 3 + k] = Math.max(0, Math.min(255, Math.round(c * 255)));
    }
    let r = 0.004;
    if (osc[0] >= 0) {
      // 1.5 × the geometric mean of the two largest axes. Checked against Spark's own rendering of
      // TripoSplat objects: silhouettes agree at IoU 0.92–0.98 on the fitting grid. (Larger discs made
      // the fitter shrink every object to compensate.)
      const s = [dv.getFloat32(base + osc[0], true), dv.getFloat32(base + osc[1], true), dv.getFloat32(base + osc[2], true)].sort((a, b) => a - b);
      r = 1.5 * Math.exp((s[1] + s[2]) / 2);
    }
    radii[j] = r;
  }
  return { count: j, positions: positions.subarray(0, j * 3), colors: colors.subarray(0, j * 3), radii: radii.subarray(0, j), bounds: { min, max } };
}
