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
import type { Clip, PlacedItem, Timeline, Track, TrackItem, TrackKind } from './types.ts';

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

/**
 * How long a track runs.
 *
 * Up to the end of its last item that is not a gap, and NOT the sum of every
 * item on it. A gap between two clips is a length: it holds the second one
 * where the edit put it. A gap after the last one is not a length, it is the
 * absence of one, and there is no edit that depends on it.
 *
 * The difference reached a rendered file. Deleting the last clip without
 * ripple leaves a gap where it was, the timeline kept claiming the length it
 * had before, and the export compiled that tail as real generated black: a
 * cut that ends at thirteen seconds came back as a seventeen second file with
 * four seconds of nothing welded to the end of it. Nobody asked for those
 * four seconds and nothing on screen said they were there.
 */
export const trackDuration = (track: Track): Frames => {
  let cursor: Frames = ZERO;
  let lastItemEnd: Frames = ZERO;
  for (const item of track.items) {
    cursor = addFrames(cursor, itemDuration(item));
    if (item.kind !== 'gap') lastItemEnd = cursor;
  }
  return lastItemEnd;
};

/** The longest track. An empty timeline is zero, not undefined. */
export const timelineDuration = (timeline: Timeline): Frames =>
  timeline.tracks.length ? maxFrames(...timeline.tracks.map(trackDuration)) : ZERO;

/**
 * Where the programme ends: the last frame that carries picture or sound.
 *
 * Not the same question as `timelineDuration`, and the export asks this one.
 * A caption track can reach past the last clip, a switched off clip holds its
 * place on the timeline, and a muted or hidden track is still a track. None
 * of those put anything in the file, so none of them should lengthen it, and
 * every one of them used to: the render's length came from the longest track
 * of any kind, so a subtitle cue sitting past the end of the footage bought
 * you seconds of black with words on it.
 *
 * Deliberately generous about WHAT counts and strict about WHERE it ends: a
 * clip inside the programme is what it is, and the only thing being decided
 * here is the last frame worth encoding.
 */
export const programmeDuration = (timeline: Timeline): Frames => {
  let end: Frames = ZERO;
  for (const kind of ['video', 'audio'] as const) {
    for (const track of playingTracks(timeline, kind)) {
      let cursor: Frames = ZERO;
      for (const item of track.items) {
        cursor = addFrames(cursor, itemDuration(item));
        if (isClip(item) && item.enabled) end = maxFrames(end, cursor);
      }
    }
  }
  return end;
};

/**
 * The tracks of one kind that reach the render.
 *
 * The compiler asked this question and `programmeDuration` asks it again, so
 * it is answered once. Two copies of a rule about muting and soloing would
 * disagree the first time either was changed, and the way that shows up is a
 * file whose length is defended by one of them and whose content is built by
 * the other.
 *
 * Solo is exclusive within a kind: soloing a picture track does not silence
 * the sound, which is what every NLE does and what anyone reaches for it to
 * do. Mute is audio's alone; the picture equivalent is `enabled`.
 */
export function playingTracks(timeline: Timeline, kind: TrackKind): Track[] {
  const all = timeline.tracks.filter(
    (t) => t.kind === kind && t.enabled && !(kind === 'audio' && t.muted),
  );
  const solo = all.filter((t) => t.solo);
  return solo.length ? solo : all;
}

/**
 * The size of the footage, when the picture tracks all agree on one.
 *
 * Null when any clip that reaches the screen never reported a size, and null
 * when two of them disagree. Both are the same answer for the same reason:
 * the only thing this is used for is telling someone what a delivery frame of
 * a different shape will do to their picture, and a sentence about black bars
 * is worse than silence if the footage might already be vertical.
 *
 * Deliberately not "the first clip's size" or "the commonest size". A guess
 * that is usually right is exactly the kind of thing that reads as a fact on
 * screen.
 */
export function footageSize(timeline: Timeline): { width: number; height: number } | null {
  let found: { width: number; height: number } | null = null;
  for (const track of playingTracks(timeline, 'video')) {
    for (const item of track.items) {
      if (!isClip(item) || !item.enabled) continue;
      const media = timeline.media[item.mediaKey];
      if (!media?.width || !media.height) return null;
      if (!found) found = { width: media.width, height: media.height };
      else if (found.width !== media.width || found.height !== media.height) return null;
    }
  }
  return found;
}

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
export function emptyTimeline(
  id: string,
  name: string,
  rate: Timeline['rate'],
  templateId?: string,
  target?: { targetId?: string; width?: number; height?: number },
): Timeline {
  return {
    id,
    name,
    rate,
    tracks: templateTracks(templateId),
    markers: [],
    media: {},
    revision: 0,
    targetId: target?.targetId ?? 'youtube',
    width: target?.width ?? 1920,
    height: target?.height ?? 1080,
  };
}
