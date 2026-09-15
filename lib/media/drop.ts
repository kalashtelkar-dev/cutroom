/**
 * Dropping media onto the timeline.
 *
 * The maths lives here, away from React, because "where does this land" is
 * the part that can be wrong in a way you only notice three edits later.
 *
 * Two rules that are easy to get wrong and expensive to discover:
 *
 *  - a drop lands at a frame, not at a pixel. Converting once, at the edge,
 *    is what keeps the clip where the pointer said it was.
 *  - a drop onto an occupied span must not silently overwrite. It snaps to
 *    the end of what is there, which is what every NLE does and what the
 *    person dragging expects.
 */
import { frames, rangeEnd, type Frames } from '../time/frames.ts';
import { placeTrack } from '../timeline/document.ts';
import type { EditOp, MediaRef, Timeline, Track } from '../timeline/types.ts';

/** The payload a media-pool drag carries. */
export const DRAG_TYPE = 'application/x-cutroom-media';

export interface DropPlan {
  trackId: string;
  at: Frames;
  op: EditOp;
  ops: EditOp[];
  /** True when `at` is not where the pointer was, because something was there. */
  nudged: boolean;
}

const KIND_FOR: Record<MediaRef['kind'], Track['kind']> = {
  video: 'video',
  image: 'video',
  audio: 'audio',
};

/** A still or a clip both become a clip; only the track kind differs. */
export const acceptsMedia = (track: Track, media: MediaRef): boolean =>
  !track.locked && KIND_FOR[media.kind] === track.kind;

/**
 * The first frame at or after `at` where `duration` fits on this track.
 *
 * Walks forward rather than searching: a track has few items, and landing
 * just after the thing you dropped onto is the behaviour people expect.
 */
export function firstFreeFrom(track: Track, at: Frames, duration: Frames): Frames {
  const placed = placeTrack(track);
  let cursor = at;
  let moved = true;
  while (moved) {
    moved = false;
    for (const p of placed) {
      if (p.item.kind !== 'clip') continue;
      const overlaps = cursor < rangeEnd(p.range) && p.range.start < cursor + duration;
      if (overlaps) { cursor = rangeEnd(p.range); moved = true; }
    }
  }
  return cursor;
}

export function planDrop(
  timeline: Timeline,
  trackId: string,
  at: Frames,
  mediaKey: string,
  newId: (prefix: string) => string,
): DropPlan | { error: string } {
  const track = timeline.tracks.find((t) => t.id === trackId);
  if (!track) return { error: `no track "${trackId}"` };

  const media = timeline.media[mediaKey];
  if (!media) return { error: `"${mediaKey}" is not in the media pool` };

  if (track.locked) return { error: `${track.name} is locked` };
  if (!acceptsMedia(track, media)) {
    return { error: `${media.name} is ${media.kind}, and ${track.name} is a ${track.kind} track` };
  }

  const start = frames(Math.max(0, at));
  const landed = firstFreeFrom(track, start, media.available.duration);

  const videoOp: EditOp = {
    op: 'add_clip',
    trackId,
    at: landed,
    clip: {
      id: newId('clp'),
      kind: 'clip',
      name: media.name,
      mediaKey: media.key,
      // the whole of what exists, which is what dragging from a pool means
      sourceRange: media.available,
      enabled: true,
      effects: [],
    },
  };

  const ops: EditOp[] = [videoOp];

  // When dropping a video onto a video track, place its paired audio on the matching audio track
  if (media.kind === 'video' && track.kind === 'video') {
    const audioTracks = timeline.tracks.filter((t) => t.kind === 'audio' && !t.locked);
    const num = /(\d+)$/.exec(track.id)?.[1] ?? /(\d+)\s*$/.exec(track.name)?.[1];
    const targetAudioTrack = num
      ? audioTracks.find((t) => t.id === `trk_a${num}` || t.name.endsWith(num)) ?? audioTracks[0]
      : audioTracks[0];

    if (targetAudioTrack) {
      const audioLanded = firstFreeFrom(targetAudioTrack, landed, media.available.duration);
      ops.push({
        op: 'add_clip',
        trackId: targetAudioTrack.id,
        at: audioLanded,
        clip: {
          id: newId('clp'),
          kind: 'clip',
          name: media.name,
          mediaKey: media.key,
          sourceRange: media.available,
          enabled: true,
          effects: [],
        },
      });
    }
  }

  return {
    trackId,
    at: landed,
    nudged: landed !== start,
    op: videoOp,
    ops,
  };
}

/** The track a drop at this y belongs to, given the lane boxes. */
export function trackAtY(
  boxes: readonly { trackId: string; top: number; height: number }[],
  y: number,
): string | null {
  for (const b of boxes) {
    if (y >= b.top && y < b.top + b.height) return b.trackId;
  }
  return null;
}
