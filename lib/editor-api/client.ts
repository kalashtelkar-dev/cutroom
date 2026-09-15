/**
 * The editor API, from the server only.
 *
 * The key never reaches a browser: this module throws if it is imported into
 * client code, and every call from the UI goes through a route handler under
 * `app/api/`.
 *
 * Methods are grouped by what they cost you. The read and validate calls are
 * free and safe to call in a loop; the mutating ones change the account's
 * state or spend GPU time, and are marked so nobody reaches for one by
 * accident while wiring something up.
 */
import type { Graph, Diagnostic } from './graph.ts';

if (typeof window !== 'undefined') {
  throw new Error('lib/editor-api/client.ts is server-only, call it through a route handler');
}

export class EditorApiError extends Error {
  // plain fields, not constructor parameter properties: node strips types
  // without transforming and cannot desugar one, and the proof scripts run
  // this file under `node --experimental-strip-types`
  readonly status: number;
  readonly path: string;
  readonly body: unknown;

  constructor(status: number, path: string, body: unknown, message: string) {
    super(message);
    this.name = 'EditorApiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Milliseconds. The default is generous because some reads are large. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

function config() {
  const base = process.env.EDITOR_API_URL?.replace(/\/+$/, '');
  const key = process.env.EDITOR_API_KEY;
  if (!base || !key) {
    throw new Error('EDITOR_API_URL and EDITOR_API_KEY must be set, see .env.example');
  }
  return { base, key };
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<{ data: T; res: Response }> {
  const { base, key } = config();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  if (opts.signal) opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });

  try {
    const res = await fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });

    const text = await res.text();
    let data: unknown = text;
    if (text && res.headers.get('content-type')?.includes('json')) {
      try { data = JSON.parse(text); } catch { /* keep the text */ }
    }

    if (!res.ok) {
      const err = (data as { error?: { message?: string } })?.error;
      throw new EditorApiError(res.status, path, data, err?.message ?? `${res.status} ${res.statusText} on ${path}`);
    }
    return { data: data as T, res };
  } catch (e) {
    if (e instanceof EditorApiError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new EditorApiError(0, path, null, `${path} timed out after ${opts.timeoutMs ?? 30_000}ms`);
    }
    throw new EditorApiError(0, path, null, `${path}: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

const get = async <T>(p: string, o?: RequestOptions) => (await request<T>(p, o)).data;

// ══ free: reads and validation ═════════════════════════════════════════

export interface ValidateResult {
  compiles: boolean;
  /**
   * Mistakes to correct. The server splits these from `unfinished` on purpose:
   * a wrong wire is not the same thing as a wire you have not drawn yet, and
   * a repair loop that treats them alike will keep "fixing" a graph that is
   * merely incomplete.
   *
   * This field was called `issues` here for a while, which is not what the
   * server returns. Nothing crashed; every error list simply read as empty,
   * so a graph that did not compile reported no reason. Verified against the
   * live endpoint rather than assumed.
   */
  errors: (Diagnostic & { severity?: string })[];
  unfinished: (Diagnostic & { severity?: string })[];
  /** Present when it compiles: the steps, engines and request/response schema. */
  plan?: unknown;
}

/** Both lists, for a caller that just wants to know what is wrong. */
export const allProblems = (r: ValidateResult) => [...(r.errors ?? []), ...(r.unfinished ?? [])];

/**
 * Compile a graph without storing it.
 *
 * Returns 200 whether or not the graph compiles, a graph that does not is
 * not a bad request, asking is the point. Only a body that is not a graph at
 * all is a 400, and the most common cause of that is a node missing its
 * `position`.
 */
export const validateGraph = (graph: Graph, signal?: AbortSignal) =>
  get<ValidateResult>('/v1/pipelines/validate', { method: 'POST', body: graph, signal });

export interface Pipeline {
  id: string;
  name: string;
  description: string | null;
  version: number;
  etag: string;
  published: boolean;
  compiles: boolean;
  issues: unknown[];
  graph: Graph;
}

export const getPipeline = (id: string) => get<Pipeline>(`/v1/pipelines/${encodeURIComponent(id)}`);
export const exportPipeline = (id: string) => get<unknown>(`/v1/pipelines/${encodeURIComponent(id)}/export`);

/**
 * There is no `GET /v1/pipelines`. Listing exists only on the MCP surface,
 * so anything that needs an index keeps its own.
 */
export const listPipelines = (): never => {
  throw new Error('the REST API cannot list pipelines, keep a local index, or use the MCP list_pipelines tool');
};

export const capacity = () => get<unknown>('/v1/capacity');

export interface TimelineSummary { id: string; name?: string; updatedAt?: string }
export const listTimelines = () => get<TimelineSummary[]>('/v1/timelines');
/** `doc` returns the literal OTIO document rather than a summary. */
export const getTimeline = (id: string, doc = true) =>
  get<unknown>(`/v1/timelines/${encodeURIComponent(id)}${doc ? '?doc=true' : ''}`);
export const getTimelineMedia = (id: string) => get<unknown>(`/v1/timelines/${encodeURIComponent(id)}/media`);
export const validateTimeline = (id: string) =>
  get<unknown>(`/v1/timelines/${encodeURIComponent(id)}/validate`, { method: 'POST' });
export const listRevisions = (id: string) => get<unknown>(`/v1/timelines/${encodeURIComponent(id)}/revisions`);

export const getRun = (id: string) => get<unknown>(`/v1/runs/${encodeURIComponent(id)}`);

/**
 * Subscribe to a run.
 *
 * SSE, not polling: the server pushes the run as it moves. The response is
 * returned raw so a route handler can pipe it straight to the browser without
 * buffering, which is what keeps progress live through a multi-minute render.
 */
export async function streamRun(id: string, signal?: AbortSignal): Promise<Response> {
  const { base, key } = config();
  const res = await fetch(`${base}/v1/runs/${encodeURIComponent(id)}/stream`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'text/event-stream' },
    signal,
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new EditorApiError(res.status, `/v1/runs/${id}/stream`, null, `stream failed: ${res.status}`);
  }
  return res;
}

// ══ mutating: these change state or spend money ════════════════════════
// Nothing below is called during development or tests without a reason.

/**
 * MUTATES. Replaces a pipeline's draft graph. It cannot create one.
 *
 * Two things here were wrong until they were called rather than assumed:
 *
 *  - The etag goes in the BODY. Sending it as `If-Match` answers 400, "give
 *    the etag of the version you edited", which reads like the etag is
 *    missing rather than in the wrong place.
 *  - The etag is not optional, and it is not optional for an id that does not
 *    exist either, so there is no create-by-PUT. Use `importPipeline`.
 *
 * Answers 409 when the draft moved since the etag was read.
 */
export const savePipeline = (id: string, graph: Graph, etag: string, name?: string) =>
  get<{ id: string; version: number; etag: string; draft: boolean; compiles: boolean;
        errors: Diagnostic[]; unfinished: Diagnostic[] }>(
    `/v1/pipelines/${encodeURIComponent(id)}`,
    { method: 'PUT', body: { graph, etag, ...(name ? { name } : {}) } },
  );

/**
 * MUTATES. The only way to create a pipeline.
 *
 * The body is one exported document. Each lands as a new id with an
 * unpublished version 1, so this is called once per project and
 * `savePipeline` is used for every export after that.
 */
export const importPipeline = async (name: string, graph: Graph, description: string | null = null) => {
  const r = await get<{ imported: { id: string; name: string; compiles: boolean }[];
                        rejected: { file: string; reason?: string }[] }>(
    '/v1/pipelines/import',
    { method: 'POST', body: { kind: 'editor-api/pipeline', formatVersion: 1, name, description, graph } },
  );
  const first = r.imported?.[0];
  if (!first) {
    const why = r.rejected?.[0]?.reason ?? 'no reason given';
    throw new EditorApiError(0, '/v1/pipelines/import', r, `the pipeline was rejected: ${why}`);
  }
  return first;
};

/** Turn output keys into URLs. `urls` is an object KEYED BY KEY, not an array. */
export const signOutputs = (keys: string[]) =>
  get<{ urls: Record<string, string> }>('/v1/outputs/sign', { method: 'POST', body: { keys } });

/** MUTATES. Publishes a pipeline so `POST /v1/run/{id}` can execute it. */
export const publishPipeline = (id: string) =>
  get<Pipeline>(`/v1/pipelines/${encodeURIComponent(id)}/publish`, { method: 'POST' });

/** SPENDS. Starts a run; 202 with a run id, or 200 if an idempotency key matched. */
export const runPipeline = (templateId: string, input: unknown, idempotencyKey?: string) =>
  get<{ id?: string; runId?: string }>(`/v1/run/${encodeURIComponent(templateId)}`, {
    method: 'POST',
    body: input,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    timeoutMs: 60_000,
  });

/**
 * MUTATES. Stops a run.
 *
 * DELETE on the run, not POST to a `/cancel` under it. Both were tried
 * against the live API: `/v1/runs/{id}/cancel` is not a route at all and
 * answers Next's HTML 404, while DELETE answers the API's own JSON, which is
 * how you can tell the difference between "wrong verb" and "no such run".
 */
export const cancelRun = (id: string) =>
  get<unknown>(`/v1/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** MUTATES. Creates a timeline. */
export const createTimeline = (body: unknown) =>
  get<{ id: string }>('/v1/timelines', { method: 'POST', body });

/**
 * MUTATES. Up to 500 edit operations, applied atomically as ONE revision.
 *
 * This is the AI-patch mechanism: a whole model run lands as a single
 * revision, so one undo reverses the whole run rather than its last step.
 */
export const editTimeline = (id: string, ops: unknown[], etag?: string) =>
  get<unknown>(`/v1/timelines/${encodeURIComponent(id)}/edits`, {
    method: 'POST',
    body: { ops },
    headers: etag ? { 'If-Match': etag } : {},
  });

/** MUTATES. Restoring is itself recorded, so an accidental undo is undoable. */
export const restoreRevision = (id: string, n: number) =>
  get<unknown>(`/v1/timelines/${encodeURIComponent(id)}/restore/${n}`, { method: 'POST' });

/** MUTATES. Deletes a timeline. */
export const deleteTimeline = (id: string) =>
  get<unknown>(`/v1/timelines/${encodeURIComponent(id)}`, { method: 'DELETE' });
