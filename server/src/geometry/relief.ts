// Build a textured "relief" mesh of the background from a depth map: a grid of camera-space points
// (three.js frame) with the clean plate as an unlit texture. It lines up with the photo exactly when
// seen from the original camera and gives a precise near-field backdrop.
import { Document } from '@gltf-transform/core';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { gltfIO } from './glb.ts';
import type { Intrinsics } from './moge.ts';
import { writeFileAtomic } from '../util.ts';

export async function buildReliefGlb(opts: {
  depth: Float32Array;
  valid: Uint8Array;
  k: Intrinsics; // on the depth grid
  textureJpeg: Uint8Array;
  out: string;
  gridLong?: number;
  maxDepth?: number;
}) {
  const { depth, valid, k } = opts;
  const W = k.width, H = k.height;
  const long = opts.gridLong ?? 320;
  const gw = W >= H ? long : Math.max(8, Math.round((long * W) / H));
  const gh = W >= H ? Math.max(8, Math.round((long * H) / W)) : long;
  const maxDepth = opts.maxDepth ?? 400;

  const sample = (u: number, v: number): number => {
    // Median of valid depths in a small neighbourhood (robust at edges).
    const x0 = Math.floor(u), y0 = Math.floor(v);
    const vals: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      const y = y0 + dy;
      if (y < 0 || y >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const x = x0 + dx;
        if (x < 0 || x >= W) continue;
        const i = y * W + x;
        if (valid[i] && depth[i] > 0 && depth[i] < maxDepth) vals.push(depth[i]);
      }
    }
    if (vals.length < 3) return NaN;
    vals.sort((a, b) => a - b);
    return vals[vals.length >> 1];
  };

  const positions = new Float32Array(gw * gh * 3);
  const uvs = new Float32Array(gw * gh * 2);
  const z = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    const v = (j / (gh - 1)) * H;
    for (let i = 0; i < gw; i++) {
      const u = (i / (gw - 1)) * W;
      const d = sample(Math.min(W - 1, u), Math.min(H - 1, v));
      const idx = j * gw + i;
      z[idx] = d;
      const X = ((u - k.cx) / k.fx) * d, Y = ((v - k.cy) / k.fy) * d;
      positions[idx * 3] = Number.isFinite(d) ? X : 0;
      positions[idx * 3 + 1] = Number.isFinite(d) ? -Y : 0;
      positions[idx * 3 + 2] = Number.isFinite(d) ? -d : 0;
      uvs[idx * 2] = u / W;
      uvs[idx * 2 + 1] = v / H;
    }
  }

  // Keep a triangle when its depths are similar (no tearing across occlusion edges).
  const cellAngle = Math.max(W / gw / k.fx, H / gh / k.fy);
  // Small depth steps are bridged (a stretched texture reads better than a hole); real occlusion edges tear.
  const maxRatio = 1 + Math.max(0.08, 36 * cellAngle);
  const tris: number[] = [];
  const ok = (a: number, b: number, c: number) => {
    const za = z[a], zb = z[b], zc = z[c];
    if (!Number.isFinite(za) || !Number.isFinite(zb) || !Number.isFinite(zc)) return false;
    return Math.max(za, zb, zc) / Math.min(za, zb, zc) < maxRatio;
  };
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const a = j * gw + i, b = a + 1, c = a + gw, d = c + 1;
      if (ok(a, c, b)) tris.push(a, c, b);
      if (ok(b, c, d)) tris.push(b, c, d);
    }
  }

  const doc = new Document();
  const buffer = doc.createBuffer();
  const unlit = doc.createExtension(KHRMaterialsUnlit);
  const texture = doc.createTexture('clean-plate').setImage(opts.textureJpeg).setMimeType('image/jpeg');
  const material = doc
    .createMaterial('relief')
    .setBaseColorTexture(texture)
    .setDoubleSided(true)
    .setRoughnessFactor(1)
    .setMetallicFactor(0)
    .setExtension('KHR_materials_unlit', unlit.createUnlit());
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(tris)).setBuffer(buffer))
    .setMaterial(material);
  const mesh = doc.createMesh('relief').addPrimitive(prim);
  const node = doc.createNode('relief').setMesh(mesh);
  doc.createScene('relief').addChild(node);
  const io = await gltfIO();
  const bytes = await io.writeBinary(doc);
  await writeFileAtomic(opts.out, bytes);
  return { triangles: tris.length / 3, bytes: bytes.byteLength };
}
