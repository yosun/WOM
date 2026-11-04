// Worker thread entry for the alignment job: receives the job, reports progress lines, answers with the result or an error.
import { parentPort, workerData } from 'node:worker_threads';
import { runAlignJob, type AlignJob } from './alignJob.ts';

if (!parentPort) throw new Error('alignWorker.ts is a worker thread entry point');
const port = parentPort;
try {
  const result = await runAlignJob(workerData as AlignJob, (message) => port.postMessage({ type: 'log', message }));
  port.postMessage({ type: 'done', result });
} catch (err) {
  port.postMessage({ type: 'error', message: err instanceof Error ? `${err.message}` : String(err) });
}
