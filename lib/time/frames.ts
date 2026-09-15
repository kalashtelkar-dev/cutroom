/**
 * Time.
 *
 * One rule: **inside this application a time is an integer frame count at the
 * project rate.** OTIO's `RationalTime` only appears at the serialization
 * boundary, in `toRationalTime` / `fromRationalTime`.
 *
 * That rule exists because RationalTime has edges that corrupt a cut quietly
 * rather than loudly:
 *
 *  - `value` is a double. Nothing in the format stops frame 10.5 existing.
 *  - Arithmetic between two rates promotes to the higher rate, so adding a
 *    24fps duration to a 48fps position silently changes the position's rate.
 *  - Comparison is exact float-on-seconds with no epsilon, so two times that
 *    should be equal frequently are not.
 *  - `23.976` and `24000/1001` are different rates and compare unequal, even
 *    though every editor in the world calls them the same thing.
 *
 * Integers at a single known rate have none of those problems, and the two
 * conversion functions are the only places a mistake can be made.
 */

// ── rate ────────────────────────────────────────────────────────────────

/**
 * A frame rate as an exact rational. Never a float: 30000/1001 is not 29.97,
 * and storing it as 29.97 loses the only information that distinguishes them.
 */
export interface Rate {
  readonly num: number;
  readonly den: number;
}

export const RATES = {
  film: { num: 24, den: 1 },
  ntscFilm: { num: 24000, den: 1001 },   // "23.976"
  pal: { num: 25, den: 1 },
  ntsc: { num: 30000, den: 1001 },       // "29.97"
  web: { num: 30, den: 1 },
  palHigh: { num: 50, den: 1 },
  ntscHigh: { num: 60000, den: 1001 },   // "59.94"
  high: { num: 60, den: 1 },
} as const satisfies Record<string, Rate>;

export function rate(num: number, den = 1): Rate {
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) {
    throw new RangeError(`bad rate ${num}/${den}`);
  }
  const g = gcd(Math.round(num * 1000), Math.round(den * 1000));
  // keep integer rates exact; only normalise when both sides are integers
  if (Number.isInteger(num) && Number.isInteger(den)) {
    const d = gcd(num, den);
    return { num: num / d, den: den / d };
  }
  return { num: Math.round(num * 1000) / g, den: Math.round(den * 1000) / g };
}

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a || 1;
}

/** Exact equality by cross-multiplication, never by comparing decimals. */
export const rateEquals = (a: Rate, b: Rate): boolean => a.num * b.den === b.num * a.den;

/** Decimal value, for display only. Never compare two of these. */
export const rateFps = (r: Rate): number => r.num / r.den;

export function rateLabel(r: Rate): string {
  const fps = rateFps(r);
  return r.den === 1 ? `${r.num} fps` : `${fps.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} fps`;
}

/** NTSC rates carry drop-frame timecode; integer rates never do. */
export const isDropFrameRate = (r: Rate): boolean => r.den === 1001 && r.num % 30000 === 0;

// ── frames ──────────────────────────────────────────────────────────────

declare const FrameBrand: unique symbol;

/**
 * A whole number of frames at the project rate. Branded so a raw number
 * (seconds, pixels, a millisecond timestamp) cannot be passed where a frame
 * count is expected.
 */
export type Frames = number & { readonly [FrameBrand]: true };

export function frames(n: number): Frames {
  if (!Number.isInteger(n)) throw new RangeError(`frames must be a whole number, got ${n}`);
  return n as Frames;
}

export const ZERO = frames(0);

export const addFrames = (a: Frames, b: Frames): Frames => (a + b) as Frames;
export const subFrames = (a: Frames, b: Frames): Frames => (a - b) as Frames;
export const maxFrames = (...f: Frames[]): Frames => Math.max(...f) as Frames;
export const minFrames = (...f: Frames[]): Frames => Math.min(...f) as Frames;
export const clampFrames = (f: Frames, lo: Frames, hi: Frames): Frames =>
  Math.min(Math.max(f, lo), hi) as Frames;

/** Scale a duration, for speed changes. Rounds, because frames are discrete. */
export const scaleFrames = (f: Frames, factor: number): Frames => Math.round(f * factor) as Frames;

// ── seconds, only at the edges ──────────────────────────────────────────

export const framesToSeconds = (f: Frames, r: Rate): number => (f * r.den) / r.num;

/**
 * Seconds in, frames out. Rounds to the nearest frame, which is a decision
 * and not an accident: a user-supplied "0:12" lands on the frame nearest to
 * 12 seconds rather than silently truncating a third of a frame early.
 */
export const secondsToFrames = (sec: number, r: Rate): Frames =>
  Math.round((sec * r.num) / r.den) as Frames;

/** Truncating variant, for lower bounds where overshooting is worse. */
export const secondsToFramesFloor = (sec: number, r: Rate): Frames =>
  Math.floor((sec * r.num) / r.den) as Frames;

// ── OTIO boundary ───────────────────────────────────────────────────────

/** OTIO's RationalTime, exactly as it appears in the document. */
export interface RationalTime {
  value: number;
  rate: number;
}

export const toRationalTime = (f: Frames, r: Rate): RationalTime => ({
  value: f,
  rate: rateFps(r),
});

/**
 * Read a RationalTime into frames at the project rate.
 *
 * Refuses silently-lossy conversions. A document at a rate that isn't the
 * project's, or a non-integer frame value, is a real problem, it is better
 * surfaced here than discovered as a one-frame drift after a render.
 */
export function fromRationalTime(rt: RationalTime, project: Rate): Frames {
  if (!Number.isFinite(rt.value) || !Number.isFinite(rt.rate)) {
    throw new RangeError(`RationalTime is not finite: ${JSON.stringify(rt)}`);
  }
  const sameRate = Math.abs(rt.rate - rateFps(project)) < 1e-9;
  if (sameRate) {
    if (!Number.isInteger(rt.value)) {
      throw new RangeError(
        `RationalTime.value ${rt.value} is not a whole frame at ${rateLabel(project)}`,
      );
    }
    return rt.value as Frames;
  }
  // different rate: convert through seconds, but only if it lands exactly
  const seconds = rt.value / rt.rate;
  const exact = (seconds * project.num) / project.den;
  const rounded = Math.round(exact);
  if (Math.abs(exact - rounded) > 1e-6) {
    throw new RangeError(
      `${rt.value} @ ${rt.rate}fps is ${exact.toFixed(4)} frames at ${rateLabel(project)}, not a frame boundary`,
    );
  }
  return rounded as Frames;
}

// ── ranges are half-open ────────────────────────────────────────────────

/**
 * `[start, start + duration)`. The end frame is NOT part of the range.
 *
 * Getting this wrong is the classic NLE bug where clicking the last frame of
 * a clip selects the next one, so every helper here is written against the
 * half-open reading and there is no `end` field to disagree with `duration`.
 */
export interface TimeRange {
  readonly start: Frames;
  readonly duration: Frames;
}

export function timeRange(start: Frames, duration: Frames): TimeRange {
  if (duration < 0) throw new RangeError(`duration cannot be negative (${duration})`);
  return { start, duration };
}

/** First frame after the range. Never itself inside it. */
export const rangeEnd = (r: TimeRange): Frames => (r.start + r.duration) as Frames;

/** Last frame actually in the range. Undefined for an empty range. */
export const lastFrame = (r: TimeRange): Frames | undefined =>
  r.duration === 0 ? undefined : ((r.start + r.duration - 1) as Frames);

export const rangeContains = (r: TimeRange, f: Frames): boolean =>
  f >= r.start && f < rangeEnd(r);

export const rangesOverlap = (a: TimeRange, b: TimeRange): boolean =>
  a.start < rangeEnd(b) && b.start < rangeEnd(a);

export function rangeIntersection(a: TimeRange, b: TimeRange): TimeRange | null {
  const start = Math.max(a.start, b.start) as Frames;
  const end = Math.min(rangeEnd(a), rangeEnd(b)) as Frames;
  return end > start ? timeRange(start, (end - start) as Frames) : null;
}

export const rangesEqual = (a: TimeRange, b: TimeRange): boolean =>
  a.start === b.start && a.duration === b.duration;

// ── timecode ────────────────────────────────────────────────────────────

/**
 * SMPTE timecode. Drop-frame is used for 29.97/59.94 and marked with ';'
 * before the frames field, as the spec and every NLE do, it drops timecode
 * labels, never actual frames.
 */
export function toTimecode(f: Frames, r: Rate, opts: { dropFrame?: boolean } = {}): string {
  const drop = opts.dropFrame ?? isDropFrameRate(r);
  const nominal = Math.round(rateFps(r));
  let n: number = f;

  if (drop) {
    const dropPerMin = (nominal / 30) * 2;         // 2 at 29.97, 4 at 59.94
    const framesPer10Min = nominal * 60 * 10 - dropPerMin * 9;
    const framesPerMin = nominal * 60 - dropPerMin;
    const tenMins = Math.floor(n / framesPer10Min);
    const rem = n % framesPer10Min;
    // the first minute of each ten does not drop
    const mins = rem < nominal * 60 ? 0 : Math.floor((rem - nominal * 60) / framesPerMin) + 1;
    n += dropPerMin * (9 * tenMins + Math.max(0, mins));
  }

  const ff = n % nominal;
  const totalSec = Math.floor(n / nominal);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const p = (v: number) => String(v).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}${drop ? ';' : ':'}${p(ff)}`;
}

/** Loose parse of "hh:mm:ss:ff", "mm:ss", "1:23.5" or a bare number of seconds. */
export function parseTimecode(text: string, r: Rate): Frames | null {
  const s = text.trim();
  if (!s) return null;
  const smpte = s.match(/^(\d+):(\d{1,2}):(\d{1,2})[:;](\d{1,2})$/);
  if (smpte) {
    const [, h, m, sec, f] = smpte;
    const nominal = Math.round(rateFps(r));
    return ((((+h * 60 + +m) * 60 + +sec) * nominal) + +f) as Frames;
  }
  const clock = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (clock) {
    const [, h, m, sec] = clock;
    return secondsToFrames((+(h ?? 0) * 60 + +m) * 60 + parseFloat(sec), r);
  }
  if (/^\d+(\.\d+)?$/.test(s)) return secondsToFrames(parseFloat(s), r);
  return null;
}
