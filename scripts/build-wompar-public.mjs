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
  for (const file of files) {
    const dest = path.join(bundle, file);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(root, file), dest);
  }
  await writeFile(path.join(bundle, 'START-HERE.txt'), `WOMPar standalone demo\n\nRequires Node 22.18 or later. No installation or account is needed for the offline example.\n\n  cd wompar-demo\n  node demo/wompar/wompar.mjs --offline\n\nOpen the report path printed by the command. For a fresh model comparison, add one key to .env and run without --offline. Provider requests may incur charges. Keys remain on your computer. See demo/wompar/README.md for details.\n`);
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
