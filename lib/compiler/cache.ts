/**
 * Content addressing for compiled segments.
 *
 * A cache key answers one question: "have we already built this exact byte
 * sequence?". So it hashes exactly the three things that decide the bytes:
 * the source it was built from, the operation, and the parameters. Nothing
 * else. A clip id, a track id, a revision number or a timestamp in the key
 * would make every re-compile a cache miss, which is the failure mode this
 * whole mechanism exists to prevent: without it, nudging one cut at the end
 * of a twenty minute timeline re-renders the other nineteen minutes.
 *
 * The consequence to keep in mind is the one that makes the key useful:
 * **two clips trimmed identically from the same media have the same key**,
 * and therefore one job and one file between them. That is a feature, and it
 * is why the compiler deduplicates nodes by key inside a single compile as
 * well as across compiles.
 */
import { createHash } from 'node:crypto';

/**
 * Canonical form: object keys sorted at every depth, `undefined` dropped.
 *
 * Sorting matters because `{a, b}` and `{b, a}` are the same params and must
 * not hash differently. Dropping `undefined` matters because an optional
 * param left unset and one set to `undefined` are the same request, and
 * `JSON.stringify` already erases it from an object but turns it into `null`
 * inside an array. Array order is preserved on purpose: concat inputs are a
 * sequence, and reordering them changes the output.
 */
export function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (src[k] === undefined) continue;
      out[k] = canonicalise(src[k]);
    }
    return out;
  }
  // -0 and 0 are the same number of seconds; they must not be two keys
  if (typeof value === 'number' && Object.is(value, -0)) return 0;
  return value;
}

/** The exact bytes that get hashed. Exported so a test can read the input. */
export function cachePayload(
  sourceKey: string,
  operation: string,
  params: Record<string, unknown> = {},
): string {
  return JSON.stringify([sourceKey, operation, canonicalise(params)]);
}

/**
 * The key for one built artefact.
 *
 * 16 hex characters is 64 bits. At the scale a single account edits video
 * (millions of segments, not billions) a collision is far less likely than
 * the storage losing the file, and a short key stays readable in a node id,
 * a log line and a bucket path.
 */
export function cacheKey(
  sourceKey: string,
  operation: string,
  params: Record<string, unknown> = {},
): string {
  return createHash('sha256').update(cachePayload(sourceKey, operation, params)).digest('hex').slice(0, 16);
}

/**
 * The source key of a value computed from several others, for a node that
 * takes more than one input. Order is part of it: concat(a, b) is not
 * concat(b, a).
 */
export const combineKeys = (...keys: readonly string[]): string => keys.join('+');
