/**
 * Browser transport for the executor.
 *
 * Implements ExecutorTransport by talking to route handlers under app/api/.
 * Mutating calls (run operation, run pipeline) and SSE subscriptions go through
 * the server-side API proxy where EDITOR_API_KEY lives.
 *
 * **An operation is a job and a job has no stream.** This is the thing that
 * had never been exercised: every card in play ran a published pipeline, and
 * a pipeline is a RUN, which does have `/v1/runs/{id}/stream`. The moment a
 * card runs an operation instead, the same code asked for the stream of a run
 * that does not exist and got a 404 with a job sitting on the queue behind it.
 * Measured against the live API: `/v1/jobs/{id}/stream` is not a route, and
 * `/v1/runs/{jobId}/stream` answers `no run "..."`. So an operation is polled
 * and a pipeline is streamed, and which one a job id is comes from the step
 * that started it rather than from guessing at the id's shape.
 */

import type { ExecutorTransport, StartJobRequest, StartedJob } from './executor.ts';
import type { SseSource } from './sse.ts';

/**
 * How often a job is asked how it is getting on.
 *
 * Polling is not free and neither is latency. Whisper on a short clip is over
 * in a few seconds, so a slow poll would spend most of the run asleep; a fast
 * one on a ten minute transcode is a request a second for nothing. Start
 * quick, ease off, and cap: the first minute is responsive and the long tail
 * is quiet.
 */
const POLL_FIRST_MS = 700;
const POLL_MAX_MS = 4_000;
const POLL_GROWTH = 1.35;

/** Overridable so a test is not asleep for the length of a real backoff. */
export interface PollPace {
  firstMs?: number;
  maxMs?: number;
}

const TERMINAL = new Set(['succeeded', 'done', 'completed', 'failed', 'error', 'errored', 'cancelled', 'canceled']);

/**
 * A job's progress as if it had been streamed.
 *
 * Yields `text/event-stream` frames so `parseSse` and `readJobEvent` read a
 * polled job and a streamed run through exactly one path. Writing a second
 * reader for the polled case is how the two would come to disagree about what
 * "done" means.
 *
 * The job's `progress` is a PERCENTAGE, and `readJobEvent` reads `progress` as
 * a fraction and `pct` as a percentage. Handing it the number under the wrong
 * name turns 40% into 100%, so it goes out as `pct`.
 */
async function* pollJob(
  jobId: string,
  pace: PollPace,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const maxMs = pace.maxMs ?? POLL_MAX_MS;
  let wait = pace.firstMs ?? POLL_FIRST_MS;

  for (;;) {
    if (signal?.aborted) return;

    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { signal });
    const job = await res.json().catch(() => null);

    if (!res.ok || !job) {
      const why = job?.error?.message ?? job?.error ?? `the job could not be read, status ${res.status}`;
      yield frame({ status: 'failed', error: { message: String(why), status: res.status } });
      return;
    }

    const status = String(job.status ?? '');
    yield frame({
      status,
      pct: typeof job.progress === 'number' ? job.progress : undefined,
      // an operation's answer is its `result`, and that is where whisperx puts
      // the segments a later step binds to; `outputs` lives inside it
      result: job.result ?? undefined,
      outputs: job.result?.outputs ?? job.outputs ?? undefined,
      error: job.error ?? undefined,
    });

    if (TERMINAL.has(status.toLowerCase())) return;

    await sleep(wait, signal);
    wait = Math.min(maxMs, Math.round(wait * POLL_GROWTH));
  }
}

const frame = (payload: Record<string, unknown>): string =>
  `data: ${JSON.stringify(payload)}\n\n`;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

export function browserTransport(pace: PollPace = {}): ExecutorTransport {
  /**
   * Which job ids are jobs and which are runs.
   *
   * `streamRun` is handed an id and nothing else, and the two resources are
   * told apart by the endpoint that made them, not by anything in the id. The
   * step that started it is the only thing that knows.
   */
  const polled = new Set<string>();

  return {
    async startRun(req: StartJobRequest): Promise<StartedJob> {
      const { step, input } = req;

      if (step.kind === 'operation') {
        const engine = String(step.engine ?? '');
        const operation = String(step.operation ?? '');
        const res = await fetch(`/api/ops/${encodeURIComponent(engine)}/${encodeURIComponent(operation)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          signal: req.signal,
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data.error || `Operation ${engine}/${operation} failed with status ${res.status}`;
          throw new Error(msg);
        }

        const jobId = String(data.runId ?? data.id ?? data.jobId ?? '');
        if (!jobId) {
          throw new Error(`Operation ${engine}/${operation} started without returning a job id`);
        }
        polled.add(jobId);

        return {
          jobId,
          engine,
          outputs: Array.isArray(data.outputs) ? data.outputs : undefined,
          cached: Boolean(data.cached),
          result: data.result && typeof data.result === 'object' ? data.result : undefined,
        };
      }

      if (step.kind === 'pipeline') {
        const res = await fetch('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pipelineId: step.pipelineId, input }),
          signal: req.signal,
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data.error || `Pipeline ${step.pipelineId} failed to start: status ${res.status}`;
          throw new Error(msg);
        }

        const jobId = String(data.runId ?? data.id ?? data.jobId ?? '');
        return {
          jobId,
          engine: 'pipeline',
          outputs: Array.isArray(data.outputs) ? data.outputs : undefined,
          cached: Boolean(data.cached),
        };
      }

      throw new Error(`Unsupported step kind "${step.kind}" in browser transport`);
    },

    async streamRun(jobId: string, signal?: AbortSignal): Promise<SseSource> {
      if (polled.has(jobId)) return pollJob(jobId, pace, signal);

      const res = await fetch(`/api/runs/${encodeURIComponent(jobId)}/stream`, {
        signal,
        headers: { Accept: 'text/event-stream' },
      });

      if (!res.ok) {
        throw new Error(`Run stream for ${jobId} answered ${res.status}`);
      }

      if (!res.body) {
        throw new Error(`Run stream for ${jobId} had no body`);
      }

      return res.body;
    },

    /**
     * One output file, as text, for a `read-json` step.
     *
     * Goes through our own route so the signing, and the API key, stay on
     * the server. The browser only ever names a key.
     */
    async readOutput(key: string, signal?: AbortSignal): Promise<string> {
      const res = await fetch(`/api/outputs/read?key=${encodeURIComponent(key)}`, { signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `could not read ${key}: status ${res.status}`);
      if (typeof data.text !== 'string') throw new Error(`${key} came back with no content`);
      return data.text;
    },

    async cancel(jobId: string, signal?: AbortSignal): Promise<void> {
      try {
        await fetch(`/api/runs/${encodeURIComponent(jobId)}/cancel`, {
          method: 'POST',
          signal,
        });
      } catch {
        // Cancel is best effort
      }
    },
  };
}
