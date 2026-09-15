/**
 * Getting a pipeline back out of the account, by its id.
 *
 * There is no `GET /v1/pipelines`. Listing exists only on the MCP surface, so
 * the id IS the index: it is the only way back to a pipeline once it has been
 * published. Without this the workbench could create one in the account and
 * then never open it again, which is what it did.
 *
 * The id arrives wearing whatever it was found in: a publish that printed
 * one, the `pipelineId` in an intel card's plan, a URL someone pasted, a
 * quoted string out of a JSON blob. They are all the same id, so the
 * undressing happens here rather than in the component, where it would be
 * untestable.
 *
 * The reply shape below was read off the live API, not off the type in
 * `client.ts`:
 *
 *   GET /v1/pipelines/tpl_04LUIcgXi_yU  ->  200
 *   { id, name, description, version, published, currentVersion, etag,
 *     compiles, issues: [], graph: { nodes, edges, version } }
 *
 *   GET /v1/pipelines/tpl_does_not_exist  ->  404
 *   { error: { code, message } }
 *
 * Note `currentVersion`, which `Pipeline` in client.ts does not mention, and
 * note that the graph is nested rather than being the body. A reader that
 * assumed the body WAS the graph would hand the canvas an object with no
 * nodes and report "0 nodes" instead of "that is not a pipeline".
 */
import type { Graph } from './graph.ts';

/** The shape the ids have had so far. `tpl_sf-77VmRwbwX` is a real one. */
const KNOWN_ID = /tpl_[A-Za-z0-9_-]+/;

/** What is left of an id once the punctuation around it is taken off. */
const BARE_ID = /^[A-Za-z0-9_-]{3,200}$/;

/**
 * The pipeline id inside whatever was pasted, or null.
 *
 * Deliberately not a validator: the server is the authority on whether an id
 * exists, and refusing one here that it would have accepted means a person
 * with a valid id cannot use it. This only has to find the id in the noise.
 */
export function pipelineIdFrom(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  const known = KNOWN_ID.exec(text);
  if (known) return known[0];

  // not a shape we have seen: take the last path segment, so a URL works, and
  // strip the quotes, brackets and trailing commas a copied value carries
  const bare = text.replace(/^[\s"'`<([]+/, '').replace(/[\s"'`>)\],.;]+$/, '');
  const last = bare.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '';
  return BARE_ID.test(last) ? last : null;
}

export interface FetchedPipeline {
  id: string;
  name: string;
  description: string | null;
  published: boolean;
  compiles: boolean;
  /** How many the SERVER found. Local preflight runs separately and may differ. */
  issueCount: number;
  version: number | null;
  graph: Graph;
}

/**
 * What came back, or the reason it is not usable.
 *
 * A reply is only useful if it carries a graph with both arrays on it. An
 * empty `nodes` is a real answer for a pipeline with nothing in it, so it is
 * allowed through and left for the caller to say something about; a missing
 * `nodes` is not the same thing and is refused here.
 */
export function readPipelineReply(body: unknown): { pipeline: FetchedPipeline } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'the server sent no pipeline' };
  const b = body as Record<string, unknown>;

  const stated = b.error;
  if (typeof stated === 'string') return { error: stated };
  if (stated && typeof stated === 'object') {
    const msg = (stated as { message?: unknown }).message;
    return { error: typeof msg === 'string' ? msg : 'the server refused the id' };
  }

  const graph = b.graph as Graph | undefined;
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return { error: 'that id answered with something that is not a pipeline graph' };
  }

  const id = typeof b.id === 'string' ? b.id : '';
  if (!id) return { error: 'the pipeline came back with no id' };

  return {
    pipeline: {
      id,
      name: typeof b.name === 'string' && b.name.trim() ? b.name : id,
      description: typeof b.description === 'string' ? b.description : null,
      published: b.published === true,
      compiles: b.compiles === true,
      issueCount: Array.isArray(b.issues) ? b.issues.length : 0,
      version: typeof b.version === 'number' ? b.version : null,
      graph,
    },
  };
}
