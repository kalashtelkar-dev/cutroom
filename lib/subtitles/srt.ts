/**
 * SRT, at the boundary and nowhere else.
 *
 * The document holds cues as `Caption` items at integer frames. SRT holds
 * them as `HH:MM:SS,mmm` strings. This is the only place the two meet, for
 * the same reason `lib/timeline/otio.ts` is the only place `RationalTime`
 * appears: one conversion, tested, rather than a dozen scattered ones that
 * each round slightly differently.
 *
 * Two rules the format makes easy to get wrong.
 *
 * **SRT times are absolute and independent.** Every cue carries its own start
 * and end, so a cue is converted on its own. That is the opposite of a
 * track's items, where a position is the sum of the durations before it, and
 * mixing the two up is how markers ended up a frame off every cut they marked
 * (`3.4s + 6.2s` is frame 231, `round(9.6 x 24)` is 230).
 *
 * **SRT's end time looks inclusive and our ranges are half-open.** A cue
 * `00:00:01,000 --> 00:00:02,000` occupies `[24, 48)` at 24fps: the frame at
 * 2.000s belongs to whatever comes next. Rounding both ends and subtracting
 * gives exactly that, with no epsilon anywhere.
 */
import { frames, rateFps, type Frames, type Rate } from '../time/frames.ts';

export interface Cue {
  /** Absolute position on the track, in frames at the project rate. */
  start: Frames;
  duration: Frames;
  text: string;
}

export class SrtError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.name = 'SrtError';
    this.line = line;
  }
}

const TIME = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

/** One SRT timestamp as seconds. Milliseconds are padded, so ",5" is 500ms. */
function stamp(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}

/** Seconds to the frame that contains them, at the project rate. */
export const atFrame = (seconds: number, rate: Rate): Frames =>
  frames(Math.max(0, Math.round(seconds * rateFps(rate))));

/**
 * Parse an SRT file into cues at the project rate.
 *
 * Forgiving about what it can be: a BOM, CRLF, blank lines, a missing index
 * number, `.` instead of `,` for milliseconds, and a WEBVTT header, since the
 * same parser then reads a .vtt. Strict about the one thing that matters,
 * which is that a cue carries a readable time.
 */
export function parseSrt(text: string, rate: Rate): Cue[] {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues: Cue[] = [];

  let i = 0;
  while (i < lines.length) {
    const match = TIME.exec(lines[i].trim());
    if (!match) { i += 1; continue; }

    const startSec = stamp(match[1], match[2], match[3], match[4]);
    const endSec = stamp(match[5], match[6], match[7], match[8]);
    if (endSec < startSec) throw new SrtError(i + 1, 'a cue ends before it starts');

    const body: string[] = [];
    i += 1;
    while (i < lines.length && lines[i].trim() !== '' && !TIME.test(lines[i].trim())) {
      body.push(lines[i]);
      i += 1;
    }

    const start = atFrame(startSec, rate);
    const end = atFrame(endSec, rate);
    const content = body.join('\n').trim();
    // a cue that rounds to nothing at this rate, or carries no words, would
    // become an item that holds time and draws nothing
    if (end > start && content) {
      cues.push({ start, duration: frames(end - start), text: content });
    }
  }

  // A file whose cues are out of order is a file, not an error. The track
  // wants them in order, so sorting here means nothing downstream has to.
  cues.sort((a, b) => a.start - b.start || a.duration - b.duration);
  return cues;
}

/** Frames as `HH:MM:SS,mmm`. */
export function stampOf(at: Frames, rate: Rate): string {
  const ms = Math.round((at / rateFps(rate)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}`
    + `:${pad(Math.floor((ms % 60000) / 1000))},${pad(ms % 1000, 3)}`;
}

/** Cues back out as an SRT file, for export and for interchange. */
export function toSrt(cues: readonly Cue[], rate: Rate): string {
  return cues
    .map((c, n) => [
      String(n + 1),
      `${stampOf(c.start, rate)} --> ${stampOf(frames(c.start + c.duration), rate)}`,
      c.text,
      '',
    ].join('\n'))
    .join('\n');
}
