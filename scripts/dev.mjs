// Run the API server (with file watching) and the Vite dev server together.
// Children are stopped when this script exits, and this script exits if its parent (npm) disappears,
// so an interrupted `npm run dev` never leaves servers running in the background.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npm', ['run', 'dev:server'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn('npm', ['run', 'dev:web'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const p of procs) {
    if (p.exitCode === null && p.pid) {
      // npm forwards signals unreliably; signal the whole child process group when possible.
      try { process.kill(-p.pid, 'SIGTERM'); } catch { p.kill('SIGTERM'); }
    }
  }
  setTimeout(() => process.exit(code), 300);
};
for (const p of procs) p.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
process.on('SIGHUP', () => stop(0));

const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    stop(0);
  }
}, 1500).unref();
