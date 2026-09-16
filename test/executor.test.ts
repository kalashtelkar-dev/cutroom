import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SseDecoder, parseSse, type SseEvent } from '../lib/executor/sse.ts';
import { applyEvent, foldRun, initialRun } from '../lib/executor/fold.ts';
import {
  DEFAULT_LIMITS, ScheduleError, describeStep, engineCap, nextBatch, planSteps, scheduleSteps, withDefaults,
} from '../lib/executor/schedule.ts';
import { BACKOFF, classify, shouldRetry, toFailure } from '../lib/executor/retry.ts';
import {
  createExecutor, readJobEvent, resolveBindings,
  type ExecutorEventPayload, type ExecutorTransport, type StartJobRequest,
} from '../lib/executor/executor.ts';
import type { ExecutorEvent, RunState } from '../lib/executor/types.ts';
import type { Step } from '../lib/intel/types.ts';

// ── fixtures ────────────────────────────────────────────────────────────

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** `imagemagick/*` is cpu in the catalogue and `ffmpeg/*` is gpu. */
/**
 * A real-looking object key, not `$src`.
 *
 * It was `$src`, bound by nothing, for as long as the pre-flight check ran
 * over the bindings rather than over the body: `checkOperationInput` only
 * looks at ports the input actually carries, and the bindings carry no port
 * called `input`, so the check was vacuous and every step in this file posted
 * the literal text "$src" to a fake that did not care. The same vacancy on
 * the pipeline side was the false refusal that killed every subtitle run.
 */
const KEY = 'input/2026-09-16/fixture.png';

const blur = (input = KEY, extra: Record<string, unknown> = {}): Step => ({
  kind: 'operation', engine: 'imagemagick', operation: 'blur', params: { input }, ...extra,
});

/** `ffmpeg/*` is gpu in the catalogue, which is the other half of the tier rule. */
const trim = (input = KEY, extra: Record<string, unknown> = {}): Step => ({
  kind: 'operation', engine: 'ffmpeg', operation: 'trim', params: { input }, ...extra,
});

interface JobScript {
  /** Attempts (1-based) on which startRun throws. */
  failStart?: number[];
  /** Attempts on which the stream reports a failure instead of a result. */
  failStream?: number[];
  error?: unknown;
  streamError?: { status: number; message: string };
  /** Event-loop turns the job spends running, so jobs actually overlap. */
  ticks?: number;
  outputs?: { key: string; bytes: number }[];
  result?: Record<string, unknown>;
}

function fakeTransport(script: Record<string, JobScript> = {}) {
  const calls: StartJobRequest[] = [];
  const cancelled: string[] = [];
  const jobs = new Map<string, { stepId: string; engine: string; closed: boolean }>();
  const live = new Map<string, number>();
  const peak = new Map<string, number>();
  let n = 0;

  const enter = (engine: string) => {
    const c = (live.get(engine) ?? 0) + 1;
    live.set(engine, c);
    peak.set(engine, Math.max(peak.get(engine) ?? 0, c));
  };
  const leave = (jobId: string) => {
    const job = jobs.get(jobId);
    if (!job || job.closed) return;
    job.closed = true;
    live.set(job.engine, (live.get(job.engine) ?? 1) - 1);
  };
  const attemptsFor = (stepId: string) => calls.filter((c) => c.stepId === stepId).length;

  const transport: ExecutorTransport = {
    async startRun(req) {
      calls.push(req);
      const sc = script[req.stepId] ?? {};
      if (sc.failStart?.includes(attemptsFor(req.stepId))) throw sc.error;
      const jobId = `job_${++n}`;
      const engine = String(req.step.engine ?? 'local');
      jobs.set(jobId, { stepId: req.stepId, engine, closed: false });
      enter(engine);
      return { jobId, engine };
    },

    streamRun(jobId) {
      const job = jobs.get(jobId)!;
      const sc = script[job.stepId] ?? {};
      const attempt = attemptsFor(job.stepId);
      return (async function* () {
        try {
          yield 'event: job.running\ndata: {"status":"running","progress":0.1}\n\n';
          for (let i = 0; i < (sc.ticks ?? 1); i++) await tick();
          if (sc.failStream?.includes(attempt)) {
            const e = sc.streamError ?? { status: 500, message: 'the job failed' };
            yield `event: error\ndata: ${JSON.stringify({ status: 'failed', error: e })}\n\n`;
            return;
          }
          const payload = {
            status: 'done',
            outputs: sc.outputs ?? [{ key: `out/${job.stepId}.png`, bytes: 12 }],
            ...(sc.result ? { result: sc.result } : {}),
          };
          // no trailing blank line: the terminal frame arrives at EOF
          yield `data: ${JSON.stringify(payload)}`;
        } finally {
          leave(jobId);
        }
      })();
    },

    async cancel(jobId) {
      cancelled.push(jobId);
      leave(jobId);
    },
  };

  return {
    transport,
    calls,
    cancelled,
    peakFor: (engine: string) => peak.get(engine) ?? 0,
  };
}

/**
 * A transport that aborts the run once it has been asked to start far more
 * jobs than the plan has steps.
 *
 * The bug these tests pin is a scheduling loop, not a slow job: unbounded, a
 * regression hangs the whole test file instead of failing one case. The abort
 * leaves a fingerprint ("run cancelled") the assertions can name, so a test
 * that only passes because the guard fired still reads as a failure.
 */
function boundedStarts(
  fake: ReturnType<typeof fakeTransport>,
  ctrl: AbortController,
  max: number,
): ExecutorTransport {
  return {
    ...fake.transport,
    startRun(req) {
      if (fake.calls.length >= max) ctrl.abort();
      return fake.transport.startRun(req);
    },
  };
}

interface Harness {
  events: ExecutorEvent[];
  exec: ReturnType<typeof createExecutor>;
}

function harness(
  fake: ReturnType<typeof fakeTransport>,
  limits: Partial<typeof DEFAULT_LIMITS> = {},
  extra: Partial<Parameters<typeof createExecutor>[0]> = {},
): Harness {
  const events: ExecutorEvent[] = [];
  let clock = 1000;
  const exec = createExecutor({
    transport: fake.transport,
    limits,
    now: () => (clock += 1),
    rng: () => 0.5,
    sleep: async () => {}, // backoff is tested directly; the run must not wait on it
    newRunId: () => 'run_test',
    ...extra,
    emit: (e) => events.push(e),
  });
  return { events, exec };
}

const ofType = <T extends ExecutorEvent['type']>(events: ExecutorEvent[], type: T) =>
  events.filter((e) => e.type === type) as Extract<ExecutorEvent, { type: T }>[];

/** Every invariant a RunState has to hold no matter how the run ended. */
function assertCoherent(state: RunState) {
  assert.notEqual(state.status, 'planning', 'a finished run is never still planning');
  assert.ok(state.endedAt !== null, 'a finished run has an end');
  for (const s of state.steps) {
    assert.ok(!['running', 'queued'].includes(s.phase), `step ${s.stepId} left in ${s.phase}`);
    if (s.phase === 'done' || s.phase === 'failed') {
      assert.ok(s.endedAt !== null, `${s.stepId} finished without an endedAt`);
    }
    // A step rejected at validation fails having never started; anything
    // that reached `done` must have been attempted at least once.
    if (s.phase === 'done') assert.ok(s.attempts >= 1, `${s.stepId} is done having never started`);
    if (s.phase === 'pending') assert.equal(s.endedAt, null);
  }
}

// ── 1. SSE ──────────────────────────────────────────────────────────────

const STREAM =
  ': keep-alive\r\n' +
  'event: progress\r\n' +
  'id: 1\r\n' +
  'data: {"pct":10,\r\n' +
  'data:  "message":"probing"}\r\n' +
  '\r\n' +
  'data: plain\n' +
  '\n' +
  'event: done\n' +
  'data: {"status":"done"}'; // deliberately no trailing blank line

const EXPECTED: SseEvent[] = [
  { data: '{"pct":10,\n "message":"probing"}', event: 'progress', id: '1' },
  { data: 'plain', id: '1' },
  { data: '{"status":"done"}', event: 'done', id: '1' },
];

const decodeAll = (chunks: string[]): SseEvent[] => {
  const d = new SseDecoder();
  const out: SseEvent[] = [];
  for (const c of chunks) out.push(...d.push(c));
  out.push(...d.flush());
  return out;
};

describe('sse', () => {
  test('a whole stream in one chunk', () => {
    assert.deepEqual(decodeAll([STREAM]), EXPECTED);
  });

  test('an event split at EVERY byte boundary parses identically', () => {
    // The bug in every naive parser. Chopping at index 30-ish lands inside a
    // JSON payload; chopping between a \r and its \n is the nastier one,
    // because a decoder that treats the lone \r as a terminator dispatches
    // the event early with half its data and looks fine on the happy path.
    for (let i = 1; i < STREAM.length; i++) {
      const chunks = [STREAM.slice(0, i), STREAM.slice(i)];
      assert.deepEqual(decodeAll(chunks), EXPECTED, `split at ${i}`);
    }
  });

  test('a stream delivered one character at a time parses identically', () => {
    assert.deepEqual(decodeAll([...STREAM]), EXPECTED);
  });

  test('comments and blank lines never dispatch an event', () => {
    assert.deepEqual(decodeAll([': ping\n\n: ping\n\n\n']), []);
  });

  test('a field with no colon, and a data field with no value', () => {
    assert.deepEqual(decodeAll(['data\n\n']), [{ data: '' }]);
    assert.deepEqual(decodeAll(['data:\n\n']), [{ data: '' }]);
  });

  test('an event type does not leak onto the next event', () => {
    assert.deepEqual(decodeAll(['event: a\n\ndata: x\n\n']), [{ data: 'x' }]);
  });

  test('parseSse decodes bytes, including a character split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: café\n\n');
    // é is two bytes; cut between them
    const cut = bytes.length - 4;
    const source = (async function* () {
      yield bytes.slice(0, cut);
      await tick();
      yield bytes.slice(cut);
    })();
    const out: SseEvent[] = [];
    for await (const ev of parseSse(source)) out.push(ev);
    assert.deepEqual(out, [{ data: 'café' }]);
  });

  test('parseSse reads a Response-shaped source', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: one\n\ndata: t'));
        c.enqueue(new TextEncoder().encode('wo\n\n'));
        c.close();
      },
    });
    const out: SseEvent[] = [];
    for await (const ev of parseSse({ body: stream })) out.push(ev);
    assert.deepEqual(out, [{ data: 'one' }, { data: 'two' }]);
  });
});

// ── 2. fold ─────────────────────────────────────────────────────────────

const evt = (seq: number, e: ExecutorEventPayload): ExecutorEvent =>
  ({ ...e, runId: 'r', seq, at: 100 + seq }) as ExecutorEvent;

const LOG: ExecutorEvent[] = [
  evt(0, { type: 'plan.created', steps: [blur(), blur('$b')], cardId: 'colour-match', estSeconds: 12 }),
  evt(1, { type: 'plan.validated', problems: [], repairs: 0 }),
  evt(2, { type: 'step.started', stepId: 's0', index: 0, label: 'imagemagick/blur', rung: 2 }),
  evt(3, { type: 'job.queued', stepId: 's0', jobId: 'j1', engine: 'imagemagick', tier: 'cpu' }),
  evt(4, { type: 'job.running', stepId: 's0', jobId: 'j1' }),
  evt(5, { type: 'step.progress', stepId: 's0', pct: 40, message: 'blurring' }),
  evt(6, { type: 'job.done', stepId: 's0', jobId: 'j1', outputs: [{ key: 'a.png', bytes: 4 }], cached: false }),
  evt(7, { type: 'timeline.patched', ops: [], revision: 9 }),
  evt(8, { type: 'run.complete', ok: true, revision: 9, elapsedMs: 500 }),
];

describe('fold', () => {
  test('folding a log twice gives exactly the same state', () => {
    const once = foldRun(LOG);
    const twice = foldRun([...LOG, ...LOG]);
    assert.deepEqual(twice, once);
    // and re-applying the whole log onto the folded state changes nothing
    assert.deepEqual(LOG.reduce(applyEvent, once), once);
  });

  test('a duplicate seq is ignored rather than double-counted', () => {
    const start = LOG[2];
    const state = applyEvent(applyEvent(foldRun(LOG.slice(0, 2)), start), start);
    assert.equal(state.steps[0].attempts, 1, 'attempts is the counter a replay corrupts');
  });

  test('a seq below the watermark is ignored, so a replay cannot un-finish a step', () => {
    const finished = foldRun(LOG);
    const late = applyEvent(finished, evt(4, { type: 'job.running', stepId: 's0', jobId: 'j1' }));
    assert.equal(late.steps[0].phase, 'done');
    assert.deepEqual(late, finished);
  });

  test('events from another run are refused', () => {
    const s = foldRun(LOG);
    assert.deepEqual(
      applyEvent(s, { type: 'run.complete', ok: false, revision: null, elapsedMs: 1, runId: 'other', seq: 99, at: 1 }),
      s,
    );
  });

  test('every attempt counts, and a retry does not leave the step failed', () => {
    let s = foldRun(LOG.slice(0, 3));
    s = applyEvent(s, evt(3, { type: 'step.failed', stepId: 's0', failure: 'transient', message: '503', willRetry: true }));
    assert.equal(s.steps[0].phase, 'pending');
    assert.equal(s.error, null, 'a failure we are about to retry is not the run error');
    s = applyEvent(s, evt(4, { type: 'step.started', stepId: 's0', index: 0, label: 'imagemagick/blur', rung: 2 }));
    assert.equal(s.steps[0].attempts, 2);
  });

  test('plan.created seeds a row per step, and the run reaches done', () => {
    const s = foldRun(LOG);
    assert.equal(s.steps.length, 2);
    assert.equal(s.cardId, 'colour-match');
    assert.equal(s.status, 'done');
    assert.equal(s.revision, 9);
    assert.equal(s.steps[1].phase, 'pending');
    assertCoherent(s);
  });

  test('a step-scoped event for an unknown step creates its row', () => {
    const s = applyEvent(initialRun('r', 0), evt(0, {
      type: 'step.started', stepId: 's3#2.0', index: 3, label: 'ffmpeg/trim [2]', rung: 2,
    }));
    assert.equal(s.steps.length, 1);
    assert.equal(s.steps[0].label, 'ffmpeg/trim [2]');
  });
});

// ── 3. schedule ─────────────────────────────────────────────────────────

describe('schedule', () => {
  test('plan steps are sequential unless they declare otherwise', () => {
    const batches = scheduleSteps([blur(), blur('$a'), blur('$b')], { maxParallelPerEngine: { imagemagick: 4 } });
    assert.deepEqual(batches, [['s0'], ['s1'], ['s2']]);
  });

  test('independent steps run together, capped by the engine', () => {
    const steps = Array.from({ length: 6 }, () => blur(KEY, { needs: [] }));
    const batches = scheduleSteps(steps, { maxParallel: 8, maxParallelPerEngine: { imagemagick: 2 } });
    assert.deepEqual(batches, [['s0', 's1'], ['s2', 's3'], ['s4', 's5']]);
  });

  test('an engine with no capacity number degrades to sequential', () => {
    // Never fifty GPU jobs behind two workers: unknown means one.
    assert.equal(engineCap('ffmpeg', DEFAULT_LIMITS), 1);
    assert.equal(engineCap('ffmpeg', withDefaults({ maxParallelPerEngine: { ffmpeg: 0 } })), 1);
    assert.equal(engineCap('ffmpeg', withDefaults({ maxParallel: 2, maxParallelPerEngine: { ffmpeg: 50 } })), 2);
    const steps = Array.from({ length: 3 }, () => ({
      kind: 'operation', engine: 'ffmpeg', operation: 'trim', params: { input: KEY }, needs: [],
    }) as Step);
    assert.deepEqual(scheduleSteps(steps, { maxParallel: 8 }), [['s0'], ['s1'], ['s2']]);
  });

  test('the global cap wins over a generous per-engine one', () => {
    const steps = Array.from({ length: 4 }, () => blur(KEY, { needs: [] }));
    assert.deepEqual(
      scheduleSteps(steps, { maxParallel: 2, maxParallelPerEngine: { imagemagick: 10 } }),
      [['s0', 's1'], ['s2', 's3']],
    );
  });

  test('a fanout expands to one child per item and honours maxParallel', () => {
    const plan: Step[] = [
      { kind: 'fanout', over: '$items', maxParallel: 2, body: [blur('$item')] },
      blur('$joined'),
    ];
    const batches = scheduleSteps(plan, { maxParallel: 8, maxParallelPerEngine: { imagemagick: 8 } }, {
      fanoutSizes: { s0: 5 },
    });
    assert.deepEqual(batches[0], ['s0'], 'the gate resolves the list first');
    assert.deepEqual(batches.slice(1, 4), [['s0#0.0', 's0#1.0'], ['s0#2.0', 's0#3.0'], ['s0#4.0']]);
    assert.deepEqual(batches[4], ['s1'], 'the step after the fanout waits for every child');
  });

  test('a fanout over a literal list needs no runtime size', () => {
    const plan: Step[] = [{ kind: 'fanout', over: ['a', 'b'], body: [blur('$item')] }];
    assert.equal(planSteps(plan).length, 3);
  });

  test('an empty fanout completes without blocking what follows', () => {
    const plan: Step[] = [{ kind: 'fanout', over: '$items', body: [blur('$item')] }, blur('$x')];
    assert.deepEqual(scheduleSteps(plan, {}, { fanoutSizes: { s0: 0 } }), [['s0'], ['s1']]);
  });

  test('explicit needs build a real DAG, not just a chain', () => {
    const plan: Step[] = [
      blur(KEY, { id: 'probe', needs: [] }),
      blur('$a', { id: 'left', needs: ['probe'] }),
      blur('$b', { id: 'right', needs: ['probe'] }),
      blur('$c', { id: 'join', needs: ['left', 'right'] }),
    ];
    assert.deepEqual(
      scheduleSteps(plan, { maxParallel: 4, maxParallelPerEngine: { imagemagick: 4 } }),
      [['probe'], ['left', 'right'], ['join']],
    );
  });

  test('a cycle in needs is reported, not hung on', () => {
    const plan: Step[] = [blur('$a', { id: 'a', needs: ['b'] }), blur('$b', { id: 'b', needs: ['a'] })];
    assert.throws(() => scheduleSteps(plan), ScheduleError);
  });

  test('a need on a step that does not exist is reported', () => {
    assert.throws(() => scheduleSteps([blur('$a', { needs: ['nope'] })]), /not in the plan/);
  });

  test('the gate is not finished until its children are', () => {
    const plan: Step[] = [{ kind: 'fanout', over: '$i', body: [blur('$item')] }, blur('$x')];
    const all = planSteps(plan, { fanoutSizes: { s0: 2 } });
    assert.deepEqual(nextBatch(all, new Set(['s0']), withDefaults({ maxParallelPerEngine: { imagemagick: 4 } })),
      ['s0#0.0', 's0#1.0'], 's1 must not start while children are outstanding');
  });

  test('a step that has finished failing is skipped, and still blocks what needed it', () => {
    // `skip` cannot be folded into `done`: done is also what satisfies a
    // downstream `needs`, and nothing downstream of a failure may run. Left
    // out of both sets, the dead child comes back on every call, which is the
    // shape of the loop the executor used to spin in.
    const plan: Step[] = [{ kind: 'fanout', over: '$i', body: [blur('$item')] }, blur('$x')];
    const all = planSteps(plan, { fanoutSizes: { s0: 2 } });
    const limits = withDefaults({ maxParallelPerEngine: { imagemagick: 4 } });
    assert.deepEqual(nextBatch(all, new Set(['s0', 's0#0.0']), limits, new Set(['s0#1.0'])), []);
    assert.deepEqual(nextBatch(all, new Set(['s0', 's0#0.0']), limits), ['s0#1.0'], 'without skip it is handed back');
  });

  test('the tier comes from the node, not from the engine name', () => {
    // describeStep's docblock cites these. Pinning them is what fails when the
    // catalogue moves, rather than the comment quietly going stale.
    assert.equal(describeStep(blur()).tier, 'cpu', 'imagemagick/blur');
    assert.equal(describeStep(trim()).tier, 'gpu', 'ffmpeg/trim');
    assert.equal(
      describeStep({ kind: 'operation', engine: 'ffmpeg', operation: 'interpolate', params: {} }).tier,
      'any',
      'a node the catalogue has never heard of runs anywhere rather than being guessed onto a tier',
    );
  });
});

// ── 4. retry ────────────────────────────────────────────────────────────

describe('retry', () => {
  test('real HTTP statuses map to the four actions', () => {
    for (const s of [408, 429, 502, 503, 504]) assert.equal(classify({ status: s }), 'transient', String(s));
    for (const s of [400, 401, 403, 404, 409, 422]) assert.equal(classify({ status: s }), 'param', String(s));
    assert.equal(classify({ status: 507 }), 'resource');
    for (const s of [500, 501, 505]) assert.equal(classify({ status: s }), 'fatal', String(s));
  });

  test('a statusless error is read from its message', () => {
    assert.equal(classify(new Error('socket hang up')), 'transient');
    assert.equal(classify(new Error('/v1/run timed out after 30000ms')), 'transient');
    assert.equal(classify(new Error('no capacity on the gpu tier')), 'resource');
    assert.equal(classify(new Error('CUDA error: out of memory')), 'resource');
    assert.equal(classify(new Error('boom')), 'fatal');
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    assert.equal(classify(abort), 'fatal');
  });

  test('a param failure is never retried, it goes back to the repair loop', () => {
    const limits = withDefaults({ maxRetriesPerStep: 5 });
    for (const attempts of [1, 2, 3]) {
      assert.deepEqual(shouldRetry('param', attempts, limits).retry, false);
    }
  });

  test('fatal is never retried', () => {
    assert.equal(shouldRetry('fatal', 1, DEFAULT_LIMITS).retry, false);
  });

  test('transient backs off exponentially, with jitter, until the budget runs out', () => {
    const limits = withDefaults({ maxRetriesPerStep: 9 });
    const delays = [1, 2, 3].map((a) => shouldRetry('transient', a, limits, () => 0).delayMs);
    assert.deepEqual(delays, [BACKOFF.baseMs / 2, BACKOFF.baseMs, BACKOFF.baseMs * 2]);
    // jitter never doubles the delay and never collapses it to zero
    for (const a of [1, 2, 3]) {
      const lo = shouldRetry('transient', a, limits, () => 0).delayMs;
      const hi = shouldRetry('transient', a, limits, () => 1).delayMs;
      assert.ok(hi > lo && hi <= lo * 2 + 1, `attempt ${a}: ${lo}..${hi}`);
    }
    // maxRetriesPerStep counts retries, not tries: 3 retries is 4 attempts
    const budget = withDefaults({ maxRetriesPerStep: 3 });
    assert.deepEqual([1, 2, 3, 4].map((a) => shouldRetry('transient', a, budget).retry),
      [true, true, true, false]);
  });

  test('the backoff is capped', () => {
    const d = shouldRetry('transient', 40, withDefaults({ maxRetriesPerStep: 99 }), () => 1).delayMs;
    assert.equal(d, BACKOFF.capMs);
  });

  test('a resource failure retries exactly once, on a downgraded tier', () => {
    const first = shouldRetry(toFailure({ status: 507, message: 'insufficient storage' }), 1, DEFAULT_LIMITS, () => 0);
    assert.equal(first.retry, true);
    assert.equal(first.downgrade, true, 'the same tier would join the queue that just rejected us');
    assert.equal(first.delayMs, BACKOFF.resourceMs, 'the wait is jittered up from the floor, never below it');
    const second = shouldRetry('resource', 2, withDefaults({ maxRetriesPerStep: 9 }), () => 0);
    assert.equal(second.retry, false, 'no capacity twice is not a blip');
  });

  test('Retry-After is a floor the jitter never goes under', () => {
    // Jittering below the header sends back the request the server just
    // refused. The endpoint that matters is rng=0, which used to come back at
    // half of what was asked for.
    const f = toFailure({ status: 429, message: 'slow down', headers: { 'retry-after': '4' } });
    assert.equal(f.retryAfterMs, 4000);
    for (const r of [0, 0.25, 0.5, 1]) {
      const d = shouldRetry(f, 1, DEFAULT_LIMITS, () => r).delayMs;
      assert.ok(d >= 4000, `rng=${r} waited ${d}ms, less than the 4000ms the server asked for`);
      assert.ok(d <= 6000, `rng=${r} waited ${d}ms, far past what was asked`);
    }
    // and it beats the computed backoff, which at attempt 1 is 250ms
    assert.ok(shouldRetry(f, 1, DEFAULT_LIMITS, () => 0).delayMs > BACKOFF.baseMs);

    // a starved tier honours the header too, rather than the 2s default
    const busy = toFailure({ status: 507, message: 'no capacity', headers: { 'retry-after': '4' } });
    assert.ok(shouldRetry(busy, 1, DEFAULT_LIMITS, () => 0).delayMs >= 4000);
  });

  test('an absurd Retry-After is capped rather than parking the editor for an hour', () => {
    // Both branches: the resource one had no cap at all, so `Retry-After:
    // 3600` slept for an hour with a cancel button that could not reach it.
    const limits = withDefaults({ maxRetriesPerStep: 9 });
    for (const status of [429, 507]) {
      const f = toFailure({ status, message: 'come back later', headers: { 'retry-after': '3600' } });
      assert.equal(f.retryAfterMs, 3_600_000);
      const d = shouldRetry(f, 1, limits, () => 1).delayMs;
      assert.equal(d, BACKOFF.capMs, `status ${status} would have slept ${d}ms`);
    }
  });
});

// ── 5. the SSE → job-update bridge ──────────────────────────────────────

describe('job updates', () => {
  test('progress is a fraction and pct is a percentage', () => {
    assert.equal(readJobEvent({ data: '{"progress":0.25}' })?.pct, 25);
    assert.equal(readJobEvent({ data: '{"pct":25}' })?.pct, 25);
    assert.equal(readJobEvent({ data: '{"progress":2}' })?.pct, 100, 'clamped');
  });

  test('the phase comes from the event name when the payload has none', () => {
    assert.equal(readJobEvent({ event: 'job.done', data: '{}' })?.phase, 'done');
    assert.equal(readJobEvent({ event: 'x', data: '{"status":"succeeded"}' })?.phase, 'done');
  });

  test('an unreadable frame is skipped, not treated as a failure', () => {
    assert.equal(readJobEvent({ data: '' }), null);
    assert.equal(readJobEvent({ data: 'not json at all' })?.message, 'not json at all');
  });
});

describe('bindings', () => {
  test('$name and $name.field resolve; an unbound reference survives intact', () => {
    const b = { item: { text: 'hi' }, items: [1, 2] };
    assert.equal(resolveBindings('$item.text', b), 'hi');
    assert.deepEqual(resolveBindings({ a: '$items' }, b), { a: [1, 2] });
    assert.equal(resolveBindings('$missing', b), '$missing', 'the repair loop needs the name');
    assert.equal(resolveBindings('plain', b), 'plain');
  });

  /**
   * `$name?` is the difference between "detect the language" and a param
   * holding the two characters `$s`. whisperx takes an ISO code; omitting it
   * means detect, sending null means a present-but-empty answer, and sending
   * the literal text fails the schema. Only one of the three is what a card
   * writing `"language": "$spoken?"` meant.
   */
  test('an optional binding nobody set leaves no key at all', () => {
    assert.deepEqual(
      resolveBindings({ input: '$src', language: '$spoken?' }, { src: 'in/a.wav' }),
      { input: 'in/a.wav' },
    );
    assert.deepEqual(
      resolveBindings({ language: '$spoken?' }, { spoken: 'hi' }),
      { language: 'hi' },
      'and one that IS set is just a binding',
    );
  });

  test('an optional binding set to nothing is still nothing', () => {
    for (const spoken of [undefined, null, '']) {
      assert.deepEqual(
        resolveBindings({ language: '$spoken?' }, { spoken }),
        {},
        `a question skipped with ${JSON.stringify(spoken)} must not become a param`,
      );
    }
  });

  test('an optional binding drops out of a list rather than leaving a hole', () => {
    assert.deepEqual(resolveBindings(['a', '$gone?', 'b'], {}), ['a', 'b']);
  });

  test('a required binding is still left intact, so the error names it', () => {
    assert.deepEqual(resolveBindings({ input: '$src' }, {}), { input: '$src' });
  });
});

// ── 6. the executor, against a fake transport ───────────────────────────

describe('executor', () => {
  test('a clean run walks the protocol and folds to done', async () => {
    const fake = fakeTransport();
    const { exec, events } = harness(fake, { maxParallelPerEngine: { imagemagick: 2 } });
    const state = await exec.run({ cardId: 'colour-match', steps: [blur(), blur('$s0')] });

    assert.deepEqual(
      events.map((e) => e.type),
      [
        'plan.created', 'plan.validated',
        'step.started', 'job.queued', 'job.running', 'step.progress', 'job.done',
        'step.started', 'job.queued', 'job.running', 'step.progress', 'job.done',
        'run.complete',
      ],
    );
    assert.equal(state.status, 'done');
    assert.deepEqual(state.steps.map((s) => s.phase), ['done', 'done']);
    assert.deepEqual(state.steps[0].outputs, [{ key: 'out/s0.png', bytes: 12 }]);
    assertCoherent(state);
    // the state the executor returns is exactly what a reload would rebuild
    assert.deepEqual(foldRun(events), state);
  });

  test('a transient failure is retried and then succeeds', async () => {
    const fake = fakeTransport({
      s0: { failStart: [1], error: { status: 503, message: 'upstream busy' } },
    });
    const { exec, events } = harness(fake, { maxRetriesPerStep: 2 });
    const state = await exec.run({ cardId: 'c', steps: [blur()] });

    const failures = ofType(events, 'step.failed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].failure, 'transient');
    assert.equal(failures[0].willRetry, true);
    assert.equal(ofType(events, 'step.started').length, 2, 'every attempt starts the step again');
    assert.equal(fake.calls.length, 2);
    assert.notEqual(fake.calls[0].idempotencyKey, fake.calls[1].idempotencyKey,
      'a new attempt needs a new key, or the server hands back the same failed run');
    assert.equal(state.status, 'done');
    assert.equal(state.steps[0].attempts, 2);
    assert.equal(state.error, null);
    assertCoherent(state);
  });

  test('a failure reported by the run stream is retried too', async () => {
    const fake = fakeTransport({
      s0: { failStream: [1], streamError: { status: 502, message: 'bad gateway' } },
    });
    const { exec, events } = harness(fake, { maxRetriesPerStep: 2 });
    const state = await exec.run({ cardId: 'c', steps: [blur()] });
    assert.equal(ofType(events, 'step.failed')[0].failure, 'transient');
    assert.equal(state.status, 'done');
    assert.equal(state.steps[0].attempts, 2);
  });

  test('a param failure is NOT retried, and the run stops', async () => {
    const fake = fakeTransport({
      s0: { failStart: [1, 2, 3, 4], error: { status: 400, message: 'width must be a positive integer' } },
    });
    const { exec, events } = harness(fake, { maxRetriesPerStep: 5 });
    const state = await exec.run({ cardId: 'c', steps: [blur(), blur('$s0')] });

    assert.equal(fake.calls.length, 1, 'resending a wrong param produces the same wrong answer');
    const failed = ofType(events, 'step.failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].failure, 'param');
    assert.equal(failed[0].willRetry, false);
    assert.equal(state.status, 'failed');
    assert.equal(state.error, 'width must be a positive integer');
    assert.equal(state.steps[1].phase, 'pending', 'nothing downstream of a broken step runs');
    assertCoherent(state);
  });

  test('a plan that does not validate never reaches the transport', async () => {
    const fake = fakeTransport();
    const { exec, events } = harness(fake);
    const bad: Step[] = [{ kind: 'operation', engine: 'ffmpeg', operation: 'deflicker', params: {} }];
    const state = await exec.run({ cardId: 'c', steps: bad });

    assert.equal(fake.calls.length, 0);
    assert.ok(ofType(events, 'plan.validated')[0].problems[0].includes('deflicker'));
    assert.equal(ofType(events, 'step.failed')[0].failure, 'param');
    assert.equal(state.status, 'failed');
    assertCoherent(state);
  });

  test('the repair loop gets its rounds before the run gives up', async () => {
    const fake = fakeTransport();
    const rounds: number[] = [];
    const { exec, events } = harness(fake, { maxRepairRounds: 2 }, {
      repair: (_problems, _steps, round) => {
        rounds.push(round);
        return round === 1 ? [blur()] : null;
      },
    });
    const bad: Step[] = [{ kind: 'operation', engine: 'ffmpeg', operation: 'deflicker', params: {} }];
    const state = await exec.run({ cardId: 'c', steps: bad });

    assert.deepEqual(rounds, [1]);
    assert.equal(ofType(events, 'plan.validated')[0].repairs, 1);
    assert.equal(state.status, 'done');
  });

  test('concurrency is actually capped while the run is in flight', async () => {
    const fake = fakeTransport(Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`s${i}`, { ticks: 3 }]),
    ));
    const { exec } = harness(fake, { maxParallel: 8, maxParallelPerEngine: { imagemagick: 2 } });
    const steps = Array.from({ length: 6 }, () => blur(KEY, { needs: [] }));
    const state = await exec.run({ cardId: 'c', steps });

    assert.equal(fake.peakFor('imagemagick'), 2, 'never more than the engine can serve');
    assert.equal(fake.calls.length, 6);
    assert.equal(state.status, 'done');
  });

  test('an engine with no capacity number runs one at a time', async () => {
    const fake = fakeTransport(Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`s${i}`, { ticks: 2 }]),
    ));
    const { exec } = harness(fake, { maxParallel: 8 });
    const steps = Array.from({ length: 4 }, () => ({
      kind: 'operation', engine: 'ffmpeg', operation: 'trim', params: { input: KEY }, needs: [],
    }) as Step);
    await exec.run({ cardId: 'c', steps });
    assert.equal(fake.peakFor('ffmpeg'), 1);
  });

  test('a fanout runs one child per item, capped by its own maxParallel', async () => {
    const fake = fakeTransport(Object.fromEntries(
      Array.from({ length: 4 }, (_, k) => [`s0#${k}.0`, { ticks: 3 }]),
    ));
    const { exec, events } = harness(fake, { maxParallel: 8, maxParallelPerEngine: { imagemagick: 8 } });
    const plan: Step[] = [{ kind: 'fanout', over: '$items', maxParallel: 2, body: [blur('$item')] }];
    const state = await exec.run({ cardId: 'c', steps: plan, estSeconds: null }, {
      bindings: { items: ['in/a.png', 'in/b.png', 'in/c.png', 'in/d.png'] },
    });

    assert.equal(fake.calls.length, 4);
    assert.equal(fake.peakFor('imagemagick'), 2, 'the gate caps its own children');
    // each child saw its own item, which is the per-item value the graph cannot express
    assert.deepEqual(fake.calls.map((c) => c.input.input).sort(),
      ['in/a.png', 'in/b.png', 'in/c.png', 'in/d.png']);
    assert.equal(state.status, 'done');
    assert.equal(state.steps.length, 5, 'the gate plus one row per item');
    assertCoherent(state);
    assert.deepEqual(foldRun(events), state);
  });

  test('a fanout over something nothing bound is a param failure, not an empty success', async () => {
    const fake = fakeTransport();
    const { exec, events } = harness(fake);
    const plan: Step[] = [{ kind: 'fanout', over: '$missing', body: [blur('$item')] }];
    const state = await exec.run({ cardId: 'c', steps: plan });
    assert.equal(ofType(events, 'step.failed')[0].failure, 'param');
    assert.equal(state.status, 'failed');
  });

  test('a timeline-op is applied locally and patches the timeline', async () => {
    const fake = fakeTransport();
    const { exec, events } = harness(fake, {}, {
      applyLocal: () => ({ ops: [{ op: 'remove_clip', clipId: 'clp_1', ripple: true }], revision: 42 }),
    });
    const plan: Step[] = [{ kind: 'timeline-op', op: 'ripple_delete', target: '$rejected' }];
    const state = await exec.run({ cardId: 'timeline-ripple', steps: plan });

    assert.equal(fake.calls.length, 0, 'rung 1 never touches the network');
    assert.equal(ofType(events, 'timeline.patched')[0].revision, 42);
    assert.equal(state.revision, 42);
    assert.equal(state.steps[0].phase, 'done');
    assert.equal(state.status, 'done');
  });

  test('cancelling mid-run cancels the job and leaves a coherent state', async () => {
    const fake = fakeTransport({ s0: { ticks: 20 }, s1: { ticks: 20 } });
    const ctrl = new AbortController();
    const events: ExecutorEvent[] = [];
    const exec = createExecutor({
      transport: fake.transport,
      emit: (e) => {
        events.push(e);
        // abort the moment the first job is genuinely running
        if (e.type === 'job.running') ctrl.abort();
      },
      limits: { maxParallelPerEngine: { imagemagick: 2 } },
      now: () => 1,
      sleep: async () => {},
      newRunId: () => 'run_cancel',
    });

    const state = await exec.run({ cardId: 'c', steps: [blur(), blur('$s0')] }, { signal: ctrl.signal });

    assert.deepEqual(fake.cancelled, ['job_1'], 'the in-flight job is cancelled upstream');
    assert.equal(fake.calls.length, 1, 'nothing new is started after the abort');
    assert.equal(state.status, 'failed');
    assert.equal(state.error, 'run cancelled');
    assert.equal(state.steps[0].phase, 'failed');
    assert.equal(state.steps[1].phase, 'pending');
    assert.equal(ofType(events, 'run.complete')[0].ok, false);
    assertCoherent(state);
    assert.deepEqual(foldRun(events), state, 'a reload rebuilds the same cancelled run');
  });

  test('a run aborted before it starts still completes coherently', async () => {
    const fake = fakeTransport();
    const ctrl = new AbortController();
    ctrl.abort();
    const { exec } = harness(fake);
    const state = await exec.run({ cardId: 'c', steps: [blur()] }, { signal: ctrl.signal });
    assert.equal(fake.calls.length, 0);
    assert.equal(state.status, 'failed');
    assertCoherent(state);
  });

  test('a fatal failure stops the run where a sibling fanout child does not', async () => {
    const fake = fakeTransport({
      's0#1.0': { failStart: [1, 2, 3], error: { status: 500, message: 'internal' } },
      's0#0.0': { ticks: 2 },
      's0#2.0': { ticks: 2 },
    });
    const { exec } = harness(fake, { maxParallel: 8, maxParallelPerEngine: { imagemagick: 8 } });
    const plan: Step[] = [{ kind: 'fanout', over: ['in/a.png', 'in/b.png', 'in/c.png'], body: [blur('$item')] }, blur('$after')];
    const state = await exec.run({ cardId: 'c', steps: plan });

    // fatal halts the run: the step after the fanout must not run on partial results
    assert.equal(state.status, 'failed');
    assert.equal(state.steps.find((s) => s.stepId === 's1')?.phase, 'pending');
    assert.equal(state.steps.find((s) => s.stepId === 's0#1.0')?.phase, 'failed');
    // the siblings were already in flight and are allowed to finish
    assert.equal(state.steps.find((s) => s.stepId === 's0#0.0')?.phase, 'done');
    assert.equal(state.steps.find((s) => s.stepId === 's0#2.0')?.phase, 'done');
    assertCoherent(state);
  });

  test('a fanout child that fails without being fatal ends the run instead of looping forever', async () => {
    // 15 of 18 clips is what this looks like in the product: one child fails
    // with a 400, nothing marks the run stopped because a failed fanout child
    // is not fatal, and the scheduler hands the same dead child back forever.
    const ctrl = new AbortController();
    const fake = fakeTransport({
      's0#1.0': {
        failStart: [1, 2, 3, 4, 5, 6, 7, 8],
        error: { status: 400, message: 'width must be a positive integer' },
      },
    });
    const { exec, events } = harness(
      fake,
      { maxParallel: 8, maxParallelPerEngine: { imagemagick: 8 }, maxRetriesPerStep: 3 },
      { transport: boundedStarts(fake, ctrl, 12) },
    );
    const plan: Step[] = [{ kind: 'fanout', over: ['in/a.png', 'in/b.png', 'in/c.png'], body: [blur('$item')] }, blur('$after')];
    const state = await exec.run({ cardId: 'c', steps: plan }, { signal: ctrl.signal });

    assert.equal(fake.calls.length, 3, 'three children, one start each: a dead step is never rescheduled');
    assert.equal(state.error, 'width must be a positive integer',
      'the run ended on the real failure, not on the test guard');
    assert.equal(state.status, 'failed');
    const child = state.steps.find((s) => s.stepId === 's0#1.0');
    assert.equal(child?.phase, 'failed');
    assert.equal(child?.attempts, 1, 'a param failure is never resent, however often it is rescheduled');
    // the siblings are independent by construction and are allowed to finish
    assert.equal(state.steps.find((s) => s.stepId === 's0#0.0')?.phase, 'done');
    assert.equal(state.steps.find((s) => s.stepId === 's0#2.0')?.phase, 'done');
    assert.equal(state.steps.find((s) => s.stepId === 's1')?.phase, 'pending',
      'nothing downstream of a half-finished fanout runs on partial results');
    assertCoherent(state);
    assert.deepEqual(foldRun(events), state);
  });

  test('a fanout child spends its retry budget once, not once per pass through the scheduler', async () => {
    const ctrl = new AbortController();
    const fake = fakeTransport({
      's0#0.0': { failStart: [1, 2, 3, 4, 5, 6, 7, 8, 9], error: { status: 503, message: 'upstream busy' } },
    });
    const { exec } = harness(
      fake,
      { maxParallel: 8, maxParallelPerEngine: { imagemagick: 8 }, maxRetriesPerStep: 2 },
      { transport: boundedStarts(fake, ctrl, 12) },
    );
    const plan: Step[] = [{ kind: 'fanout', over: ['in/a.png', 'in/b.png'], body: [blur('$item')] }];
    const state = await exec.run({ cardId: 'c', steps: plan }, { signal: ctrl.signal });

    // Two retries on top of the first try, and then it is over. Rescheduling
    // re-enters runStep with `attempt` back at 1, so a step that comes round
    // again never runs its budget out.
    assert.equal(fake.calls.filter((c) => c.stepId === 's0#0.0').length, 3);
    assert.equal(state.steps.find((s) => s.stepId === 's0#0.0')?.attempts, 3);
    assert.equal(state.steps.find((s) => s.stepId === 's0#1.0')?.phase, 'done');
    assert.equal(state.status, 'failed');
    assertCoherent(state);
  });

  test('a dangling needs fails the plan, with a run.complete behind it', async () => {
    const fake = fakeTransport();
    const { exec, events } = harness(fake);
    const state = await exec.run({ cardId: 'c', steps: [blur(KEY, { id: 'a', needs: ['nope'] })] });

    assert.equal(fake.calls.length, 0);
    const failed = ofType(events, 'step.failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].failure, 'param', 'needs is part of the plan, so a bad one goes back to the repair loop');
    assert.equal(failed[0].stepId, 'a', 'the row carrying the bad edge is the one that gets marked');
    assert.match(failed[0].message, /not in the plan/);
    // The whole point: escaping run() leaves no run.complete, so a reload
    // folds the log to a run still 'planning' that never moves again.
    assert.equal(ofType(events, 'run.complete').length, 1);
    assert.equal(state.status, 'failed');
    assertCoherent(state);
    assert.deepEqual(foldRun(events), state);
  });

  test('a cycle in needs fails the run rather than escaping out of run()', async () => {
    const fake = fakeTransport();
    const { exec, events } = harness(fake);
    const plan: Step[] = [blur('$a', { id: 'a', needs: ['b'] }), blur('$b', { id: 'b', needs: ['a'] })];
    const state = await exec.run({ cardId: 'c', steps: plan });

    assert.equal(fake.calls.length, 0);
    assert.match(ofType(events, 'step.failed')[0].message, /loop/);
    assert.equal(ofType(events, 'run.complete')[0].ok, false);
    assert.equal(state.status, 'failed');
    assertCoherent(state);
  });

  test('a branch runs exactly one side, and only that side is scheduled', async () => {
    const cases = [
      { when: true, input: 'input/spoken.wav', ran: 's0.then.0', idle: 's0.else.0' },
      { when: false, input: 'input/silent.wav', ran: 's0.else.0', idle: 's0.then.0' },
      // an empty list is a decision, not a missing value
      { when: [] as unknown[], input: 'input/silent.wav', ran: 's0.else.0', idle: 's0.then.0' },
    ];
    for (const c of cases) {
      const fake = fakeTransport();
      const { exec } = harness(fake, { maxParallel: 4, maxParallelPerEngine: { imagemagick: 4 } });
      const plan: Step[] = [
        { kind: 'branch', when: '$hasSpeech', then: [blur('$spoken')], else: [blur('$silent')] },
      ];
      const state = await exec.run({ cardId: 'c', steps: plan }, {
        bindings: { hasSpeech: c.when, spoken: 'input/spoken.wav', silent: 'input/silent.wav' },
      });

      const label = JSON.stringify(c.when);
      assert.equal(fake.calls.length, 1, label);
      assert.equal(fake.calls[0].stepId, c.ran, label);
      assert.equal(fake.calls[0].input.input, c.input, label);
      assert.ok(!state.steps.some((s) => s.stepId === c.idle), `${label}: the side not taken is never scheduled`);
      assert.equal(state.status, 'done', label);
      assertCoherent(state);
    }
  });

  test('a branch on something nothing bound is a param failure, not a silent then', async () => {
    const fake = fakeTransport();
    const { exec, events } = harness(fake);
    const plan: Step[] = [{ kind: 'branch', when: '$hasSpeech', then: [blur('$spoken')], else: [] }];
    const state = await exec.run({ cardId: 'c', steps: plan });

    // An unbound `$name` survives as the literal string, and a non-empty
    // string is truthy: the then side used to run paid work on a condition
    // nobody ever set. The identical fanout mistake has always been refused.
    assert.equal(fake.calls.length, 0, 'an unbound condition must never spend money on a guess');
    const failed = ofType(events, 'step.failed')[0];
    assert.equal(failed.failure, 'param');
    assert.match(failed.message, /nothing bound it/);
    assert.equal(state.status, 'failed');
    assertCoherent(state);
    assert.deepEqual(foldRun(events), state);

    // a branch with no condition at all is the same silent guess wearing a
    // different hat: it used to fall through to the else side and report done
    const bare = fakeTransport();
    const h = harness(bare);
    const s = await h.exec.run({ cardId: 'c', steps: [{ kind: 'branch', then: [blur('$spoken')], else: [] }] });
    assert.equal(s.status, 'failed');
    assert.equal(bare.calls.length, 0);
    assert.match(ofType(h.events, 'step.failed')[0].message, /neither/);
  });

  test('plan.created describes the plan that ran, not the one that was rejected', async () => {
    const fake = fakeTransport();
    const { exec, events } = harness(fake, { maxRepairRounds: 2 }, { repair: () => [blur()] });
    const bad: Step[] = [
      { kind: 'operation', engine: 'ffmpeg', operation: 'deflicker', params: {} },
      { kind: 'operation', engine: 'ffmpeg', operation: 'deflicker', params: {} },
    ];
    const state = await exec.run({ cardId: 'c', steps: bad });

    const created = ofType(events, 'plan.created');
    assert.equal(created.length, 1);
    assert.equal(created[0].steps.length, 1, 'a log whose plan.created describes a plan that never ran explains nothing');
    assert.equal(state.status, 'done');
    assert.equal(state.steps.length, 1, 'a repair that shrinks the plan must not leave rows behind');
    assert.ok(!state.steps.some((s) => s.phase === 'pending'), 'no permanently pending row on a run that succeeded');
    assertCoherent(state);
    assert.deepEqual(foldRun(events), state);
  });

  /**
   * What leaves the machine is the params, and only the params.
   *
   * `stepInput` used to merge `pipelineId`, `graph`, `target` and `from` in
   * beside them, and the transport filtered those names back out on the way
   * past. That works right up until a real param is called one of them, and
   * one is: `vllm/translate` takes a required `target`, which the filter would
   * have stripped, and the job would have failed asking for the very thing the
   * card supplied.
   */
  test("a param called target is posted, not mistaken for the step's own field", async () => {
    const fake = fakeTransport();
    const { exec } = harness(fake, { maxParallel: 2, maxParallelPerEngine: { vllm: 2 } });
    const state = await exec.run({
      cardId: 'subtitle-burn',
      steps: [{
        kind: 'operation', engine: 'vllm', operation: 'translate',
        params: {
          connection: { use: 'a-connection' },
          segments: [{ start: 0, end: 1, text: 'hi' }],
          target: 'hindi',
        },
      }],
    });
    assert.equal(state.status, 'done');
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].input.target, 'hindi');
    assert.equal(fake.calls[0].input.pipelineId, undefined, 'plumbing never travels in the body');
    assert.equal(fake.calls[0].input.kind, undefined);
  });

  /**
   * The seeded bindings are not the request.
   *
   * This is the run the user actually saw fail. `selection` is bound for the
   * benefit of local timeline ops and no plan has ever asked for it; the
   * check was reading it and refusing the run over a key nothing sends.
   */
  test('a clip id in the bindings does not refuse a step that never asked for one', async () => {
    const fake = fakeTransport();
    const { exec } = harness(fake, { maxParallel: 2, maxParallelPerEngine: { whisperx: 2 } });
    const state = await exec.run(
      {
        cardId: 'subtitle-burn',
        steps: [{
          kind: 'operation', engine: 'whisperx', operation: 'subtitle',
          params: { input: '$source', language: '$spoken?' },
        }],
      },
      { bindings: { selection: 'clp_tevzon7u', playhead: 0, source: 'input/2026-09-16/a.mp4' } },
    );

    assert.equal(state.status, 'done', 'the run that used to die before it started');
    assert.equal(fake.calls[0].input.input, 'input/2026-09-16/a.mp4');
    assert.equal(fake.calls[0].input.selection, undefined, 'a binding is not a param');
    assert.equal('language' in fake.calls[0].input, false, 'nobody answered, so detect it');
  });

  test('and a clip id where the footage belongs still stops the run', async () => {
    const fake = fakeTransport();
    const { exec } = harness(fake, { maxParallel: 2, maxParallelPerEngine: { whisperx: 2 } });
    const state = await exec.run(
      {
        cardId: 'subtitle-burn',
        steps: [{
          kind: 'operation', engine: 'whisperx', operation: 'subtitle',
          params: { input: '$selection' },
        }],
      },
      { bindings: { selection: 'clp_tevzon7u' } },
    );
    assert.equal(state.status, 'failed');
    assert.equal(fake.calls.length, 0, 'nothing reaches the API');
  });

  test('a result object binds names the next step can reference', async () => {
    const fake = fakeTransport({ s0: { result: { candidates: ['in/x.png', 'in/y.png'] } } });
    const { exec } = harness(fake, { maxParallel: 4, maxParallelPerEngine: { imagemagick: 4 } });
    const plan: Step[] = [
      blur(KEY),
      { kind: 'fanout', over: '$candidates', maxParallel: 4, body: [blur('$item')] },
    ];
    const state = await exec.run({ cardId: 'c', steps: plan });
    assert.equal(fake.calls.length, 3, 'one probe plus one child per candidate');
    assert.deepEqual(fake.calls.slice(1).map((c) => c.input.input), ['in/x.png', 'in/y.png']);
    assert.equal(state.status, 'done');
  });
});
