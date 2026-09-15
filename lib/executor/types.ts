/**
 * The executor's event protocol.
 *
 * These events are the only thing the UI consumes. The chat renders them as
 * tool cards, the timeline applies the patches, and a reload can re-attach by
 * replaying from a persisted run id, which is why every event carries enough
 * to be understood on its own rather than as a delta.
 *
 *   plan.created → plan.validated → step.started → job.queued → job.running
 *     → step.progress → job.done → timeline.patched → run.complete
 *                                       ↘ step.failed
 */
import type { Step } from '../intel/types.ts';
import type { EditOp } from '../timeline/types.ts';

export type FailureClass =
  /** A blip. Retry the same request. */
  | 'transient'
  /** The params were wrong. Back to the repair loop, do not retry as-is. */
  | 'param'
  /** No capacity or the tier is starved. Downgrade or queue. */
  | 'resource'
  /** Nothing will help. Surface it. */
  | 'fatal';

export interface RunEvent {
  runId: string;
  seq: number;
  at: number;
}

export type ExecutorEvent = RunEvent &
  (
    | { type: 'plan.created'; steps: Step[]; cardId: string; estSeconds: number | null }
    | { type: 'plan.validated'; problems: string[]; repairs: number }
    | { type: 'step.started'; stepId: string; index: number; label: string; rung: number }
    | { type: 'job.queued'; stepId: string; jobId: string; engine: string; tier: 'cpu' | 'gpu' | 'any' }
    | { type: 'job.running'; stepId: string; jobId: string }
    /** Progress goes here and never into a result, a tool call with a result is complete. */
    | { type: 'step.progress'; stepId: string; pct: number | null; message: string }
    | { type: 'job.done'; stepId: string; jobId: string; outputs: JobOutput[]; cached: boolean }
    | { type: 'timeline.patched'; ops: EditOp[]; revision: number }
    | { type: 'step.failed'; stepId: string; failure: FailureClass; message: string; willRetry: boolean }
    | { type: 'run.complete'; ok: boolean; revision: number | null; elapsedMs: number }
  );

export interface JobOutput {
  key: string;
  bytes: number;
  /** `poster` is the auto-generated thumbnail. */
  role?: string;
  /** Presigned for an hour, no separate signing round trip needed. */
  url?: string;
}

export interface StepState {
  stepId: string;
  index: number;
  label: string;
  phase: 'pending' | 'queued' | 'running' | 'done' | 'failed';
  pct: number | null;
  message: string;
  outputs: JobOutput[];
  startedAt: number | null;
  endedAt: number | null;
  attempts: number;
}

/** The whole run, folded from its events. A reload rebuilds this from replay. */
export interface RunState {
  runId: string;
  cardId: string | null;
  steps: StepState[];
  status: 'planning' | 'running' | 'done' | 'failed';
  revision: number | null;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
}

export interface ExecutorLimits {
  /** Read from GET /v1/capacity, never queue 50 GPU jobs behind two workers. */
  maxParallelPerEngine: Record<string, number>;
  maxParallel: number;
  maxRepairRounds: number;
  maxRetriesPerStep: number;
}
