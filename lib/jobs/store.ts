/**
 * The job store.
 *
 * Deliberately free of React: it is a plain emitter, so the executor, the
 * import pipeline and the command runner can all write to it from wherever
 * they happen to run, and so it can be tested without a renderer.
 *
 * Time is injected. A store that reads the clock cannot be tested for
 * ordering or duration without sleeping, and a test that sleeps is a test
 * nobody runs.
 */
import { DEFAULT_LIMITS, type Job, type JobHandle, type JobKind, type JobStatus, type JobStoreLimits, type LogLevel } from './types.ts';

export interface JobStore {
  start(kind: JobKind, label: string): JobHandle;
  finish(id: string, status: Extract<JobStatus, 'done' | 'failed' | 'cancelled'>, detail?: { error?: string; result?: unknown }): void;
  get(id: string): Job | undefined;
  /** Newest first, which is the order anyone reads a log list in. */
  list(): Job[];
  subscribe(fn: (jobs: Job[]) => void): () => void;
  clear(): void;
  /** Jobs still in flight, for a busy indicator that is never wrong. */
  active(): Job[];
}

export interface JobStoreOptions {
  now?: () => number;
  newId?: (kind: string) => string;
  limits?: Partial<JobStoreLimits>;
}

export function createJobStore(opts: JobStoreOptions = {}): JobStore {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const now = opts.now ?? (() => Date.now());
  let seq = 0;
  const newId = opts.newId ?? ((kind: string) => `job_${kind}_${++seq}`);

  /** Newest first, so trimming the oldest is a pop and reads are a slice. */
  const jobs: Job[] = [];
  const byId = new Map<string, Job>();
  const listeners = new Set<(jobs: Job[]) => void>();

  const emit = () => {
    const snapshot = jobs.slice();
    for (const fn of listeners) fn(snapshot);
  };

  function append(job: Job, level: LogLevel, message: string, data?: unknown): void {
    if (job.log.length >= limits.maxLogLines) {
      job.truncated = true;
      // keep the beginning, which says what was attempted, and the tail,
      // which says how it ended. The middle of a long log is the least useful
      // part of it.
      job.log.splice(Math.floor(limits.maxLogLines / 2), 1);
    }
    job.log.push({ at: now(), level, message, data });
  }

  return {
    start(kind, label) {
      const job: Job = {
        id: newId(String(kind)),
        kind,
        label,
        status: 'running',
        progress: null,
        startedAt: now(),
        endedAt: null,
        log: [],
        error: null,
        truncated: false,
      };
      jobs.unshift(job);
      byId.set(job.id, job);
      while (jobs.length > limits.maxJobs) {
        const dropped = jobs.pop();
        if (dropped) byId.delete(dropped.id);
      }
      append(job, 'info', label);
      emit();

      return {
        id: job.id,
        log(message, level = 'info', data) {
          append(job, level, message, data);
          emit();
        },
        progress(fraction) {
          job.progress = fraction === null ? null : Math.min(1, Math.max(0, fraction));
          emit();
        },
        attachRun(runId) { job.runId = runId; emit(); },
        setRevision(revision) { job.revision = revision; emit(); },
      };
    },

    finish(id, status, detail) {
      const job = byId.get(id);
      if (!job || job.endedAt !== null) return;   // finishing twice is a no-op
      job.status = status;
      job.endedAt = now();
      if (detail?.error) {
        job.error = detail.error;
        append(job, 'error', detail.error);
      }
      if (detail && 'result' in detail) job.result = detail.result;
      if (status === 'done' && job.progress !== null) job.progress = 1;
      append(job, status === 'done' ? 'info' : 'warn', `${status} in ${job.endedAt - job.startedAt}ms`);
      emit();
    },

    get: (id) => byId.get(id),
    list: () => jobs.slice(),
    active: () => jobs.filter((j) => j.endedAt === null),
    subscribe(fn) {
      listeners.add(fn);
      fn(jobs.slice());
      return () => { listeners.delete(fn); };
    },
    clear() {
      // in-flight jobs are not cleared: their handles still hold a reference
      // and would write log lines into a job nobody can see.
      for (let i = jobs.length - 1; i >= 0; i--) {
        if (jobs[i].endedAt !== null) { byId.delete(jobs[i].id); jobs.splice(i, 1); }
      }
      emit();
    },
  };
}

/**
 * Run something as a job.
 *
 * The wrapper owns the outcome so no caller can forget to record one: a throw
 * becomes a failed job with the message in the log, and a return value becomes
 * a done job. The alternative is a list where the jobs that went wrong are the
 * ones missing from it.
 */
export async function runAsJob<T>(
  store: JobStore,
  kind: JobKind,
  label: string,
  body: (job: JobHandle) => T | Promise<T>,
): Promise<{ id: string; ok: true; value: T } | { id: string; ok: false; error: Error }> {
  const handle = store.start(kind, label);
  try {
    const value = await body(handle);
    store.finish(handle.id, 'done', { result: value });
    return { id: handle.id, ok: true, value };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    store.finish(handle.id, 'failed', { error: error.message });
    return { id: handle.id, ok: false, error };
  }
}
