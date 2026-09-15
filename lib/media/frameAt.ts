/**
 * Which extracted frame stands for a point in a piece of media.
 *
 * Its own module, and a `.ts` one, so `node --test` can load it: the program
 * monitor's frame choice is exactly the kind of arithmetic that is wrong by
 * one and invisible until someone notices the player disagrees with the
 * timeline.
 */
import type { MediaRef } from '../timeline/types.ts';

/**
 * Which extracted frame is nearest a point in the source.
 *
 * The frames are evenly spaced across the whole of the media, so the index is
 * the position through `available` times the count. A still has one frame and
 * it is that frame at every point.
 */
export function frameKeyAt(media: MediaRef, sourceAt: number): string | null {
  const list = media.frames;
  if (!list || !list.length) return null;
  if (list.length === 1) return list[0];

  const span = media.available.duration;
  if (span <= 0) return list[0];
  const through = (sourceAt - media.available.start) / span;
  const i = Math.round(through * (list.length - 1));
  return list[Math.min(list.length - 1, Math.max(0, i))] ?? null;
}
