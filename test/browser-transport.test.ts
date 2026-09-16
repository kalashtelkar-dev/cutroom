/**
 * The browser transport, against a fake `fetch`.
 *
 * One thing is being pinned here and it is the thing that had never run: an
 * operation is a JOB and a job has no stream. Measured against the live API
 * while writing this:
 *
 *     GET /v1/jobs/{id}/stream   404, the Next.js not-found page
 *     GET /v1/runs/{jobId}/stream  404 {"code":"invalid_request",
 *                                       "message":"no run \"...\""}
 *     GET /v1/jobs/{id}            200, with status, progress and result
 *
 * Every card in play ran a published pipeline, which is a RUN and does have a
 * stream, so the operation branch of this file had never been exercised by
 * anything. The moment a card ran an operation instead it asked for the stream
 * of a run that does not exist, got a 404, and left a job on the queue with
 * nothing reading it.
 *
 * The polled path therefore has to produce the SAME events the streamed one
 * does, through the same parser, or the two would come to disagree about what
 * "done" means. That is what these assert: `parseSse` and `readJobEvent`, the
 * real ones, over what the poller yields.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { browserTransport } from '../lib/executor/browserTransport.ts';
import { readJobEvent } from '../lib/executor/executor.ts';
import { parseSse } from '../lib/executor/sse.ts';
import type { Step } from '../lib/intel/types.ts';

/** The pace only exists so this file is not asleep for two real seconds. */
const FAST = { firstMs: 1, maxMs: 1 };

interface Call { url: string; init?: RequestInit }

/** A `fetch` that answers from a script, and records what it was asked. */
function fakeFetch(routes: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const cursors: Record<string, number> = {};
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response('no route', { status: 404 });
    const queue = routes[key];
    const at = Math.min(cursors[key] ?? 0, queue.length - 1);
    cursors[key] = at + 1;
    return Response.json(queue[at]);
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const withFetch = async <T>(f: typeof globalThis.fetch, body: () => Promise<T>): Promise<T> => {
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await body();
  } finally {
    globalThis.fetch = real;
  }
};

const subtitleStep: Step = {
  kind: 'operation', engine: 'whisperx', operation: 'subtitle',
  params: { input: 'input/a.mp4' },
};

/** Read a source the way the executor does: parse, then interpret. */
async function updates(source: Awaited<ReturnType<ReturnType<typeof browserTransport>['streamRun']>>) {
  const out = [];
  for await (const frame of parseSse(source)) {
    const update = readJobEvent(frame);
    if (update) out.push(update);
  }
  return out;
}

describe('an operation is polled, because a job has no stream', () => {
  test('the poll walks queued to done and carries the result through', async () => {
    const { fetch, calls } = fakeFetch({
      '/api/ops/': [{ id: 'job_1', status: 'queued' }],
      '/api/jobs/job_1': [
        { id: 'job_1', status: 'queued', progress: 0 },
        { id: 'job_1', status: 'running', progress: 40 },
        {
          id: 'job_1',
          status: 'succeeded',
          progress: 100,
          result: {
            language: 'hi',
            segments: [{ start: 0.2, end: 4.4, text: 'नमस्ते' }],
            outputs: [{ key: 'output/job_1/transcript.json', bytes: 1812 }],
          },
        },
      ],
    });

    const seen = await withFetch(fetch, async () => {
      const t = browserTransport(FAST);
      const started = await t.startRun({
        stepId: 's0', step: subtitleStep, input: { input: 'input/a.mp4' }, tier: 'any', attempt: 1,
        idempotencyKey: 'k',
      });
      assert.equal(started.jobId, 'job_1');
      return updates(await t.streamRun('job_1'));
    });

    assert.deepEqual(seen.map((u) => u.phase), ['queued', 'running', 'done']);

    const done = seen.at(-1)!;
    assert.deepEqual(done.result?.segments, [{ start: 0.2, end: 4.4, text: 'नमस्ते' }]);
    assert.deepEqual(done.outputs, [{ key: 'output/job_1/transcript.json', bytes: 1812 }]);

    // the jobs endpoint, never the runs one: asking the wrong one answers 404
    assert.ok(calls.some((c) => c.url.includes('/api/jobs/job_1')));
    assert.ok(!calls.some((c) => c.url.includes('/api/runs/')), 'a job is not a run');
  });

  test('a percentage is read as a percentage', async () => {
    // The job's `progress` is 0-100 and `readJobEvent` reads `progress` as a
    // FRACTION and `pct` as a percentage. Under the wrong name, 40% clamps to
    // 100 and the bar is full for the whole run.
    const { fetch } = fakeFetch({
      '/api/ops/': [{ id: 'job_2', status: 'queued' }],
      '/api/jobs/job_2': [
        { status: 'running', progress: 40 },
        { status: 'succeeded', progress: 100, result: {} },
      ],
    });
    const seen = await withFetch(fetch, async () => {
      const t = browserTransport(FAST);
      await t.startRun({
        stepId: 's0', step: subtitleStep, input: {}, tier: 'any', attempt: 1, idempotencyKey: 'k',
      });
      return updates(await t.streamRun('job_2'));
    });
    assert.equal(seen[0].pct, 40);
  });

  test('a failed job reports its reason, not "the job failed"', async () => {
    const { fetch } = fakeFetch({
      '/api/ops/': [{ id: 'job_3', status: 'queued' }],
      '/api/jobs/job_3': [{
        status: 'failed',
        error: { code: 'internal_error', message: 'no connection named "x"' },
      }],
    });
    const seen = await withFetch(fetch, async () => {
      const t = browserTransport(FAST);
      await t.startRun({
        stepId: 's0', step: subtitleStep, input: {}, tier: 'any', attempt: 1, idempotencyKey: 'k',
      });
      return updates(await t.streamRun('job_3'));
    });
    assert.equal(seen.at(-1)?.phase, 'failed');
    assert.match(String(seen.at(-1)?.error?.message), /no connection named/);
  });

  test('a job that cannot be read ends the stream rather than hanging on it', async () => {
    const { fetch } = fakeFetch({
      '/api/ops/': [{ id: 'job_4', status: 'queued' }],
      // no /api/jobs route at all, so the fake answers 404
    });
    const seen = await withFetch(fetch, async () => {
      const t = browserTransport(FAST);
      await t.startRun({
        stepId: 's0', step: subtitleStep, input: {}, tier: 'any', attempt: 1, idempotencyKey: 'k',
      });
      return updates(await t.streamRun('job_4'));
    });
    assert.equal(seen.at(-1)?.phase, 'failed');
  });
});

describe('a pipeline is still streamed', () => {
  test('a run id nothing started as a job goes to the run stream', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"status":"succeeded","result":{}}\n\n'));
        c.close();
      },
    });
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof globalThis.fetch;

    const seen = await withFetch(fetch, async () => updates(await browserTransport().streamRun('run_1')));
    assert.deepEqual(seen.map((u) => u.phase), ['done']);
    assert.ok(calls[0].includes('/api/runs/run_1/stream'));
  });
});
