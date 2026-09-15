/**
 * Deriving positions.
 *
 * A clip does not store where it sits. Its position is the sum of the
 * durations of everything before it on its track, which is how OTIO defines
 * it and the only definition that cannot disagree with itself. Everything the
 * UI needs, absolute ranges, what is under the playhead, how long the
 * timeline is, is derived here, once per mutation, never during render.
 */
import {
  ZERO, addFrames, frames, maxFrames, rangeContains, rangeEnd, timeRange,
  type Frames, type TimeRange,
} from '../time/frames.ts';
import type { Clip, PlacedItem, Timeline, Track, TrackItem } from './types.ts';

export const isClip = (i: TrackItem): i is Clip => i.kind === 'clip';

/**
 * How much time an item occupies. Transitions occupy none, by definition.
 *
 * Written as an exhaustive switch rather than a fall-through, and that is not
 * style. When `Caption` joined the item union every other place that assumed
 * it was closed failed to compile, and this one did not: the fall-through
 * returned a perfectly valid `ZERO`, so every caption silently became a
 * transition, occupied no time, and stacked at frame nought. A default that
 * returns a plausible value is how a widened union gets through a type
 * checker without anybody noticing.
 */
export function itemDuration(item: TrackItem): Frames {
  switch (item.kind) {
    case 'clip': return item.sourceRange.duration;
    case 'gap': return item.duration;
    case 'caption': return item.duration;
    case 'transition': return ZERO;
  }
}

/** Every item on a track, with the absolute range it lands in. */
export function placeTrack(track: Track): PlacedItem[] {
  const out: PlacedItem[] = [];
  let cursor: Frames = ZERO;
  track.items.forEach((item, index) => {
    const duration = itemDuration(item);
    out.push({ item, trackId: track.id, index, range: timeRange(cursor, duration) });
    cursor = addFrames(cursor, duration);
  });
  return out;
}

/** The whole document, flattened. Recompute on mutation and cache the result. */
export const place = (timeline: Timeline): PlacedItem[] =>
  timeline.tracks.flatMap(placeTrack);

export const trackDuration = (track: Track): Frames =>
  track.items.reduce<Frames>((sum, i) => addFrames(sum, itemDuration(i)), ZERO);

/** The longest track. An empty timeline is zero, not undefined. */
export const timelineDuration = (timeline: Timeline): Frames =>
  timeline.tracks.length ? maxFrames(...timeline.tracks.map(trackDuration)) : ZERO;

/**
 * What is at a frame on a track.
 *
 * Half-open, so parking on the last frame of a clip selects that clip and not
 * the one after it. Getting this wrong is the classic NLE bug.
 */
export function itemAt(track: Track, at: Frames): PlacedItem | null {
  return placeTrack(track).find((p) => rangeContains(p.range, at)) ?? null;
}

/** The topmost enabled video clip at a frame, what the program viewer shows. */
export function clipAt(timeline: Timeline, at: Frames, kinds: Track['kind'][] = ['video']): PlacedItem | null {
  for (const track of timeline.tracks) {
    if (!kinds.includes(track.kind) || !track.enabled) continue;
    const hit = itemAt(track, at);
    if (hit && isClip(hit.item) && hit.item.enabled) return hit;
  }
  return null;
}

export const findTrack = (t: Timeline, id: string): Track | undefined =>
  t.tracks.find((x) => x.id === id);

export function findClip(t: Timeline, clipId: string): PlacedItem | null {
  for (const track of t.tracks) {
    const hit = placeTrack(track).find((p) => p.item.id === clipId);
    if (hit) return hit;
  }
  return null;
}

/** Where a clip could be trimmed to, given how much source exists either side. */
export function trimBounds(
  placed: PlacedItem,
  media: { available: TimeRange } | undefined,
): { minStart: Frames; maxEnd: Frames } | null {
  if (!isClip(placed.item) || !media) return null;
  const src = placed.item.sourceRange;
  const headroom = (src.start - media.available.start) as Frames;
  const tailroom = (rangeEnd(media.available) - rangeEnd(src)) as Frames;
  return {
    minStart: Math.max(0, placed.range.start - headroom) as Frames,
    maxEnd: addFrames(rangeEnd(placed.range), tailroom),
  };
}

/**
 * Cut points on every track, plus markers and zero: what snapping sticks to.
 *
 * `exceptClipId` removes the edges a dragged clip contributes, but a clip
 * abutting a neighbour shares those frames with it, so in practice this only
 * changes anything at the end of a track or for a lone item. That is correct
 * rather than a shortfall: while a clip is lifted the hole it left is still a
 * real edge, and snapping back to where it started is a useful thing to be
 * able to do.
 */
export function snapTargets(timeline: Timeline, exceptClipId?: string): Frames[] {
  const set = new Set<number>([0]);
  for (const track of timeline.tracks) {
    for (const p of placeTrack(track)) {
      if (p.item.id === exceptClipId) continue;
      set.add(p.range.start);
      set.add(rangeEnd(p.range));
    }
  }
  for (const m of timeline.markers) set.add(m.at);
  return [...set].sort((a, b) => a - b).map((n) => frames(n));
}

/** Nearest snap target within `tolerance`, or null to leave the value alone. */
export function snap(value: Frames, targets: Frames[], tolerance: Frames): Frames | null {
  let best: Frames | null = null;
  let bestGap = Infinity;
  for (const t of targets) {
    const gap = Math.abs(t - value);
    if (gap <= tolerance && gap < bestGap) { bestGap = gap; best = t; }
  }
  return best;
}

import { templateTracks } from './templates.ts';

/** An empty document at a rate, with the tracks an editor expects to find. */
export function emptyTimeline(id: string, name: string, rate: Timeline['rate'], templateId?: string): Timeline {
  return {
    id,
    name,
    rate,
    tracks: templateTracks(templateId),
    markers: [],
    media: {},
    revision: 0,
  };
}
