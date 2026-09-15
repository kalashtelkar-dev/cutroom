/**
 * Jobs.
 *
 * Everything the application does on your behalf is a job, and every job keeps
 * a log. Importing a file, saving a project, blading a clip, running a GPU
 * pipeline: one list, one shape, one place to look when something went wrong.
 *
 * That is not uniformity for its own sake. This is an editor where a model
 * makes changes for you, and the only honest answer to "what did it just do
 * to my cut" is a record you can read afterwards. A tool that edits your work
 * without an audit trail is asking for trust it has not earned.
 *
 * A local blade produces a job too, with two log lines and a 20ms duration.
 * The cost of recording it is nothing and the alternative is a list with
 * holes in it, which is worse than no list: you cannot tell "nothing happened"
 * from "something happened and was not recorded".
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  at: number;
  level: LogLevel;
  message: string;
  /** Structured detail: params sent, keys returned, the diagnostic that fired. */
  data?: unknown;
}

/**
 * What kind of work this was.
 *
 * Kept open as a string rather than a union: the point of the list is that
 * anything can appear in it, and a closed union would mean every new feature
 * edits this file.
 */
export type JobKind =
  | 'edit'        // a timeline patch, local and instant
  | 'import'      // media coming in
  | 'save'        // a project going out
  | 'open'        // a project coming back
  | 'operation'   // one editor-api operation
  | 'pipeline'    // a published pipeline
  | 'compile'     // timeline to graph
  | 'route'       // the router choosing a tool
  | 'validate'
  | (string & {});

export interface Job {
  id: string;
  kind: JobKind;
  label: string;
  status: JobStatus;
  /** 0..1, or null when the work does not report progress. */
  progress: number | null;
  startedAt: number;
  endedAt: number | null;
  log: LogLine[];
  error: string | null;
  /** Set when the job is an executor run, so the two views are one thing. */
  runId?: string;
  /** The timeline revision this job produced, when it changed the document. */
  revision?: number;
  result?: unknown;
  /** True when log lines were dropped to stay under the cap. */
  truncated: boolean;
}

/** What a running job can do to itself. Everything else is the store's job. */
export interface JobHandle {
  readonly id: string;
  log(message: string, level?: LogLevel, data?: unknown): void;
  progress(fraction: number | null): void;
  /** Attach the executor run id, once one exists. */
  attachRun(runId: string): void;
  setRevision(revision: number): void;
}

export interface JobStoreLimits {
  /**
   * Both caps exist because a long session is unbounded and a browser tab is
   * not. A dropped line is marked rather than silently lost, so a truncated
   * log never reads as a complete one.
   */
  maxJobs: number;
  maxLogLines: number;
}

export const DEFAULT_LIMITS: JobStoreLimits = { maxJobs: 200, maxLogLines: 500 };
