/**
 * Browser transport for the executor.
 *
 * Implements ExecutorTransport by talking to route handlers under app/api/.
 * Mutating calls (run operation, run pipeline) and SSE subscriptions go through
 * the server-side API proxy where EDITOR_API_KEY lives.
 */

import type { ExecutorTransport, StartJobRequest, StartedJob } from './executor.ts';
import type { SseSource } from './sse.ts';

/**
 * Keys that describe the STEP rather than the pipeline's inputs.
 *
 * `stepInput` merges these into the same object as the params, because an
 * operation wants them there. A pipeline run does not: its body is the input
 * node names and the server rejects, or worse ignores, anything else.
 */
const PLUMBING = new Set(['pipelineId', 'kind', 'graph', 'as', 'target', 'from']);

export function browserTransport(): ExecutorTransport {
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

        return {
          jobId,
          engine,
          outputs: Array.isArray(data.outputs) ? data.outputs : undefined,
          cached: Boolean(data.cached),
          result: data.result && typeof data.result === 'object' ? data.result : undefined,
        };
      }

      if (step.kind === 'pipeline') {
        /**
         * A run's body is keyed by the pipeline's own input node NAMES, and
         * by nothing else. `stepInput` hands us the step's params with the
         * plumbing merged in, so `pipelineId` and friends are sitting in the
         * same object as the real inputs; posting that whole thing sends the
         * pipeline an input called "pipelineId" that it does not have.
         */
        const inputs = Object.fromEntries(
          Object.entries(input).filter(([k, v]) => !PLUMBING.has(k) && v !== undefined && v !== null),
        );

        const res = await fetch('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pipelineId: step.pipelineId, input: inputs }),
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
