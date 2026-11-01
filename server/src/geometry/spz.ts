// Decode the parts of an SPZ (Niantic gzip'd Gaussian splat) file we need for calibration:
// centers, DC colors, scales and opacity. Marble writes SPZ in its raw OpenCV frame.
import { gunzipSync } from 'node:zlib';

export interface SplatCloud {
  count: number;
  positions: Float32Array;
  colors: Float32Array;
  scales: Float32Array;
  alphas: Float32Array;
}

const SH_C0 = 0.28209479177387814;

export function decodeSpz(gz: Uint8Array): SplatCloud {
  const raw = gunzipSync(gz);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== 0x5053474e) throw new Error('not an SPZ file');
  const version = dv.getUint32(4, true);
  const count = dv.getUint32(8, true);
  const fractionalBits = dv.getUint8(13);
  if (version < 2) throw new Error(`SPZ version ${version} is not supported`);
  let off = 16;
  const positions = new Float32Array(count * 3);
  const inv = 1 / (1 << fractionalBits);
  for (let i = 0; i < count * 3; i++) {
    let v = raw[off] | (raw[off + 1] << 8) | (raw[off + 2] << 16);
    if (v & 0x800000) v |= ~0xffffff;
    positions[i] = v * inv;
    off += 3;
  }
  const alphas = new Float32Array(count);
  for (let i = 0; i < count; i++) alphas[i] = raw[off + i] / 255;
  off += count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) {
    const c = (raw[off + i] / 255 - 0.5) / 0.15;
    colors[i] = Math.min(1, Math.max(0, 0.5 + SH_C0 * c));
  }
  off += count * 3;
  const scales = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) scales[i] = Math.exp(raw[off + i] / 16 - 10);
  return { count, positions, colors, scales, alphas };
}
