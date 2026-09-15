/**
 * What the program monitor is currently drawing, as one string.
 *
 * Playback does not re-render this panel. The clock runs at the display's
 * rate and React learns the position only when what is ON SCREEN actually
 * changes, which this function decides: the rAF loop in `Viewer.tsx` compares
 * this signature every frame and calls `setPosition` only when it moves.
 *
 * That makes the signature load-bearing in a way it does not look. Anything
 * the viewer draws from `position` and that is NOT in here is drawn once at
 * the moment playback started and then frozen until some other thing happens
 * to change. It is a cache key for the picture, so it has to name everything
 * in the picture.
 */

import { frameKeyAt } from '../../lib/media/frameAt.ts';
import type { Frames } from '../../lib/time/frames.ts';
import { captionAt } from '../../lib/subtitles/place.ts';
import { isClip, itemAt } from '../../lib/timeline/document.ts';
import type { Timeline } from '../../lib/timeline/types.ts';

export function activeTimelineSignature(timeline: Timeline, at: Frames): string {
  let sig = '';
  for (const track of timeline.tracks) {
    if (!track.enabled) continue;
    const placed = itemAt(track, at);
    if (!placed || !isClip(placed.item) || !placed.item.enabled) {
      sig += `${track.id}:none;`;
    } else {
      const media = timeline.media[placed.item.mediaKey];
      const fk = (!media?.proxy && media)
        ? frameKeyAt(media, placed.item.sourceRange.start + (at - placed.range.start)) ?? ''
        : '';
      sig += `${track.id}:${placed.item.id}:${placed.range.start}:${fk};`;
    }
  }
  /**
   * The caption under the playhead, read from `captionAt`, which is the same
   * call the viewer draws from. Two walks of the subtitle tracks that decide
   * "is a cue up" separately is the drift that puts one frame of text on
   * screen and not the next, so there is one of them.
   *
   * Clips above answer per TRACK; a caption answers once, because only one is
   * ever drawn. Its text is in the key as well as its id: the key is compared
   * against a copy held across renders, so a cue whose words changed under a
   * running clock has to read as a different picture.
   */
  const cue = captionAt(timeline, at);
  sig += `cap:${cue ? `${cue.id}:${cue.text}` : 'none'};`;
  return sig;
}
