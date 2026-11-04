// Where runs live: <dir>/<task>/<run>/results.json, with the files of each run (reports, overlays, sheets)
// beside it. The task and run ids are checked wherever they come from, because they end up in a path.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RunFile } from '../core/types.ts';
import { writeFileAtomic } from './util.ts';

const TASK_ID = /^[a-z][a-z0-9-]*$/;
const RUN_ID = /^[0-9][0-9-]*$/;

export const isTaskId = (id: string) => TASK_ID.test(id);
export const isRunId = (id: string) => RUN_ID.test(id);

export class RunStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  runDir(taskId: string, id: string): string {
    if (!isTaskId(taskId) || !isRunId(id)) throw new Error('invalid task or run id');
    return path.join(this.dir, taskId, id);
  }

  /** Ids of the runs of a task that have a results.json, newest first. */
  ids(taskId: string): string[] {
    if (!isTaskId(taskId)) return [];
    const base = path.join(this.dir, taskId);
    if (!existsSync(base)) return [];
    return readdirSync(base).filter((id) => isRunId(id) && existsSync(path.join(base, id, 'results.json'))).sort().reverse();
  }

  /** Task ids that have runs on disk. */
  taskIds(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((id) => isTaskId(id) && this.ids(id).length > 0);
  }

  /** results.json as written, whatever its format. */
  raw(taskId: string, id: string): unknown | null {
    const file = path.join(this.runDir(taskId, id), 'results.json');
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  async write(run: RunFile): Promise<string> {
    const dir = this.runDir(run.task.id, run.id);
    await writeFileAtomic(path.join(dir, 'results.json'), JSON.stringify(run, null, 1));
    return dir;
  }

  /** A path inside a run's folder, or null if `rel` would leave it. */
  resolve(taskId: string, id: string, rel: string): string | null {
    if (!isTaskId(taskId) || !isRunId(id) || rel.includes('\0')) return null;
    const base = this.runDir(taskId, id);
    const full = path.resolve(base, rel);
    return full.startsWith(base + path.sep) ? full : null;
  }

  /** Store a file in a run's folder. Returns `rel`. */
  async writeFile(taskId: string, id: string, rel: string, data: string | Buffer): Promise<string> {
    const full = this.resolve(taskId, id, rel);
    if (!full) throw new Error(`the path ${rel} leaves the run's folder`);
    await writeFileAtomic(full, data);
    return rel;
  }
}
