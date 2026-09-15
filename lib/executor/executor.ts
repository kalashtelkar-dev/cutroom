/**
 * The executor.
 *
 * Everything the graph cannot do lives here: iteration, retries, per-item
 * values, cancellation. It takes a validated plan, schedules it, runs it
 * through an injected transport, and emits the event protocol, nothing
 * else. It never imports the API client, which is what keeps it testable
 * against a fake and off the network in tests, and what lets
 * `lib/editor-api/client.ts` satisfy `ExecutorTransport` later without the
 * dependency pointing the wrong way.
 *
 * Three decisions worth knowing before reading:
 *
 *  - **A step emits `step.started` once per attempt.** `attempts` in the
 *    folded state is that count. A retry that reused the first `step.started`
 *    would leave the UI showing "running" with no sign that anything went
 *    wrong for the length of the backoff.
 *  - **A local step still emits `job.done`.** `job.done` is the only event
 *    that moves a step to `done`, and a rung-1 timeline patch is as finished
 *    as a GPU render. Its job id is `local:<stepId>` so nothing tries to
 *    cancel it upstream.
 *  - **Fatal stops the run; a failed fanout child does not.** Nothing
 *    downstream of a failed step can succeed, so the run ends, except for a
 *    fanout child, whose siblings are independent by construction and whose
 *    loss is reported at the end.
 */
import type { Step } from '../intel/types.ts';
import { chooseOutput, parseOutput, type OutputFile } from './readJson.ts';
import { checkOperationInput, checkRunBody, describeProblems } from './bindingCheck.ts';
import type { EditOp } from '../timeline/types.ts';
import type { ExecutorEvent, ExecutorLimits, FailureClass, JobOutput, RunState } from './types.ts';
import { parseSse, type SseEvent, type SseSource } from './sse.ts';
import { applyEvent, initialRun, type FoldedRun } from './fold.ts';
import {
  DEFAULT_LIMITS,
  ScheduleError,
  expandBranch,
  expandFanout,
  nextBatch,
  planSteps,
  stepIdOf,
  topoOrder,
  withDefaults,
  type ScheduledStep,
  type Tier,
} from './schedule.ts';
import { messageOf, shouldRetry, toFailure } from './retry.ts';
import { validatePlan } from '../router/plan.ts';

// ── the transport ───────────────────────────────────────────────────────

export interface StartJobRequest {
  stepId: string;
  step: Step;
  /** `$name` references already resolved against what earlier steps produced. */
  input: Record<string, unknown>;
  tier: Tier;
  /** 1 on the first try. A resource failure retries on a downgraded tier. */
  attempt: number;
  /**
   * Stable per attempt, not per step: the previous attempt's run exists
   * server-side, and reusing its key would hand back the same failure.
   */
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface StartedJob {
  jobId: string;
  engine?: string;
  /** Set when the job was already complete: a cache hit needs no stream. */
  outputs?: JobOutput[];
  cached?: boolean;
  /** Top-level keys become bindings, which is how `$candidates` gets filled. */
  result?: Record<string, unknown>;
}

/** What the executor needs from the world. `client.ts` can satisfy this. */
export interface ExecutorTransport {
  startRun(req: StartJobRequest): Promise<StartedJob>;
  /** A Response, a ReadableStream or an async iterable, `parseSse` takes all three. */
  streamRun(jobId: string, signal?: AbortSignal): Promise<SseSource> | SseSource;
  cancel(jobId: string, signal?: AbortSignal): Promise<void> | void;
  /**
   * Fetch one output file as text, for a `read-json` step. Optional: an
   * executor built without it simply cannot run a plan that reads, and says
   * so, which is better than a plan silently binding nothing.
   */
  readOutput?(key: string, signal?: AbortSignal): Promise<string>;
}

export interface LocalPatch {
  ops: EditOp[];
  revision: number;
}

export interface ExecutorDeps {
  transport: ExecutorTransport;
  /** Every event, in order. The UI's only input. */
  emit?: (event: ExecutorEvent) => void;
  limits?: Partial<ExecutorLimits>;
  /** Applies a rung-1 timeline-op. Without it a plan containing one cannot run. */
  applyLocal?: (step: Step, stepId: string, bindings: Record<string, unknown>) => Promise<LocalPatch> | LocalPatch;
  /** The repair loop, which lives above the executor. Null gives up. */
  repair?: (problems: string[], steps: Step[], round: number) => Promise<Step[] | null> | Step[] | null;
  now?: () => number;
  rng?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  newRunId?: () => string;
}

export interface RunPlan {
  cardId: string;
  steps: Step[];
  estSeconds?: number | null;
}

export interface RunOptions {
  runId?: string;
  signal?: AbortSignal;
  /** Seed bindings: `$selection`, `$audio`, connection ids. */
  bindings?: Record<string, unknown>;
}

export interface Executor {
  run(plan: RunPlan, opts?: RunOptions): Promise<FoldedRun>;
}

export class CancelledError extends Error {
  constructor() {
    super('run cancelled');
    this.name = 'CancelledError';
  }
}

/** A plan-level problem. 422 so `classify()` reads it as `param`. */
export class PlanError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

class JobFailed extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'JobFailed';
    this.status = status;
  }
}

// ── reading the run stream ──────────────────────────────────────────────

export interface JobUpdate {
  phase?: 'queued' | 'running' | 'done' | 'failed';
  pct: number | null;
  message: string;
  outputs?: JobOutput[];
  cached?: boolean;
  result?: Record<string, unknown>;
  error?: { status: number | null; message: string; code?: string };
}

const PHASES: Record<string, JobUpdate['phase']> = {
  queued: 'queued', pending: 'queued', accepted: 'queued', submitted: 'queued',
  running: 'running', started: 'running', progress: 'running', in_progress: 'running',
  done: 'done', complete: 'done', completed: 'done', success: 'done', succeeded: 'done', finished: 'done',
  failed: 'failed', error: 'failed', errored: 'failed', cancelled: 'failed', canceled: 'failed',
};

function toOutputs(value: unknown): JobOutput[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const key = String(o.key ?? o.path ?? o.url ?? '');
      const bytes = Number(o.bytes ?? o.size ?? 0);
      return {
        key,
        bytes: Number.isFinite(bytes) ? bytes : 0,
        ...(typeof o.role === 'string' ? { role: o.role } : {}),
        ...(typeof o.url === 'string' ? { url: o.url } : {}),
      };
    })
    .filter((o) => o.key !== '');
}

/**
 * One SSE frame into one job update.
 *
 * Deliberately tolerant: the phase can arrive as the `event:` name or as a
 * `status` field, and progress as a fraction or a percentage. A frame we
 * cannot read is skipped rather than failing the run, an unrecognised
 * keep-alive must never look like an error.
 */
export function readJobEvent(msg: SseEvent): JobUpdate | null {
  let payload: Record<string, unknown> = {};
  if (msg.data) {
    try {
      const parsed: unknown = JSON.parse(msg.data);
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
      else payload = { message: String(parsed) };
    } catch {
      payload = { message: msg.data };
    }
  }

  const name = (msg.event ?? '').split('.').pop() ?? '';
  const status = String(payload.status ?? payload.state ?? payload.phase ?? '');
  const phase = PHASES[status.toLowerCase()] ?? PHASES[name.toLowerCase()];

  // `progress` is a fraction, `pct`/`percent` already a percentage. A
  // fraction of 1 and a percentage of 1 are unreachably different numbers;
  // the field name is the only thing that distinguishes them.
  let pct: number | null = null;
  const frac = payload.progress;
  const pc = payload.pct ?? payload.percent;
  if (typeof frac === 'number' && Number.isFinite(frac)) pct = Math.round(frac * 100);
  else if (typeof pc === 'number' && Number.isFinite(pc)) pct = Math.round(pc);
  if (pct !== null) pct = Math.max(0, Math.min(100, pct));

  const message = String(payload.message ?? payload.detail ?? payload.step ?? '');
  const outputs = toOutputs(payload.outputs ?? (payload.result as Record<string, unknown>)?.outputs ?? payload.artifacts);
  const result =
    payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
      ? (payload.result as Record<string, unknown>)
      : undefined;

  if (!phase && pct === null && !message && outputs.length === 0) return null;

  const update: JobUpdate = { phase, pct, message, outputs, ...(result ? { result } : {}) };
  if (payload.cached === true) update.cached = true;
  if (phase === 'failed') {
    const err = (payload.error ?? {}) as Record<string, unknown>;
    const s = err.status ?? payload.statusCode ?? payload.status_code;
    /**
     * "the job failed" is not a reason, and it was what the run card showed
     * while the job's own page said `input_unreachable: The specified key
     * does not exist`. The code was in the payload and nothing read it.
     *
     * A code alone is still worth saying: `input_unreachable` tells you to
     * re-import where `output_too_large` tells you to lower the delivery,
     * and either beats three words that fit every failure equally.
     */
    const code = typeof err.code === 'string' ? err.code : undefined;
    const message = typeof err.message === 'string' && err.message
      ? err.message
      : (typeof payload.message === 'string' && payload.message ? payload.message : undefined);
    update.error = {
      status: typeof s === 'number' ? s : null,
      message: code && message ? `${code}: ${message}`
        : code ?? message ?? 'the job failed and reported no reason',
      ...(code ? { code } : {}),
    };
  }
  return update;
}

// ── bindings ────────────────────────────────────────────────────────────

function readPath(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Replace `$name` and `$name.field` with what earlier steps produced.
 *
 * An unbound reference is left as the literal `$name` rather than becoming
 * `undefined`: the server's error then names the binding, and the repair
 * loop has something to fix. A silent `undefined` reads as "the param was
 * omitted", which sends the repair loop after the wrong thing.
 */
export function resolveBindings(value: unknown, bindings: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith('$') || value.length < 2) return value;
    const path = value.slice(1);
    const head = path.split('.')[0];
    return head in bindings ? readPath(bindings, path) : value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveBindings(v, bindings));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveBindings(v, bindings)]),
    );
  }
  return value;
}

function stepInput(step: Step, bindings: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...((step.params ?? {}) as Record<string, unknown>) };
  for (const k of ['input', 'pipelineId', 'graph', 'target', 'from'] as const) {
    if (step[k] !== undefined) merged[k] = step[k];
  }
  return resolveBindings(merged, bindings) as Record<string, unknown>;
}

// ── defaults ────────────────────────────────────────────────────────────

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const defaultRunId = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  const raw = uuid ? uuid.replace(/-/g, '') : Math.random().toString(36).slice(2).padEnd(12, '0');
  return `run_${raw.slice(0, 12)}`;
};

type WithoutEnvelope<T> = T extends unknown ? Omit<T, 'runId' | 'seq' | 'at'> : never;
export type ExecutorEventPayload = WithoutEnvelope<ExecutorEvent>;

interface StepResult {
  id: string;
  ok: boolean;
  failure?: FailureClass;
  cancelled?: boolean;
}

// ── the executor ────────────────────────────────────────────────────────

export function createExecutor(deps: ExecutorDeps): Executor {
  const limits = withDefaults(deps.limits);
  const now = deps.now ?? (() => Date.now());
  const rng = deps.rng ?? Math.random;
  const sleep = deps.sleep ?? defaultSleep;
  const newRunId = deps.newRunId ?? defaultRunId;
  const transport = deps.transport;

  async function run(plan: RunPlan, opts: RunOptions = {}): Promise<FoldedRun> {
    const runId = opts.runId ?? newRunId();
    const signal = opts.signal;
    let seq = 0;
    // The run starts when its first event does, not a tick earlier: a reload
    // replays the log and has only the events to go on, and `startedAt` has
    // to come out the same both ways.
    let startedAt = -1;
    let state = initialRun(runId, 0);

    const emit = (payload: ExecutorEventPayload): void => {
      const at = now();
      if (startedAt < 0) {
        startedAt = at;
        state = initialRun(runId, at);
      }
      const event = {
        ...(payload as Record<string, unknown>),
        runId,
        seq: seq++,
        at,
      } as unknown as ExecutorEvent;
      state = applyEvent(state, event);
      deps.emit?.(event);
    };

    // One abort promise per run: a fresh one per race leaks a listener on
    // every SSE frame, and a long render has thousands of them.
    let cancelSignal: Promise<never> | null = null;
    if (signal) {
      cancelSignal = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new CancelledError());
        else signal.addEventListener('abort', () => reject(new CancelledError()), { once: true });
      });
      cancelSignal.catch(() => {});
    }
    const raceCancel = <T>(p: Promise<T>): Promise<T> =>
      cancelSignal ? Promise.race([p, cancelSignal]) : p;

    // ── validate, and repair if someone is listening ──
    let steps = plan.steps;
    let repairs = 0;
    let problems = validatePlan(steps);
    while (problems.length > 0 && deps.repair && repairs < limits.maxRepairRounds) {
      const repaired = await deps.repair(problems.map((p) => p.message), steps, repairs + 1);
      if (!repaired) break;
      steps = repaired;
      repairs += 1;
      problems = validatePlan(steps);
    }
    // `plan.created` carries the steps that will actually run, so it waits for
    // the repair loop to finish rewriting them. A reload folds the log and
    // seeds one row per step from this event, so a plan emitted before repair
    // leaves rows for steps that no longer exist sitting pending forever on a
    // run that succeeded. The cost is that repair time falls outside
    // `elapsedMs`: the run's clock starts at its first event so that a replay
    // computes the same number, and there is no event before this one.
    emit({
      type: 'plan.created',
      steps,
      cardId: plan.cardId,
      estSeconds: plan.estSeconds ?? null,
    });
    emit({ type: 'plan.validated', problems: problems.map((p) => p.message), repairs });

    if (problems.length > 0) {
      // A param problem is never a retry: it goes back to whoever wrote the
      // plan. The failed step is named so the repair loop knows where to look.
      const first = problems[0];
      emit({
        type: 'step.failed',
        stepId: stepIdOf(steps[first.step] ?? steps[0], first.step),
        failure: 'param',
        message: first.message,
        willRetry: false,
      });
      emit({ type: 'run.complete', ok: false, revision: state.revision, elapsedMs: now() - startedAt });
      return state;
    }

    // ── schedule ──
    // `needs` is the one part of a plan `validatePlan` does not look at, and a
    // dangling or cyclic edge only surfaces when `topoOrder` runs. Resolving
    // the order here, inside the guard, turns that into a reported plan
    // failure: thrown from the batch loop it escapes `run()` after
    // `plan.created`, so no `run.complete` is ever emitted and the folded run
    // is stuck in 'planning' with nothing to say why.
    let all: ScheduledStep[];
    try {
      all = planSteps(steps);
      topoOrder(all);
    } catch (err) {
      const about = err instanceof ScheduleError ? err.stepId : undefined;
      emit({
        type: 'step.failed',
        stepId: about ?? (steps[0] ? stepIdOf(steps[0], 0) : 's0'),
        failure: 'param',
        message: messageOf(err),
        willRetry: false,
      });
      emit({ type: 'run.complete', ok: false, revision: state.revision, elapsedMs: now() - startedAt });
      return state;
    }
    const byId = new Map(all.map((s) => [s.id, s]));
    const bindings: Record<string, unknown> = { ...opts.bindings };
    const childBindings = new Map<string, Record<string, unknown>>();
    const done = new Set<string>();
    const failed: string[] = [];
    let stopped: 'cancelled' | 'fatal' | 'failed' | null = null;

    const insert = (nodes: ScheduledStep[]): void => {
      for (const n of nodes) {
        if (byId.has(n.id)) continue;
        all.push(n);
        byId.set(n.id, n);
      }
    };

    /** A step's own outputs, plus the result object's keys, become bindings. */
    const publish = (s: ScheduledStep, outputs: JobOutput[], result?: Record<string, unknown>): void => {
      bindings[s.id] = outputs.length === 1 ? outputs[0] : outputs;
      const as = s.step.as;
      if (typeof as === 'string' && as.length > 0) {
        bindings[as.startsWith('$') ? as.slice(1) : as] = outputs.length === 1 ? outputs[0] : outputs;
      }
      if (result) for (const [k, v] of Object.entries(result)) bindings[k] = v;
    };

    const cancelStep = async (s: ScheduledStep, jobId: string | null): Promise<StepResult> => {
      if (jobId) {
        try {
          await transport.cancel(jobId);
        } catch {
          /* the run is going away regardless */
        }
      }
      emit({
        type: 'step.failed',
        stepId: s.id,
        // The protocol has no `cancelled` class; `fatal` is the one that
        // means "stop, and do not try again", which is exactly right here.
        failure: 'fatal',
        message: 'run cancelled',
        willRetry: false,
      });
      return { id: s.id, ok: false, failure: 'fatal', cancelled: true };
    };

    const finishLocal = (s: ScheduledStep, message: string): void => {
      emit({ type: 'step.progress', stepId: s.id, pct: 100, message });
      emit({ type: 'job.done', stepId: s.id, jobId: `local:${s.id}`, outputs: [], cached: false });
    };

    async function runStep(s: ScheduledStep): Promise<StepResult> {
      let tier: Tier = s.tier;

      for (let attempt = 1; ; attempt++) {
        emit({ type: 'step.started', stepId: s.id, index: s.index, label: s.label, rung: s.rung });
        let jobId: string | null = null;

        try {
          if (signal?.aborted) throw new CancelledError();
          const bound = { ...bindings, ...(childBindings.get(s.id) ?? {}) };

          if (s.step.kind === 'fanout') {
            const over = resolveBindings(s.step.over, bound);
            if (!Array.isArray(over)) {
              throw new PlanError(
                `fanout over ${String(s.step.over)}, nothing bound it to a list, so there is nothing to iterate`,
              );
            }
            const kids = expandFanout(s, over.length);
            insert(kids);
            for (const kid of kids) {
              if (kid.itemIndex === undefined) continue;
              childBindings.set(kid.id, { item: over[kid.itemIndex], index: kid.itemIndex });
            }
            finishLocal(s, `${over.length} item${over.length === 1 ? '' : 's'}`);
            return { id: s.id, ok: true };
          }

          if (s.step.kind === 'branch') {
            const raw = s.step.when ?? s.step.cond;
            const value = resolveBindings(raw, bound);
            // `resolveBindings` leaves an unbound `$name` as the literal
            // string, and a non-empty string is truthy, so without this a
            // branch nobody bound takes `then` and spends money on a guess.
            // The fanout gate above refuses the identical mistake; a branch
            // has no business being the forgiving one.
            if (raw === undefined) {
              throw new PlanError('a branch needs a `when` or a `cond`, this one has neither');
            }
            if (typeof raw === 'string' && raw.startsWith('$') && value === raw) {
              throw new PlanError(`branch on ${raw}, nothing bound it, so there is no side to take`);
            }
            const side = value && (!Array.isArray(value) || value.length > 0) ? 'then' : 'else';
            insert(expandBranch(s, side));
            finishLocal(s, side);
            return { id: s.id, ok: true };
          }

          if (s.step.kind === 'read-json') {
            /**
             * A pipeline hands back keys, not data. This is where a plan
             * gets to look inside one of them: sign it, fetch it, parse it,
             * and bind the result so a later step can think with it.
             */
            if (!transport.readOutput) {
              throw new Error(`the executor was built without readOutput, so "${s.label}" cannot read anything`);
            }
            const from = String((s.step as { from?: unknown }).from ?? '');
            const source = resolveBindings(from, bound);
            const files: OutputFile[] = Array.isArray(source)
              ? source as OutputFile[]
              : (source && typeof source === 'object' ? [source as OutputFile] : []);
            if (!files.length) {
              throw new PlanError(`read-json from ${from}, which is not a step's outputs`);
            }

            const pick = (s.step as { pick?: unknown }).pick;
            const chosen = chooseOutput(files, typeof pick === 'string' ? pick : undefined);
            if ('error' in chosen) throw new PlanError(chosen.error);

            const text = await raceCancel(
              Promise.resolve(transport.readOutput(chosen.key, opts.signal)),
            );
            const parsed = parseOutput(text, chosen.key);
            if ('error' in parsed) throw new PlanError(parsed.error);

            // the parsed object's own keys become bindings, exactly as a
            // job result's do, so `$segments` resolves with no extra step
            publish(s, [], parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
              ? parsed.value as Record<string, unknown>
              : { value: parsed.value });
            finishLocal(s, `read ${chosen.key.split('/').pop()}`);
            return { id: s.id, ok: true };
          }

          if (s.step.kind === 'timeline-op') {
            if (!deps.applyLocal) {
              throw new Error(`the executor was built without applyLocal, so "${s.label}" cannot be applied`);
            }
            const patch = await raceCancel(Promise.resolve(deps.applyLocal(s.step, s.id, bound)));
            if (patch.ops.length > 0) {
              emit({ type: 'timeline.patched', ops: patch.ops, revision: patch.revision });
            }
            finishLocal(s, `${patch.ops.length} edit${patch.ops.length === 1 ? '' : 's'}`);
            return { id: s.id, ok: true };
          }

          /**
           * The last check before money is spent.
           *
           * Everything above is about the shape of the plan. This is about
           * the values in it, and it is the one that would have caught a
           * card posting the literal string "$program" as an object key, or
           * a clip id where the footage belonged. Both reached the API and
           * came back `input_unreachable`, which is a true answer to the
           * wrong question.
           */
          {
            const problems = s.step.kind === 'pipeline'
              ? checkRunBody(bound)
              : s.step.kind === 'operation'
                ? checkOperationInput(String(s.step.engine ?? ''), String(s.step.operation ?? ''), bound)
                : [];
            if (problems.length) throw new PlanError(describeProblems(problems));
          }

          const started = await raceCancel(
            Promise.resolve(
              transport.startRun({
                stepId: s.id,
                step: s.step,
                input: stepInput(s.step, bound),
                tier,
                attempt,
                idempotencyKey: `${runId}:${s.id}:${attempt}`,
                signal,
              }),
            ),
          );
          jobId = started.jobId;
          emit({
            type: 'job.queued',
            stepId: s.id,
            jobId,
            engine: started.engine ?? s.engine,
            tier,
          });

          let outputs: JobOutput[] | null = started.outputs ?? null;
          let cached = started.cached ?? false;
          let result = started.result;

          if (outputs === null) {
            const source = await raceCancel(Promise.resolve(transport.streamRun(jobId, signal)));
            const iterator = parseSse(source)[Symbol.asyncIterator]();
            let running = false;
            try {
              for (;;) {
                const next = await raceCancel(iterator.next());
                if (next.done) break;
                const update = readJobEvent(next.value);
                if (!update) continue;

                if (update.phase === 'running' && !running) {
                  running = true;
                  emit({ type: 'job.running', stepId: s.id, jobId });
                }
                if (update.pct !== null || update.message) {
                  emit({ type: 'step.progress', stepId: s.id, pct: update.pct, message: update.message });
                }
                if (update.phase === 'failed') {
                  throw new JobFailed(update.error?.message ?? 'the job failed', update.error?.status ?? null);
                }
                if (update.phase === 'done') {
                  outputs = update.outputs ?? [];
                  cached = update.cached ?? false;
                  result = update.result ?? result;
                  break;
                }
              }
            } finally {
              try {
                await iterator.return?.(undefined);
              } catch {
                /* already closed */
              }
            }
          }

          if (outputs === null) {
            // The stream ended without a terminal frame. Treating that as
            // success would hand the next step outputs that do not exist.
            throw new JobFailed(`the run stream for ${jobId} ended before the job reported a result`, 504);
          }

          emit({ type: 'job.done', stepId: s.id, jobId, outputs, cached });
          publish(s, outputs, result);
          return { id: s.id, ok: true };
        } catch (err) {
          if (err instanceof CancelledError || signal?.aborted) return cancelStep(s, jobId);

          const failure = toFailure(err);
          const decision = shouldRetry(failure, attempt, limits, rng);
          emit({
            type: 'step.failed',
            stepId: s.id,
            failure: failure.class,
            message: failure.message,
            willRetry: decision.retry,
          });
          if (!decision.retry) return { id: s.id, ok: false, failure: failure.class };
          if (decision.downgrade) tier = 'cpu';

          try {
            await sleep(decision.delayMs, signal);
          } catch {
            return cancelStep(s, null);
          }
        }
      }
    }

    // ── the batch loop ──
    // A step that has finished failing is `dead`, and dead is not `done`.
    // `done` satisfies a downstream `needs`, which a failed step must never
    // do, but a step in neither set is handed back by `nextBatch` on the very
    // next pass: a fanout child failing non-fatally is the case that reaches
    // here, and it used to be rescheduled forever, with `runStep` restarting
    // `attempt` at 1 each time so the retry budget never ran out either.
    // Downstream work still stalls on `subtreeDone`, which is the point.
    const dead = new Set<string>();

    while (!stopped) {
      if (signal?.aborted) {
        stopped = 'cancelled';
        break;
      }
      const batch = nextBatch(all, done, limits, dead);
      if (batch.length === 0) break;

      const results = await Promise.all(batch.map((id) => runStep(byId.get(id)!)));
      for (const r of results) {
        if (r.ok) {
          done.add(r.id);
          continue;
        }
        failed.push(r.id);
        dead.add(r.id);
        if (r.cancelled) stopped ??= 'cancelled';
        else if (r.failure === 'fatal') stopped = 'fatal';
        else if (!byId.get(r.id)?.parent) stopped ??= 'failed';
      }
    }

    emit({
      type: 'run.complete',
      ok: stopped === null && failed.length === 0,
      revision: state.revision,
      elapsedMs: now() - startedAt,
    });
    return state;
  }

  return { run };
}

export type { RunState, FoldedRun };
export { DEFAULT_LIMITS };
