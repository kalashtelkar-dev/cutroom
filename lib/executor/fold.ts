/**
 * The run, folded from its events.
 *
 * A reload does not re-attach to a live socket and diff, it replays the
 * persisted log through these reducers and gets the same screen back. That
 * puts two requirements on every case below:
 *
 *  - **Folding the same events twice must be a no-op.** The log is replayed
 *    on every reconnect, and a reconnect usually overlaps what we already
 *    saw. `attempts` is the one counter here, and a counter is exactly what
 *    a double-fold corrupts.
 *  - **An event we have already seen is ignored, not merged.** `seq` is the
 *    watermark. SSE delivers in order, so a seq at or below the watermark is
 *    a replay rather than news; applying it again would move a finished step
 *    back to running.
 *
 * The watermark lives in the state rather than in a closure because it has to
 * survive the same round trip the state does.
 */
import type { ExecutorEvent, RunState, StepState } from './types.ts';
import { describeStep, stepIdOf } from './schedule.ts';

export type FoldedRun = RunState & {
  /** Highest `seq` folded so far. -1 before anything has been applied. */
  readonly seq: number;
};

export function initialRun(runId: string, at = 0): FoldedRun {
  return {
    runId,
    cardId: null,
    steps: [],
    status: 'planning',
    revision: null,
    startedAt: at,
    endedAt: null,
    error: null,
    seq: -1,
  };
}

const blankStep = (stepId: string, index: number): StepState => ({
  stepId,
  index,
  label: stepId,
  phase: 'pending',
  pct: null,
  message: '',
  outputs: [],
  startedAt: null,
  endedAt: null,
  attempts: 0,
});

/**
 * Patch one step, creating it if the log starts mid-run.
 *
 * A replay can begin after `plan.created` (a truncated log, a fanout child
 * that only exists once its gate ran), so every step-scoped event has to be
 * able to conjure its own row rather than dropping the update.
 */
function patchStep(
  steps: readonly StepState[],
  stepId: string,
  patch: (prev: StepState) => Partial<StepState>,
  seed?: Partial<StepState>,
): StepState[] {
  const i = steps.findIndex((s) => s.stepId === stepId);
  const prev = i === -1 ? { ...blankStep(stepId, steps.length), ...seed } : steps[i];
  const next = { ...prev, ...patch(prev) };
  if (i === -1) return [...steps, next];
  const out = [...steps];
  out[i] = next;
  return out;
}

export function applyEvent(state: RunState, ev: ExecutorEvent): FoldedRun {
  const s: FoldedRun = 'seq' in state ? (state as FoldedRun) : { ...state, seq: -1 };

  // Events from another run never belong to this state; an empty runId means
  // the state has not been claimed yet and adopts the first event's.
  if (s.runId && ev.runId && s.runId !== ev.runId) return s;
  if (ev.seq <= s.seq) return s;

  const base: FoldedRun = { ...s, seq: ev.seq, runId: s.runId || ev.runId };

  switch (ev.type) {
    case 'plan.created':
      return {
        ...base,
        cardId: ev.cardId,
        status: 'planning',
        steps: ev.steps.map((step, i) => ({
          ...blankStep(stepIdOf(step, i), i),
          label: describeStep(step).label,
        })),
      };

    case 'plan.validated':
      return ev.problems.length ? { ...base, error: ev.problems.join('; ') } : base;

    case 'step.started':
      return {
        ...base,
        status: base.status === 'planning' ? 'running' : base.status,
        steps: patchStep(
          base.steps,
          ev.stepId,
          (prev) => ({
            // Every attempt re-emits step.started, so this is the attempt
            // counter, and the seq watermark is what keeps it honest.
            attempts: prev.attempts + 1,
            index: ev.index,
            label: ev.label,
            phase: 'running',
            message: '',
            startedAt: prev.startedAt ?? ev.at,
            endedAt: null,
          }),
          { index: ev.index, label: ev.label },
        ),
      };

    case 'job.queued':
      return {
        ...base,
        steps: patchStep(base.steps, ev.stepId, () => ({
          phase: 'queued',
          message: `queued on ${ev.engine} (${ev.tier})`,
        })),
      };

    case 'job.running':
      return {
        ...base,
        steps: patchStep(base.steps, ev.stepId, () => ({ phase: 'running' })),
      };

    case 'step.progress':
      return {
        ...base,
        steps: patchStep(base.steps, ev.stepId, (prev) => ({
          phase: prev.phase === 'done' || prev.phase === 'failed' ? prev.phase : 'running',
          pct: ev.pct,
          message: ev.message,
        })),
      };

    case 'job.done':
      return {
        ...base,
        steps: patchStep(base.steps, ev.stepId, (prev) => ({
          phase: 'done',
          pct: 100,
          outputs: ev.outputs,
          endedAt: ev.at,
          message: ev.cached ? 'cached' : prev.message,
        })),
      };

    case 'timeline.patched':
      return { ...base, revision: ev.revision };

    case 'step.failed':
      return {
        ...base,
        // A retry is about to re-emit step.started, so the step goes back to
        // pending rather than parking on failed and flickering.
        steps: patchStep(base.steps, ev.stepId, () => ({
          phase: ev.willRetry ? 'pending' : 'failed',
          message: ev.message,
          endedAt: ev.willRetry ? null : ev.at,
        })),
        error: ev.willRetry ? base.error : (base.error ?? ev.message),
      };

    case 'run.complete':
      return {
        ...base,
        status: ev.ok ? 'done' : 'failed',
        revision: ev.revision ?? base.revision,
        endedAt: ev.at,
        error: ev.ok ? null : (base.error ?? 'the run did not complete'),
      };

    default:
      return base;
  }
}

export function foldRun(events: Iterable<ExecutorEvent>, seed?: RunState): FoldedRun {
  let state: FoldedRun | null = seed ? applyNothing(seed) : null;
  for (const ev of events) {
    state ??= initialRun(ev.runId, ev.at);
    state = applyEvent(state, ev);
  }
  return state ?? initialRun('', 0);
}

const applyNothing = (state: RunState): FoldedRun =>
  'seq' in state ? (state as FoldedRun) : { ...state, seq: -1 };
