// Build a public offline example and a self-contained copy of the standalone WOMPar demo.
// The file allowlist is deliberate: local environments, generated worlds and credentials are never bundled.
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDemo } from '../demo/wompar/wompar.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, 'dist', 'wompar');
const temp = await mkdtemp(path.join(os.tmpdir(), 'wompar-public-'));
const bundle = path.join(temp, 'wompar-demo');
const files = [
  'demo/wompar/README.md', 'demo/wompar/fixture.json', 'demo/wompar/providers.mjs',
  'demo/wompar/wompar.mjs', 'demo/wompar/wompar.test.mjs',
  'demo/object-split/assets/data.json', 'demo/object-split/assets/img/full-photo.webp',
  'demo/object-split/assets/img/full-one.webp', 'demo/object-split/assets/img/full-eyes.webp',
];

try {
  await mkdir(target, { recursive: true });
  for (const name of ['wom-pipeline.svg', 'wom-study.svg']) {
    await copyFile(path.join(root, 'docs', 'images', name), path.join(target, name));
  }
  for (const file of files) {
    const dest = path.join(bundle, file);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(root, file), dest);
  }
  await writeFile(path.join(bundle, 'START-HERE.txt'), `WOMPar: your photo to 3D\n\nRequires Node 22.18 or later; no npm installation.\n\n  cd wompar-demo\n\nCreate .env here and add AI3D_API_KEY=your_key. Replace the image path:\n\n  node demo/wompar/wompar.mjs --provider ai3d --source "/absolute/path/to/my-photo.jpg"\n\nThis submits one paid Marble draft job (default reservation ceiling $2; final charge can differ). Open the printed report.html for world.spz and the provider viewer link when available. If polling times out, continue with --provider ai3d --resume JOB_ID.\n\nExplore without a key or network:\n\n  node demo/wompar/wompar.mjs --offline\n\nKeys remain on your computer. See demo/wompar/README.md for comparison providers, recovery and the full app. Hosted creation: https://wom.quest/?create=1\n`);
  await writeFile(path.join(bundle, '.env.example'), '# Optional: copy to .env and supply one key for a fresh run.\nMUSE_API_KEY=\nOPENAI_API_KEY=\nGEMINI_API_KEY=\nANTHROPIC_API_KEY=\nAI3D_API_KEY=\n');
  const archive = path.join(target, 'wompar-demo.tar.gz');
  const tar = spawnSync('tar', ['-czf', archive, '-C', temp, 'wompar-demo'], {
    encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (tar.status !== 0) throw new Error(`Could not package the WOMPar demo: ${tar.stderr || tar.error?.message || 'tar failed'}`);

  // Run the real offline path with an empty environment and no network or provider calls.
  const { dir } = await runDemo({ provider: 'offline', output: path.join(temp, 'report'), timeoutSeconds: 600, maxReservationUsd: 2 },
    { env: {}, log: () => {} });
  await copyFile(path.join(dir, 'report.html'), path.join(target, 'offline.html'));
  await copyFile(path.join(dir, 'results.json'), path.join(target, 'results.json'));
  console.log('Built the public WOMPar offline report and standalone download.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
