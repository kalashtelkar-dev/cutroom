/**
 * What the viewer's transport can reach, and where on the jog it sits.
 *
 * Split out of the component because this is the arithmetic that puts a cut
 * one frame off, and none of it needs a DOM: which frame the transport can
 * actually park on, what the duration readout says, and where a clip's in and
 * out points land on the source jog.
 *
 * Ranges are half-open, so a window's `last` is `start + duration - 1`, the
 * last frame you can park on, and `duration` is the number a readout shows.
 * An empty window has `duration` 0 and `last === first`: there is nowhere to
 * go, and the readout says the thing is empty rather than one frame long.
 */

import { clampFrames, frames, type Frames, type TimeRange } from '../../lib/time/frames.ts';
import type { MediaRef } from '../../lib/timeline/types.ts';

export interface TransportWindow {
  /** First frame the transport can reach, in this clock's own numbering. */
  first: Frames;
  /** Last frame it can reach. Equal to `first` when the window is empty. */
  last: Frames;
  /** How long the window is. Zero is a legitimate answer. */
  duration: Frames;
}

export function transportWindow(start: Frames, duration: Frames): TransportWindow {
  const d = Math.max(0, Math.round(duration));
  return {
    first: start,
    last: frames(d > 0 ? start + d - 1 : start),
    duration: frames(d),
  };
}

/** The program: the whole edit, from zero. */
export const timelineWindow = (duration: Frames): TransportWindow =>
  transportWindow(frames(0), duration);

/**
 * What Source mode scrubs.
 *
 * The media's *available* range, not the clip's used one. Handles are the
 * whole point of a source monitor and `sourceRange` is exactly the part of
 * the media that has none: scrubbing it can never show you the frame just
 * outside the cut, which is the frame you opened Source to look at. Media
 * that is not in the pool leaves only the used range to offer.
 */
export function sourceWindow(used: TimeRange, media?: MediaRef | null): TransportWindow {
  return media
    ? transportWindow(media.available.start, media.available.duration)
    : transportWindow(used.start, used.duration);
}

/** Round and pin a loose number into the window. */
export const clampToWindow = (w: TransportWindow, at: number): Frames =>
  clampFrames(frames(Math.round(at)), w.first, w.last);

/** Where a fraction along the jog lands. */
export const scrubFrame = (w: TransportWindow, fraction: number): Frames =>
  clampToWindow(w, w.first + Math.min(1, Math.max(0, fraction)) * (w.last - w.first));

/** Where a frame sits along the jog, 0 to 1. An empty window sits at 0. */
export function windowFraction(w: TransportWindow, at: Frames): number {
  const span = w.last - w.first;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (at - w.first) / span));
}

/**
 * Where the clip's in and out points sit on the source jog, as fractions.
 *
 * `out` is the LAST used frame, not the half-open end: the end is one past
 * the window and would draw the marker off the right edge of a clip that runs
 * to the end of its media.
 */
export function trimMarks(w: TransportWindow, used: TimeRange): { in: number; out: number } {
  const lastUsed = used.duration > 0 ? frames(used.start + used.duration - 1) : used.start;
  return {
    in: windowFraction(w, clampFrames(used.start, w.first, w.last)),
    out: windowFraction(w, clampFrames(lastUsed, w.first, w.last)),
  };
}

/** Nothing left to play: the transport is parked on the last frame. */
export const atEnd = (w: TransportWindow, at: Frames): boolean => at >= w.last;

/** A window with room to move. Playback on one without it stops instantly. */
export const hasRoom = (w: TransportWindow): boolean => w.last > w.first;
