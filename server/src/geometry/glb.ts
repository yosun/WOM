// Load a GLB into a single world-space triangle soup (positions, UVs, base-color texture) for fitting,
// and optimize GLBs for the browser (WebP textures, capped resolution).
import { readFile } from 'node:fs/promises';
import { NodeIO, type Document, type Node as GltfNode, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

let ioPromise: Promise<NodeIO> | null = null;
export function gltfIO(): Promise<NodeIO> {
  ioPromise ??= (async () => {
    await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
    return new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  })();
  return ioPromise;
}

export interface TriMesh {
  positions: Float32Array; // xyz per vertex, model space
  uvs: Float32Array | null; // uv per vertex
  indices: Uint32Array;
  texture: { width: number; height: number; rgb: Uint8Array } | null;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

function worldMatrixOf(node: GltfNode): number[] {
  return node.getWorldMatrix() as unknown as number[];
}

function transformPoint(m: number[], x: number, y: number, z: number): [number, number, number] {
  // glTF matrices are column-major.
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Flatten every triangle primitive in the default scene into one mesh in scene (model) coordinates. */
export async function loadTriMesh(file: string, opts: { withTexture?: boolean } = {}): Promise<TriMesh> {
  const io = await gltfIO();
  const doc = await io.read(file);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let hasUv = true;
  let texturePrimitive: Primitive | null = null;
  scene?.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const m = worldMatrixOf(node);
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue; // TRIANGLES only
      const p = prim.getAttribute('POSITION');
      if (!p) continue;
      const t = prim.getAttribute('TEXCOORD_0');
      if (!t) hasUv = false;
      const base = pos.length / 3;
      const el: number[] = [];
      for (let i = 0; i < p.getCount(); i++) {
        const v = p.getElement(i, el) as number[];
        const w = transformPoint(m, v[0], v[1], v[2]);
        pos.push(w[0], w[1], w[2]);
        if (t) {
          const tv = t.getElement(i, el) as number[];
          uv.push(tv[0], tv[1]);
        } else {
          uv.push(0, 0);
        }
      }
      const ind = prim.getIndices();
      if (ind) {
        const arr = ind.getArray()!;
        for (let i = 0; i < arr.length; i++) idx.push(base + arr[i]);
      } else {
        for (let i = 0; i < p.getCount(); i++) idx.push(base + i);
      }
      if (!texturePrimitive && prim.getMaterial()?.getBaseColorTexture()) texturePrimitive = prim;
    }
  });
  const positions = new Float32Array(pos);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (positions[i + k] < min[k]) min[k] = positions[i + k];
      if (positions[i + k] > max[k]) max[k] = positions[i + k];
    }
  }
  let texture: TriMesh['texture'] = null;
  if (opts.withTexture && hasUv && texturePrimitive) {
    const img = (texturePrimitive as Primitive).getMaterial()!.getBaseColorTexture()!.getImage();
    if (img) {
      const { data, info } = await sharp(Buffer.from(img)).resize(512, 512, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      texture = { width: info.width, height: info.height, rgb: new Uint8Array(data) };
    }
  }
  return { positions, uvs: hasUv ? new Float32Array(uv) : null, indices: new Uint32Array(idx), texture, bounds: { min, max } };
}

/** Simplify a mesh for fast silhouette fitting (topology-preserving, keeps UVs via the vertex remap). */
export async function simplifyForFitting(mesh: TriMesh, targetTriangles: number): Promise<TriMesh> {
  const triCount = mesh.indices.length / 3;
  if (triCount <= targetTriangles) return mesh;
  await MeshoptSimplifier.ready;
  const target = Math.max(3, Math.floor(targetTriangles) * 3);
  const [indices] = MeshoptSimplifier.simplify(mesh.indices, mesh.positions, 3, target, 0.02, ['LockBorder']);
  let out = indices;
  if (out.length / 3 > targetTriangles * 1.5) {
    out = MeshoptSimplifier.simplifySloppy(mesh.indices, mesh.positions, 3, null, target, 0.05)[0];
  }
  return { ...mesh, indices: new Uint32Array(out) };
}

/**
 * Make a Tripo GLB lighter for the browser: dedupe, prune, WebP textures capped at `maxTexture` px.
 * Geometry is untouched so placement fitted on the raw mesh stays valid.
 */
export async function optimizeGlb(input: string, output: string, maxTexture = 2048) {
  const io = await gltfIO();
  const doc: Document = await io.read(input);
  await doc.transform(
    dedup(),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [maxTexture, maxTexture], quality: 88 }),
  );
  const bytes = await io.writeBinary(doc);
  const { writeFileAtomic } = await import('../util.ts');
  await writeFileAtomic(output, bytes);
  return bytes.byteLength;
}

export async function glbBytes(file: string) {
  return new Uint8Array(await readFile(file));
}
