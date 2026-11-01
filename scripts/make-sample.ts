// Generate a sample "memory" photo with Muse Image for trying the pipeline ($0.01).
// Usage: node --env-file=.env scripts/make-sample.ts [output.png] ["prompt"]
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { museImageGenerate } from '../server/src/clients/meta.ts';

const out = process.argv[2] ?? 'samples/backyard.png';
const prompt =
  process.argv[3] ??
  'A candid smartphone photo of a sunny backyard garden in late afternoon. On the lawn in the middle ground: a golden retriever sitting and looking at the camera, a red vintage bicycle standing on its kickstand, a wooden garden bench, and a large terracotta pot with a small lemon tree. A wooden fence and green hedges behind, a few trees, soft blue sky. Eye-level view, natural light, realistic photograph, everything sharp.';

const png = await museImageGenerate(prompt, '1536x1024');
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, png);
console.log(`wrote ${out} (${png.byteLength} bytes)`);
