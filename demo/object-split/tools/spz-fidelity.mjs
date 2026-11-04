// How much does the SPZ conversion change what you see? Compares Spark renders of the full-quality PLY parts with renders of the
// SPZ files the page loads, from three cameras, over the whole frame and over the two eye regions.
//   node .scratch/idol-split/render-parts.mjs .scratch/idol-split/demo/cfg-ply.json    (and cfg-spz.json): the renders this reads
//   node demo/object-split/tools/spz-fidelity.mjs
// Writes demo/object-split/parts/placement/measurements/spz-fidelity.txt, which the page quotes.
import fs from 'node:fs';
import sharp from 'sharp';
import { EYES, FEATHER, distToEyes } from './eye-metrics.mjs';

const DIR = '.scratch/idol-split/demo', OUT = 'demo/object-split/parts/placement/measurements/spz-fidelity.txt';
const FRAMES = [['photocam', "the photo's own camera"], ['close0', 'close up, straight on'], ['close40', 'close up, 40° around']];
const raw = async (f) => sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const lines = ['Spark renders of the full-quality PLY parts against the SPZ files the page loads (head with eye corrector + body).', 'Differences are in 0-255 per colour value; "over N" is the share of values that differ by more than N.', ''];
const summary = {};
for (const [name, label] of FRAMES) {
  const a = await raw(`${DIR}/ply-${name}.png`), b = await raw(`${DIR}/spz-${name}.png`);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) throw new Error(`${name}: renders differ in size`);
  const { width: w, height: h, channels: ch } = a.info;
  const acc = { all: { n: 0, sum: 0, max: 0, o1: 0, o4: 0 }, eyes: { n: 0, sum: 0, max: 0, o1: 0, o4: 0 } };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inEyes = name === 'photocam' && distToEyes(x + 0.5, y + 0.5) < FEATHER; // eye windows are only meaningful at the photo's camera
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[(y * w + x) * ch + c] - b.data[(y * w + x) * ch + c]);
      for (const k of inEyes ? ['all', 'eyes'] : ['all']) { const s = acc[k]; s.n++; s.sum += d; if (d > s.max) s.max = d; if (d > 1) s.o1++; if (d > 4) s.o4++; }
    }
  }
  const fmt = (s) => `mean ${(s.sum / s.n).toFixed(2)}, max ${s.max}, over 1: ${(100 * s.o1 / s.n).toFixed(1)}%, over 4: ${(100 * s.o4 / s.n).toFixed(2)}%`;
  lines.push(`${label} (${w}x${h}): whole frame ${fmt(acc.all)}`);
  if (name === 'photocam') lines.push(`${' '.repeat(label.length + 12)}eye regions ${fmt(acc.eyes)}`);
  summary[name] = { all: acc.all, eyes: acc.eyes.n ? acc.eyes : null };
}
fs.writeFileSync(OUT, lines.join('\n') + '\n');
// the same figures, for the page to read
const round = (s) => (s ? { mean: +(s.sum / s.n).toFixed(2), max: s.max, over1Pct: +(100 * s.o1 / s.n).toFixed(1), over4Pct: +(100 * s.o4 / s.n).toFixed(2) } : null);
fs.writeFileSync(OUT.replace(/\.txt$/, '.json'), JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, { all: round(v.all), eyes: round(v.eyes) }])), null, 2) + '\n');
console.log(lines.join('\n'));
