/**
 * Turning a finished run back into the cost table.
 *
 * The table in `compile.ts` started as numbers somebody typed, with a setter
 * beside it that nothing ever called and a test that called the setter and
 * then read it back. That test passes forever and proves nothing: the
 * estimate shown to a user was the same guess it had always been, wearing
 * the word "calibrated".
 *
 * A run already carries what is needed. Every step reports `engine`,
 * `operation`, `startedAt` and `finishedAt`, and the compiler knows how many
 * seconds of output each node produces. Those two together are seconds of
 * work per second of output, measured.
 *
 * Three things this is careful about:
 *
 *  - **It is wall time.** A step's clock includes time the worker spent
 *    getting to the job, so the measurement is an over-estimate of encode
 *    time and an honest estimate of what a person waits for.
 *  - **One run is not a measurement.** A cold worker can take ten times as
 *    long as a warm one, so a sample is blended into the table rather than
 *    replacing it, and the table starts from values that are already sane.
 *  - **A step that did not succeed tells you nothing.** Failed, skipped and
 *    cached steps are dropped, as is any step whose node produced no output
 *    seconds, because dividing by zero is not a calibration.
 */
import { recordCostMetric, getCostPerSecond } from './compile.ts';

export interface RunStep {
  step: string;
  status: string;
  engine?: string;
  operation?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface Sample {
  /** `engine/operation`, the key the cost table uses. */
  opKey: string;
  /** Wall seconds the step took. */
  wallSeconds: number;
  /** Seconds of output the step produced. */
  outputSeconds: number;
  /** The measurement: wall seconds per second of output. */
  perSecond: number;
}

export interface Calibration {
  samples: Sample[];
  /** What each op key moved to, and from, after blending. */
  applied: { opKey: string; from: number; to: number; samples: number }[];
  /** Why steps were dropped, counted. Kept so a run that teaches nothing says so. */
  skipped: Record<string, number>;
}

/**
 * How much of a new sample to believe.
 *
 * A third: three consistent runs move the table most of the way, one odd run
 * moves it a little. Chosen rather than derived, so it is named here with the
 * reason instead of buried in an expression.
 */
export const BLEND = 1 / 3;

const DONE = new Set(['succeeded', 'done', 'completed']);

/** Milliseconds between two ISO timestamps, or null if either is unusable. */
function spanMs(from: unknown, to: unknown): number | null {
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const ms = b - a;
  return ms >= 0 ? ms : null;
}

/**
 * The measurements in a run, without touching anything.
 *
 * Separate from applying them so the arithmetic can be tested against real
 * step payloads with no global state involved.
 */
export function measureRun(
  steps: readonly RunStep[],
  nodeSeconds: Readonly<Record<string, number>>,
): { samples: Sample[]; skipped: Record<string, number> } {
  const samples: Sample[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };

  for (const step of steps) {
    if (!DONE.has(step.status)) { skip('did not succeed'); continue; }
    if (!step.engine || !step.operation) { skip('no operation named'); continue; }

    const ms = spanMs(step.startedAt, step.finishedAt);
    if (ms === null) { skip('no usable timestamps'); continue; }

    const outputSeconds = nodeSeconds[step.step];
    if (typeof outputSeconds !== 'number' || outputSeconds <= 0) {
      skip('no output duration for that node');
      continue;
    }

    // A step that finished in the same millisecond it started did not do the
    // work: it is a cache hit or a no-op, and recording zero would drag the
    // table to zero and make every future estimate say "instant".
    const wallSeconds = ms / 1000;
    if (wallSeconds <= 0) { skip('finished in no time, so nothing ran'); continue; }

    samples.push({
      opKey: `${step.engine}/${step.operation}`,
      wallSeconds,
      outputSeconds,
      perSecond: wallSeconds / outputSeconds,
    });
  }

  return { samples, skipped };
}

/**
 * Measure a run and move the table towards it.
 *
 * Several steps of the same operation in one run are averaged first, so a
 * timeline with forty trims counts as one opinion about trimming rather
 * than forty.
 */
export function calibrateFromRun(
  steps: readonly RunStep[],
  nodeSeconds: Readonly<Record<string, number>>,
  blend: number = BLEND,
): Calibration {
  const { samples, skipped } = measureRun(steps, nodeSeconds);

  const byOp = new Map<string, number[]>();
  for (const s of samples) {
    const list = byOp.get(s.opKey);
    if (list) list.push(s.perSecond);
    else byOp.set(s.opKey, [s.perSecond]);
  }

  const applied: Calibration['applied'] = [];
  for (const [opKey, values] of byOp) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const from = getCostPerSecond(opKey);
    const to = from + (mean - from) * blend;
    recordCostMetric(opKey, to);
    applied.push({
      opKey,
      from: Math.round(from * 1000) / 1000,
      to: Math.round(to * 1000) / 1000,
      samples: values.length,
    });
  }
  applied.sort((a, b) => a.opKey.localeCompare(b.opKey));

  return { samples, applied, skipped };
}

/** One line for the job log, or null when the run taught nothing. */
export function describeCalibration(c: Calibration): string | null {
  if (!c.applied.length) return null;
  const moved = c.applied
    .filter((a) => Math.abs(a.to - a.from) >= 0.005)
    .map((a) => `${a.opKey} ${a.from} to ${a.to}`);
  if (!moved.length) return `cost table confirmed by ${c.samples.length} measured steps`;
  return `cost table moved by ${c.samples.length} measured steps: ${moved.join(', ')}`;
}
