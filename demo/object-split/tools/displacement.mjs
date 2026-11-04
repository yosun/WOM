// How far did the alignment move the Gaussians? Compares IDOL's raw output with the aligned file, Gaussian by Gaussian
// (same order, same rotation), in millimetres in the scene (positions are in IDOL's frame, scaled by the part's pose).
//   node demo/object-split/tools/displacement.mjs
import fs from 'node:fs';

const P = 'demo/object-split/parts';
const layout = JSON.parse(fs.readFileSync(`${P}/placement/layout.json`, 'utf8')).objects;

function readPly(file) {
  const buf = fs.readFileSync(file);
  const end = buf.indexOf('end_header\n') + 'end_header\n'.length;
  const hdr = buf.subarray(0, end).toString('latin1');
  const n = Number(/element vertex (\d+)/.exec(hdr)[1]);
  const props = [...hdr.matchAll(/property float (\w+)/g)].map((m) => m[1]);
  const F = props.length;
  const f = new Float32Array(buf.buffer.slice(buf.byteOffset + end, buf.byteOffset + end + n * F * 4));
  return { n, F, f, iOp: props.indexOf('opacity') };
}
const pct = (a, q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
export function displacement(rawFile, alignedFile, scale) {
  const a = readPly(rawFile), b = readPly(alignedFile);
  if (a.n !== b.n) throw new Error('different Gaussian counts');
  const d = [], solid = [];
  for (let i = 0; i < a.n; i++) {
    const o = i * a.F;
    const mm = Math.hypot(b.f[o] - a.f[o], b.f[o + 1] - a.f[o + 1], b.f[o + 2] - a.f[o + 2]) * scale * 1000;
    d.push(mm);
    if (1 / (1 + Math.exp(-a.f[o + a.iOp])) > 0.5) solid.push(mm);
  }
  d.sort((x, y) => x - y); solid.sort((x, y) => x - y);
  return { gaussians: a.n, meanMm: d.reduce((s, v) => s + v, 0) / d.length, p50Mm: pct(d, 0.5), p95Mm: pct(d, 0.95), p99Mm: pct(d, 0.99), maxMm: d[d.length - 1], solidP95Mm: pct(solid, 0.95) };
}
const scaleOf = (id) => layout.find((o) => o.id === id).scale;
const out = {
  head: displacement(`${P}/splats/ply/head.idol-raw.ply`, `${P}/splats/ply/head.aligned.ply`, scaleOf('woman-head')),
  body: displacement(`${P}/splats/ply/body.idol-raw.ply`, `${P}/splats/ply/body.aligned.ply`, scaleOf('woman-body')),
};
if (process.argv[1].endsWith('displacement.mjs')) {
  for (const [k, v] of Object.entries(out)) console.log(`${k}: ${v.gaussians} Gaussians moved by mean ${v.meanMm.toFixed(1)} mm, median ${v.p50Mm.toFixed(1)}, p95 ${v.p95Mm.toFixed(1)}, p99 ${v.p99Mm.toFixed(1)}, max ${v.maxMm.toFixed(1)} mm`);
}
export default out;
