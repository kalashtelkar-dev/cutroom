/**
 * The real export transport.
 *
 * Server only: it holds the API key by way of `lib/editor-api/client.ts`,
 * which throws if it is ever imported into a browser bundle.
 */
import {
  validateGraph, importPipeline, getPipeline, savePipeline,
  publishPipeline, runPipeline, getRun, signOutputs,
} from '../editor-api/client.ts';
import type { ExportTransport } from './types.ts';
import { presignUpload } from '../editor-api/uploads.ts';

export function serverTransport(): ExportTransport {
  return {
    validate: async (graph) => {
      const r = await validateGraph(graph);
      return { compiles: r.compiles, errors: r.errors ?? [], unfinished: r.unfinished ?? [] };
    },

    importPipeline: async (name, graph) => (await importPipeline(name, graph)).id,

    head: async (id) => {
      const p = await getPipeline(id);
      return { id: p.id, etag: p.etag, version: p.version, published: p.published };
    },

    replace: async (id, graph, etag) => {
      const r = await savePipeline(id, graph, etag);
      return { compiles: r.compiles, errors: r.errors ?? [] };
    },

    publish: async (id) => { await publishPipeline(id); },

    start: async (id, inputs) => {
      const r = await runPipeline(id, inputs);
      // `runId`, not `id`. Reading the wrong one leaves a string that looks
      // like a run id until it 404s on the first poll.
      const runId = r.runId ?? r.id;
      if (!runId) throw new Error(`the run started and returned no run id: ${JSON.stringify(r).slice(0, 200)}`);
      return runId;
    },

    poll: async (runId) => {
      const r = await getRun(runId) as {
        runId?: string; status?: string; output?: Record<string, string> | null;
        error?: unknown;
        steps?: {
          step: string; status: string; engine?: string; operation?: string;
          startedAt?: string | null; finishedAt?: string | null;
        }[];
        timings?: { runMs?: number };
      };
      return {
        runId: r.runId ?? runId,
        status: r.status ?? 'unknown',
        output: r.output ?? null,
        error: r.error,
        steps: r.steps,
        timings: r.timings,
      };
    },

    sign: async (keys) => (await signOutputs(keys)).urls ?? {},

    /**
     * The caption file, on its way to being burned in.
     *
     * `presignUpload` takes the filename and nothing else, and the URL it
     * returns signs `host` alone, so the PUT carries no headers: a
     * Content-Type here is the classic way to turn a valid presigned URL
     * into a signature mismatch.
     */
    uploadText: async (filename, text) => {
      const presigned = await presignUpload(filename);
      const put = await fetch(presigned.url, { method: 'PUT', body: text });
      if (!put.ok) throw new Error(`the caption file would not upload: ${put.status}`);
      return presigned.key;
    },

    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
