/**
 * What kind of failure this is, and whether trying again can help.
 *
 * The four classes are not severities, they are different *actions*:
 *
 *   transient  the same request again, after a backoff. Nothing is wrong.
 *   param      the request itself is wrong. Retrying it produces the same
 *              error and burns the user's patience, it goes back to the
 *              repair loop, which changes the params before anything reruns.
 *   resource   the work is fine, the tier is full. Retry once, on a smaller
 *              tier; a second identical attempt lands in the same queue.
 *   fatal      surface it. A retry loop on a fatal error is how a UI ends up
 *              spinning for four minutes on an error it had after 200ms.
 *
 * Statuses map exactly, because guessing from prose is how a 400 ends up
 * retried eight times: 408/429/502/503/504 transient, 507 resource, any
 * other 4xx param, everything else fatal. Message sniffing only runs when
 * there is no status at all, which is the network-level case.
 */
import type { ExecutorLimits, FailureClass } from './types.ts';

export interface Failure {
  class: FailureClass;
  /** null when the error never reached HTTP. 0 means the request never landed. */
  status: number | null;
  message: string;
  /** From a `Retry-After` header, when the server told us how long to wait. */
  retryAfterMs: number | null;
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  /** Resource failures retry on a cheaper tier; retrying the same one queues again. */
  downgrade: boolean;
  reason: string;
}

export const BACKOFF = {
  baseMs: 250,
  factor: 2,
  capMs: 30_000,
  /** Capacity does not come back in 250ms. */
  resourceMs: 2_000,
} as const;

const TRANSIENT_STATUS: ReadonlySet<number> = new Set([408, 429, 502, 503, 504]);

/** Pull an HTTP status out of whatever the transport threw. */
export function statusOf(error: unknown): number | null {
  if (typeof error === 'number') return error;
  if (!error || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;
  for (const v of [e.status, e.statusCode, (e.response as Record<string, unknown>)?.status]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function retryAfterOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;
  if (typeof e.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs)) return e.retryAfterMs;
  const headers = e.headers as Record<string, unknown> | undefined;
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'] ?? e.retryAfter;
  // The header is seconds; everything inside the executor is milliseconds.
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw * 1000;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim()) * 1000;
  return null;
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
    const nested = e.error as Record<string, unknown> | undefined;
    if (typeof nested?.message === 'string') return nested.message;
  }
  return String(error);
}

const NETWORK = /(econnreset|econnrefused|etimedout|epipe|eai_again|enotfound|socket hang up|network|fetch failed|timed out|timeout|stream closed)/i;
const CAPACITY = /(capacity|out of memory|\boom\b|cuda error|no workers|queue full|resource exhausted|insufficient storage|no gpu)/i;
const PARAM = /(invalid|missing required|unknown param|not a valid|schema|validation|unsupported|must be one of|bad request)/i;

export function classify(error: unknown): FailureClass {
  const status = statusOf(error);

  if (status !== null && status !== 0) {
    if (TRANSIENT_STATUS.has(status)) return 'transient';
    if (status === 507) return 'resource';
    if (status >= 400 && status < 500) return 'param';
    return 'fatal';
  }

  // No status: the request never reached HTTP, so the message is all we have.
  const msg = messageOf(error);
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError') return 'fatal'; // a cancel is not a retry candidate
  if (CAPACITY.test(msg)) return 'resource';
  if (NETWORK.test(msg)) return 'transient';
  if (PARAM.test(msg)) return 'param';
  return 'fatal';
}

export function toFailure(error: unknown): Failure {
  return {
    class: classify(error),
    status: statusOf(error),
    message: messageOf(error),
    retryAfterMs: retryAfterOf(error),
  };
}

/**
 * Exponential backoff with jitter.
 *
 * Half the delay is fixed and half is random: full jitter can return ~0 and
 * hammer a server that just told us it was busy, and no jitter marches every
 * parallel fanout child into the same millisecond.
 */
export function backoffMs(attempts: number, rng: () => number = Math.random): number {
  const exp = Math.min(BACKOFF.capMs, BACKOFF.baseMs * BACKOFF.factor ** Math.max(0, attempts - 1));
  return Math.round(exp / 2 + rng() * (exp / 2));
}

/**
 * Jitter around a delay the server asked for, spread *upward*.
 *
 * `Retry-After` is an instruction, not an average. Jittering below it sends
 * back the request the server just refused, which is the one thing it told us
 * not to do, so the window is [base, base * 1.5] and its floor is the number
 * we were given. Spreading upward still keeps a fanout's children out of the
 * same millisecond, which is the only reason jitter is here at all.
 *
 * The cap is on top because a header is not a promise: a server asking for an
 * hour gets 30s, fails again, and runs the retry budget out in seconds, which
 * surfaces the outage. Sleeping the hour parks the editor on a spinner
 * instead.
 */
function jitterUp(base: number, rng: () => number): number {
  const floor = Math.max(0, base);
  return Math.min(BACKOFF.capMs, Math.round(floor + rng() * (floor / 2)));
}

/**
 * `attempts` is how many tries have already *finished*, so 1 on the first
 * failure. `maxRetriesPerStep` is therefore retries, not total tries.
 */
export function shouldRetry(
  failure: FailureClass | Failure,
  attempts: number,
  limits: ExecutorLimits,
  rng: () => number = Math.random,
): RetryDecision {
  const f: Failure =
    typeof failure === 'string'
      ? { class: failure, status: null, message: failure, retryAfterMs: null }
      : failure;
  const no = (reason: string): RetryDecision => ({ retry: false, delayMs: 0, downgrade: false, reason });

  switch (f.class) {
    case 'param':
      return no('the params are wrong, repair them, do not resend them');

    case 'fatal':
      return no('nothing will help');

    case 'resource': {
      // Once, on a cheaper tier. A second identical attempt joins the same
      // queue that just rejected us.
      // `attempts` counts finished tries, so 1 is the first failure and the
      // one downgrade we allow; 2 means the smaller tier was full as well.
      if (attempts >= 2) return no('the tier is still full after a downgrade');
      return {
        retry: true,
        delayMs: jitterUp(f.retryAfterMs ?? BACKOFF.resourceMs, rng),
        downgrade: true,
        reason: 'no capacity, downgrading the tier and trying once more',
      };
    }

    case 'transient': {
      if (attempts > limits.maxRetriesPerStep) {
        return no(`gave up after ${attempts} attempts`);
      }
      const delayMs = f.retryAfterMs !== null ? jitterUp(f.retryAfterMs, rng) : backoffMs(attempts, rng);
      return { retry: true, delayMs, downgrade: false, reason: 'transient, the same request should work' };
    }

    default:
      return no('unknown failure class');
  }
}
