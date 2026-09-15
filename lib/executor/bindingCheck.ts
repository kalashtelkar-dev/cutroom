/**
 * What a step is about to be sent, checked before it is sent.
 *
 * Two mistakes got all the way to the API and came back as money spent on
 * nothing, and neither is catchable by looking at the plan's shape:
 *
 *  - **A binding nothing sets.** `resolveBindings` leaves an unbound `$name`
 *    as the literal string, so a card asking for `$program` posted the seven
 *    characters "$program" as an object key. The answer is
 *    `input_unreachable: The specified key does not exist`, which is true and
 *    tells you nothing about the real mistake. The executor already refuses
 *    this for a `branch`; a file input deserves the same.
 *
 *  - **A document id where a storage key belongs.** `$selection` is a clip
 *    id, `clp_9f2a`. It resolves, it is a real string, and it is not a file.
 *    Three cards shipped sending one to an operation or a pipeline that
 *    wanted the footage.
 *
 * The right value is `$source`: the editor resolves the tool's target to an
 * object key and checks it is readable before any of this runs.
 */
import { getNode } from '../editor-api/catalogue.ts';

/** `$name` or `$name.field`, which is what an unresolved binding looks like. */
const BINDING = /^\$[A-Za-z_][\w.]*$/;

/** `clp_…`, `trk_…`, `tl_…`: ids the document uses, never storage keys. */
const DOCUMENT_ID = /^(clp|trk|tl|mk)_/;

/**
 * A storage key has a prefix and a name (`output/abc/file.mp4`), or it is a
 * url. Anything else handed to a port that opens a file is not one.
 */
const looksLikeKey = (v: string): boolean =>
  v.includes('/') || /^https?:\/\//i.test(v);

export interface BindingProblem {
  port: string;
  value: string;
  reason: string;
}

/** The ports of an operation that actually open a file. */
export function filePorts(engine: string, operation: string): string[] {
  const node = getNode(`${engine}/${operation}`);
  if (!node) return [];
  return (node.in ?? [])
    .filter((p) => (p.accepts ?? []).some((a) => String(a).startsWith('file:')))
    .map((p) => String(p.name));
}

/**
 * Why this value cannot be a file, or null if it could be.
 *
 * Deliberately not a guess about whether the file EXISTS: that is the API's
 * job and it answers it well. This is only about values that cannot possibly
 * be one, which is the class that was reaching it.
 */
export function checkFileValue(port: string, value: unknown): BindingProblem | null {
  if (typeof value !== 'string' || !value) return null;

  if (BINDING.test(value)) {
    return {
      port,
      value,
      reason: `nothing bound ${value}, so the literal text was about to be sent as a file. `
        + 'A pipeline or operation that reads footage wants $source, the key the editor has already checked.',
    };
  }
  if (DOCUMENT_ID.test(value)) {
    return {
      port,
      value,
      reason: `${value} is an id inside the document, not a file in storage. Use $source.`,
    };
  }
  if (!looksLikeKey(value)) {
    return {
      port,
      value,
      reason: `"${value}" is not an object key or a url, so there is nothing for the API to open.`,
    };
  }
  return null;
}

/** Every problem in what an operation step is about to post. */
export function checkOperationInput(
  engine: string,
  operation: string,
  input: Record<string, unknown>,
): BindingProblem[] {
  const ports = filePorts(engine, operation);
  const out: BindingProblem[] = [];
  for (const port of ports) {
    if (!(port in input)) continue;
    const problem = checkFileValue(port, input[port]);
    if (problem) out.push(problem);
  }
  return out;
}

/**
 * Every problem in what a pipeline run is about to post.
 *
 * A pipeline's input nodes are typed, but the executor does not hold its
 * graph, so every value is checked: a run body has nothing in it but inputs,
 * and none of them should ever be an unresolved binding or a document id.
 */
export function checkRunBody(input: Record<string, unknown>): BindingProblem[] {
  const out: BindingProblem[] = [];
  for (const [port, value] of Object.entries(input)) {
    const problem = checkFileValue(port, value);
    if (problem) out.push(problem);
  }
  return out;
}

/** One sentence for a run card, listing every bad port. */
export const describeProblems = (problems: readonly BindingProblem[]): string =>
  problems.map((p) => `${p.port}: ${p.reason}`).join(' ');
