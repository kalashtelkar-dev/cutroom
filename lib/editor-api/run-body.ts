/**
 * Checking a run body against the pipeline it is for.
 *
 * `POST /v1/run/{id}` takes one object keyed by the pipeline's input node
 * NAMES. Send a key it does not have and the answer is "the request body
 * does not match this pipeline", which is true and says nothing about which
 * key, or what the right ones were.
 *
 * That message cost a real run: a card bound `{input: "<key>"}` to a
 * pipeline whose only input node is called `video`. Reading the pipeline
 * first is free, so there is no reason for anyone to learn this from a
 * failed run rather than from a sentence.
 */

export interface InputNode {
  kind?: string;
  name?: string;
  required?: boolean;
}

export interface InputContract {
  required: string[];
  optional: string[];
}

/** The names a run body may be keyed by, from a pipeline's graph. */
export function inputContract(nodes: readonly InputNode[] | undefined): InputContract {
  const inputs = (nodes ?? []).filter((n) => n.kind === 'input' && typeof n.name === 'string');
  return {
    // the server treats `required` as required, and it is not optional on the
    // node itself: a missing one is a graph the server refuses outright
    required: inputs.filter((n) => n.required !== false).map((n) => String(n.name)),
    optional: inputs.filter((n) => n.required === false).map((n) => String(n.name)),
  };
}

/**
 * Why this body would be refused, or null if it would not.
 *
 * Deliberately one sentence naming both halves: what the pipeline takes, and
 * what was sent. Either alone leaves the reader guessing at the other.
 */
export function bodyMismatch(
  body: Record<string, unknown>,
  contract: InputContract,
  pipelineName?: string,
): string | null {
  const sent = Object.keys(body);
  const missing = contract.required.filter((n) => !sent.includes(n));
  const unknown = sent.filter((n) => !contract.required.includes(n) && !contract.optional.includes(n));
  if (!missing.length && !unknown.length) return null;

  const takes = contract.required.length || contract.optional.length
    ? [...contract.required, ...contract.optional.map((o) => `${o} (optional)`)].join(', ')
    : 'no inputs at all';
  const which = pipelineName ? `"${pipelineName}"` : 'this pipeline';

  const parts = [`${which} takes ${takes}, and the run sent ${sent.join(', ') || 'nothing'}`];
  if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
  if (unknown.length) parts.push(`not an input: ${unknown.join(', ')}`);
  return parts.join('. ');
}
