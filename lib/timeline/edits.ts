/**
 * Applying edits.
 *
 * `applyEdits` is the only way the document changes. It never mutates what it
 * is given: it works on a clone and returns it, so a rejected op leaves the
 * caller holding exactly the timeline it had. That is what "applied atomically
 * as ONE revision" has to mean on the client too, because the optimistic apply
 * and the server's apply must not disagree about a half-finished batch.
 *
 * Two things make this harder than a list splice:
 *
 * A clip's position is not stored, so "put this at frame 900" is a structural
 * change: the track has to be cut at frame 900 first, and padded with a Gap if
 * it does not reach that far yet. Every positional op therefore goes through
 * one primitive, `spliceRange`, which cuts at both ends of a span and swaps its
 * contents. Insert, overwrite, lift and ripple delete are all that one call
 * with different arguments.
 *
 * The inverse batch has to be exact, not approximate, because it is the undo
 * stack. Some ops invert cleanly in the op vocabulary: the inverse of
 * `patch_clip` is `patch_clip` with the previous values, and restoring a
 * sourceRange restores the implicit positions of everything after it for free.
 * The structural ops do not, because there is no "remove this gap" or "replace
 * a track's contents" op, and rebuilding an arbitrary track out of inserts and
 * removes is both fragile and lossy. They invert as a snapshot instead:
 * `remove_track` followed by `add_track` carrying the items, which is exactly
 * why `add_track` takes an optional `items` and an index. Per-op inverses in
 * strict reverse order are then correct by induction, and an inverse applied to
 * its own result gives the redo batch back.
 */
import {
  ZERO, addFrames, timeRange,
  type Frames, type TimeRange,
} from '../time/frames.ts';
import { itemDuration, placeTrack, trackDuration } from './document.ts';
import type {
  Caption,
  Clip, EditOp, EditResult, Gap, Marker, Timeline, Track, TrackItem,
} from './types.ts';

/**
 * The server takes at most this many ops in one batch. Note that an inverse
 * can be up to twice as long as the batch it undoes (a structural op inverts
 * as a pair), so a maximal batch's undo has to be split or sent as a restore
 * of the whole revision. `applyEdits` itself does not impose the cap: refusing
 * to apply a long inverse locally would strand the undo stack.
 */
export const MAX_BATCH_OPS = 500;

export type EditErrorCode =
  | 'no_such_track'
  | 'no_such_clip'
  | 'no_such_marker'
  | 'not_a_clip'
  | 'track_locked'
  | 'duplicate_id'
  | 'bad_position'
  | 'bad_duration'
  /** A caption with no words in it: it holds time and draws nothing. */
  | 'empty_caption';

export class EditError extends Error {
  readonly code: EditErrorCode;
  constructor(code: EditErrorCode, message: string) {
    super(message);
    this.name = 'EditError';
    this.code = code;
  }
}

// ── draft ───────────────────────────────────────────────────────────────

interface Draft {
  timeline: Timeline;
  /**
   * Every id the document has held at any point during this batch, including
   * ones since removed. It is the pool new ids are minted against, NOT the
   * test for a duplicate: an id stays reserved after its item is deleted so
   * that a split later in the same batch cannot resurrect it as a different
   * clip. Whether an id is taken is asked of the document itself.
   */
  used: Set<string>;
}

interface TrackSnapshot {
  track: Track;
  index: number;
}

const clone = <T>(value: T): T => structuredClone(value);

function collectIds(timeline: Timeline): Set<string> {
  const used = new Set<string>();
  for (const track of timeline.tracks) {
    used.add(track.id);
    for (const item of track.items) used.add(item.id);
  }
  for (const marker of timeline.markers) used.add(marker.id);
  return used;
}

/**
 * Minted ids are deterministic so that the same batch on the same document
 * produces the same document. A random id would make the optimistic apply and
 * the server's apply disagree about what to call the second half of a split.
 */
function newGapId(used: Set<string>): string {
  for (let n = 1; ; n++) {
    const id = `gap_${n}`;
    if (!used.has(id)) { used.add(id); return id; }
  }
}

function uniqueId(used: Set<string>, base: string): string {
  if (!used.has(base)) { used.add(base); return base; }
  for (let n = 2; ; n++) {
    const id = `${base}_${n}`;
    if (!used.has(id)) { used.add(id); return id; }
  }
}

const makeGap = (used: Set<string>, duration: Frames): Gap =>
  ({ id: newGapId(used), kind: 'gap', duration });

/**
 * Is this id in the document right now? A restore inverse removes a track and
 * puts it straight back, so asking the minting pool instead would have that
 * pair reject itself.
 */
function hasId(timeline: Timeline, id: string): boolean {
  for (const track of timeline.tracks) {
    if (track.id === id) return true;
    for (const item of track.items) if (item.id === id) return true;
  }
  return timeline.markers.some((m) => m.id === id);
}

function requireFreeId(draft: Draft, id: string): void {
  if (hasId(draft.timeline, id)) {
    throw new EditError('duplicate_id', `id "${id}" is already in this timeline`);
  }
}

function trackIndex(draft: Draft, trackId: string): number {
  const i = draft.timeline.tracks.findIndex((t) => t.id === trackId);
  if (i < 0) throw new EditError('no_such_track', `no track "${trackId}" in this timeline`);
  return i;
}

const requireTrack = (draft: Draft, trackId: string): Track =>
  draft.timeline.tracks[trackIndex(draft, trackId)];

/**
 * A lock protects a track's contents. It deliberately does NOT protect the
 * track's existence or its own flags: `patch_track` is how a lock is lifted,
 * and refusing `remove_track` would make an undo that has to put a locked
 * track back impossible to apply.
 */
function requireUnlocked(track: Track): Track {
  if (track.locked) {
    throw new EditError('track_locked', `track "${track.id}" (${track.name}) is locked`);
  }
  return track;
}

function snapshot(draft: Draft, trackId: string): TrackSnapshot {
  const index = trackIndex(draft, trackId);
  return { track: clone(draft.timeline.tracks[index]), index };
}

/**
 * The exact inverse of a structural change, to one track or to several.
 *
 * Every affected track comes out before any goes back in. A move takes a clip
 * from one track to another, so restoring the source while the clip is still
 * sitting on the destination would collide with its own id. Re-inserting in
 * ascending index order after that lands each track back at the index it had.
 */
function restoreOps(snaps: TrackSnapshot[]): EditOp[] {
  const ordered = [...snaps].sort((a, b) => a.index - b.index);
  return [
    ...ordered.map((s): EditOp => ({ op: 'remove_track', trackId: s.track.id })),
    ...ordered.map((s): EditOp => ({ op: 'add_track', track: s.track, at: s.index })),
  ];
}

interface FoundClip {
  track: Track;
  clip: Clip;
  range: TimeRange;
}

function requireClip(draft: Draft, clipId: string): FoundClip {
  for (const track of draft.timeline.tracks) {
    for (const placed of placeTrack(track)) {
      if (placed.item.id !== clipId) continue;
      if (placed.item.kind !== 'clip') {
        throw new EditError('not_a_clip', `"${clipId}" is a ${placed.item.kind}, not a clip`);
      }
      return { track, clip: placed.item, range: placed.range };
    }
  }
  throw new EditError('no_such_clip', `no clip "${clipId}" in this timeline`);
}

interface FoundCaption { track: Track; caption: Caption; range: TimeRange }

function requireCaption(draft: Draft, captionId: string): FoundCaption {
  for (const track of draft.timeline.tracks) {
    for (const placed of placeTrack(track)) {
      if (placed.item.id !== captionId) continue;
      if (placed.item.kind !== 'caption') {
        throw new EditError('not_a_clip', `"${captionId}" is a ${placed.item.kind}, not a caption`);
      }
      return { track, caption: placed.item, range: placed.range };
    }
  }
  throw new EditError('no_such_clip', `no caption "${captionId}" in this timeline`);
}

function requireDuration(value: Frames, what: string): Frames {
  if (!Number.isInteger(value) || value < 0) {
    throw new EditError('bad_duration', `${what} must be a whole number of frames >= 0, got ${value}`);
  }
  return value;
}

function requirePosition(value: Frames, what: string): Frames {
  if (!Number.isInteger(value) || value < 0) {
    throw new EditError('bad_position', `${what} must be a whole frame >= 0, got ${value}`);
  }
  return value;
}

/**
 * Every number an item carries, checked at the door.
 *
 * `add_track` is the one op that takes items already assembled, so it is the
 * only way a length that is not a length gets into the document without
 * passing `add_clip` or `add_gap`. One such item is not a local problem: a
 * negative duration walks `placeTrack`'s cursor backwards and makes `place()`
 * throw for the whole timeline, so the track that carries it takes every other
 * track down with it.
 */
function requireItem(item: TrackItem): void {
  if (item.kind === 'clip') {
    requireDuration(item.sourceRange.duration, `clip "${item.id}" duration`);
    requirePosition(item.sourceRange.start, `clip "${item.id}" source in-point`);
    return;
  }
  if (item.kind === 'gap') {
    requireDuration(item.duration, `gap "${item.id}" duration`);
    return;
  }
  if (item.kind === 'caption') {
    requireDuration(item.duration, `caption "${item.id}" duration`);
    // a cue with nothing in it occupies time and draws nothing, which is a
    // gap that does not look like one on the timeline
    if (!item.text.trim()) throw new EditError('empty_caption', `caption "${item.id}" has no text`);
    return;
  }
  requireDuration(item.inOffset, `transition "${item.id}" in-offset`);
  requireDuration(item.outOffset, `transition "${item.id}" out-offset`);
}

// ── the one structural primitive ────────────────────────────────────────

/**
 * Cut a track at an absolute frame and return the index of the item that
 * starts there, creating that boundary if it does not exist yet.
 *
 * Half-open ranges decide the two edge cases: `at` equal to an item's start is
 * already a boundary and splits nothing, and `at` equal to the track's total
 * duration is the index after the last item rather than a split of it. Past
 * the end, the track is padded with a Gap so the caller's frame is real.
 */
function splitAt(draft: Draft, track: Track, at: Frames): number {
  requirePosition(at, 'a position');
  let cursor: Frames = ZERO;
  for (let i = 0; i < track.items.length; i++) {
    const item = track.items[i];
    if (at === cursor) return i;
    const duration = itemDuration(item);
    if (at < addFrames(cursor, duration)) {
      const offset = (at - cursor) as Frames;
      if (item.kind === 'clip') {
        const head: Clip = { ...item, sourceRange: timeRange(item.sourceRange.start, offset) };
        const tail: Clip = {
          ...clone(item),
          id: uniqueId(draft.used, `${item.id}_b`),
          sourceRange: timeRange(
            addFrames(item.sourceRange.start, offset),
            (duration - offset) as Frames,
          ),
        };
        track.items.splice(i, 1, head, tail);
      } else if (item.kind === 'gap') {
        const tail: Gap = { ...item, id: newGapId(draft.used), duration: (duration - offset) as Frames };
        track.items.splice(i, 1, { ...item, duration: offset }, tail);
      }
      return i + 1;
    }
    cursor = addFrames(cursor, duration);
  }
  if (at > cursor) track.items.push(makeGap(draft.used, (at - cursor) as Frames));
  return track.items.length;
}

/**
 * Replace `[at, at + span)` on a track with `items`. Everything else is this:
 * insert is a zero-length span, overwrite is a span the length of the clip,
 * lift is a span replaced by a Gap, ripple delete is a span replaced by
 * nothing.
 */
function spliceRange(draft: Draft, track: Track, at: Frames, span: Frames, items: TrackItem[]): void {
  const from = splitAt(draft, track, at);
  const to = span === 0 ? from : splitAt(draft, track, addFrames(at, span));
  track.items.splice(from, to - from, ...items);
}

/**
 * Merge adjacent gaps and drop empty ones. Two gaps in a row are the same
 * hole written twice, and a zero-duration gap occupies nothing, so both are
 * noise that would otherwise accumulate one op at a time. A trailing gap is
 * kept: it is how a track holds a length past its last clip.
 */
function normaliseTrack(track: Track): void {
  const out: TrackItem[] = [];
  for (const item of track.items) {
    if (item.kind === 'gap') {
      if (item.duration === 0) continue;
      const prev = out[out.length - 1];
      if (prev && prev.kind === 'gap') {
        out[out.length - 1] = { ...prev, duration: addFrames(prev.duration, item.duration) };
        continue;
      }
    }
    out.push(item);
  }
  track.items = out;
}

const markerOrder = (a: Marker, b: Marker): number =>
  a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Insert a marker at its place in (at, id) order.
 *
 * Pushing and re-sorting the whole array would reorder markers this op never
 * touched, and `remove_marker` only takes its own marker back out, so on a
 * document whose markers did not arrive sorted the pair would not be an
 * inverse: undo would silently reshuffle the rest. Inserting at the position
 * the order asks for keeps a sorted document sorted and makes the removal
 * exact whatever order the document came in.
 */
function insertMarker(timeline: Timeline, marker: Marker): void {
  const at = timeline.markers.findIndex((m) => markerOrder(marker, m) < 0);
  timeline.markers.splice(at < 0 ? timeline.markers.length : at, 0, marker);
}

function definedOnly<T extends object>(set: Partial<T>): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(set)) if (value !== undefined) out[key] = value;
  return out as Partial<T>;
}

/** The previous values of exactly the keys a patch touches: its inverse. */
function previousOf<T extends object>(target: T, set: Partial<T>): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(definedOnly(set))) {
    out[key] = clone((target as Record<string, unknown>)[key]);
  }
  return out as Partial<T>;
}

// ── the ops ─────────────────────────────────────────────────────────────

function applyOne(draft: Draft, op: EditOp): EditOp[] {
  switch (op.op) {
    case 'add_track': {
      requireFreeId(draft, op.track.id);
      const items = clone(op.track.items ?? []);
      const incoming = new Set<string>([op.track.id]);
      for (const item of items) {
        requireFreeId(draft, item.id);
        if (incoming.has(item.id)) {
          throw new EditError('duplicate_id', `the track carries "${item.id}" twice`);
        }
        incoming.add(item.id);
        requireItem(item);
        draft.used.add(item.id);
      }
      draft.used.add(op.track.id);
      const track: Track = { ...clone(op.track), items };
      // an index past the end means "at the bottom", which is what a model
      // asking for track 99 of 5 means
      const at = Math.max(0, Math.min(op.at ?? draft.timeline.tracks.length, draft.timeline.tracks.length));
      draft.timeline.tracks.splice(at, 0, track);
      return [{ op: 'remove_track', trackId: track.id }];
    }

    case 'remove_track': {
      const snap = snapshot(draft, op.trackId);
      draft.timeline.tracks.splice(snap.index, 1);
      return [{ op: 'add_track', track: snap.track, at: snap.index }];
    }

    case 'patch_track': {
      const track = requireTrack(draft, op.trackId);
      const set = definedOnly(op.set);
      const prev = previousOf(track, set);
      Object.assign(track, clone(set));
      return [{ op: 'patch_track', trackId: track.id, set: prev }];
    }

    case 'add_clip': {
      const track = requireUnlocked(requireTrack(draft, op.trackId));
      requireFreeId(draft, op.clip.id);
      const clip = clone(op.clip);
      requireDuration(clip.sourceRange.duration, "a clip's duration");
      // the in-point is a frame in the media, so it is a position: a
      // fractional one validates clean, serialises, and then cannot be read
      // back, because `fromRationalTime` refuses a value off a frame boundary
      requirePosition(clip.sourceRange.start, "a clip's source in-point");
      requirePosition(op.at, 'add_clip.at');
      const snap = snapshot(draft, track.id);
      draft.used.add(clip.id);
      // an insert, not an overwrite: the track is cut at `at` and everything
      // after it moves right by the clip's duration
      spliceRange(draft, track, op.at, ZERO, [clip]);
      normaliseTrack(track);
      return restoreOps([snap]);
    }

    case 'remove_clip': {
      const found = requireClip(draft, op.clipId);
      requireUnlocked(found.track);
      const span = found.range;
      // ripple is a timeline-wide edit: the hole closes on every track that is
      // following along, which is what the A toggle in a track header decides.
      // The clip's own track always follows, named as it was. A track that
      // ends at or before the cut is left out: it has no hole to close, and
      // splicing it anyway pads it out to the cut with a trailing gap it never
      // had, which is a silent change to a track the user did not touch.
      const targets = op.ripple
        ? draft.timeline.tracks.filter((t) => t === found.track
          || (t.autoSelect && !t.locked && trackDuration(t) > span.start))
        : [found.track];
      const snaps = targets.map((t) => snapshot(draft, t.id));
      for (const track of targets) {
        spliceRange(draft, track, span.start, span.duration, op.ripple ? [] : [makeGap(draft.used, span.duration)]);
        normaliseTrack(track);
      }
      return restoreOps(snaps);
    }

    case 'patch_clip': {
      const found = requireClip(draft, op.clipId);
      requireUnlocked(found.track);
      const set = definedOnly(op.set);
      if (set.sourceRange) {
        requireDuration(set.sourceRange.duration, "a clip's duration");
        requirePosition(set.sourceRange.start, "a clip's source in-point");
      }
      const prev = previousOf(found.clip, set);
      Object.assign(found.clip, clone(set));
      normaliseTrack(found.track);
      // restoring the sourceRange restores the position of everything after
      // it as well, because positions are implicit
      return [{ op: 'patch_clip', clipId: found.clip.id, set: prev }];
    }

    case 'move_clip': {
      const found = requireClip(draft, op.clipId);
      requireUnlocked(found.track);
      const dest = requireUnlocked(requireTrack(draft, op.trackId));
      requirePosition(op.to, 'move_clip.to');
      const snaps = dest === found.track
        ? [snapshot(draft, found.track.id)]
        : [snapshot(draft, found.track.id), snapshot(draft, dest.id)];
      const clip = found.clip;
      const duration = clip.sourceRange.duration;
      // lift first: leaving a gap behind means nothing else on the source
      // track moves, so `to` still means the frame the caller was looking at
      spliceRange(draft, found.track, found.range.start, duration, [makeGap(draft.used, duration)]);
      // and drop as an overwrite, which is what dragging a clip does in every
      // NLE: an insert here would shove the rest of the track out of sync
      spliceRange(draft, dest, op.to, duration, [clip]);
      normaliseTrack(found.track);
      if (dest !== found.track) normaliseTrack(dest);
      return restoreOps(snaps);
    }

    case 'add_gap': {
      const track = requireUnlocked(requireTrack(draft, op.trackId));
      requireDuration(op.duration, "a gap's duration");
      requirePosition(op.at, 'add_gap.at');
      const snap = snapshot(draft, track.id);
      spliceRange(draft, track, op.at, ZERO, [makeGap(draft.used, op.duration)]);
      normaliseTrack(track);
      return restoreOps([snap]);
    }

    case 'add_marker': {
      requireFreeId(draft, op.marker.id);
      requirePosition(op.marker.at, 'a marker position');
      draft.used.add(op.marker.id);
      insertMarker(draft.timeline, clone(op.marker));
      return [{ op: 'remove_marker', markerId: op.marker.id }];
    }

    case 'add_media': {
      const existing = draft.timeline.media[op.media.key];
      draft.timeline.media = { ...draft.timeline.media, [op.media.key]: clone(op.media) };
      // Re-importing the same file replaces its entry rather than refusing:
      // a second probe of the same key is how a corrected duration lands.
      return existing
        ? [{ op: 'add_media', media: existing }]
        : [{ op: 'remove_media', mediaKey: op.media.key }];
    }

    case 'remove_media': {
      const media = draft.timeline.media[op.mediaKey];
      if (!media) throw new EditError('no_such_clip', `no media "${op.mediaKey}" in the pool`);
      const used = draft.timeline.tracks.some((t) =>
        t.items.some((i) => i.kind === 'clip' && i.mediaKey === op.mediaKey));
      if (used) {
        throw new EditError('no_such_clip',
          `"${op.mediaKey}" is still used by a clip; remove the clips first`);
      }
      const next = { ...draft.timeline.media };
      delete next[op.mediaKey];
      draft.timeline.media = next;
      return [{ op: 'add_media', media }];
    }

    case 'add_caption': {
      const track = requireUnlocked(requireTrack(draft, op.trackId));
      requireFreeId(draft, op.caption.id);
      const caption = clone(op.caption);
      requireDuration(caption.duration, "a caption's duration");
      requirePosition(op.at, 'add_caption.at');
      if (!caption.text.trim()) {
        throw new EditError('empty_caption', `caption "${caption.id}" has no text`);
      }
      const snap = snapshot(draft, track.id);
      draft.used.add(caption.id);
      // an OVERWRITE, not an insert. Cues arrive with absolute times from a
      // transcription, so inserting would push every later cue along by the
      // length of the one before it and the whole track would drift.
      spliceRange(draft, track, op.at, caption.duration, [caption]);
      normaliseTrack(track);
      return restoreOps([snap]);
    }

    case 'remove_caption': {
      const found = requireCaption(draft, op.captionId);
      requireUnlocked(found.track);
      const span = found.range;
      const snap = snapshot(draft, found.track.id);
      spliceRange(draft, found.track, span.start, span.duration,
        op.ripple ? [] : [makeGap(draft.used, span.duration)]);
      normaliseTrack(found.track);
      return restoreOps([snap]);
    }

    case 'patch_caption': {
      const found = requireCaption(draft, op.captionId);
      requireUnlocked(found.track);
      const set = definedOnly(op.set);
      if (set.duration !== undefined) requireDuration(set.duration, "a caption's duration");
      if (set.text !== undefined && !set.text.trim()) {
        throw new EditError('empty_caption', `caption "${found.caption.id}" would be left with no text`);
      }
      const prev = previousOf(found.caption, set);
      Object.assign(found.caption, clone(set));
      normaliseTrack(found.track);
      return [{ op: 'patch_caption', captionId: found.caption.id, set: prev }];
    }

    case 'remove_marker': {
      const index = draft.timeline.markers.findIndex((m) => m.id === op.markerId);
      if (index < 0) throw new EditError('no_such_marker', `no marker "${op.markerId}"`);
      const [marker] = draft.timeline.markers.splice(index, 1);
      return [{ op: 'add_marker', marker }];
    }
  }
}

/**
 * Apply a batch. Returns a new timeline and the batch that undoes it.
 *
 * Throws `EditError` and changes nothing if any op is invalid: the work
 * happens on a clone that is only handed back once every op has landed.
 */
export function applyEdits(timeline: Timeline, ops: readonly EditOp[]): EditResult {
  const draft: Draft = { timeline: clone(timeline), used: collectIds(timeline) };
  const inverses: EditOp[][] = [];

  for (let i = 0; i < ops.length; i++) {
    try {
      inverses.push(applyOne(draft, ops[i]));
    } catch (err) {
      const where = `op ${i} (${ops[i].op})`;
      if (err instanceof EditError) throw new EditError(err.code, `${where}: ${err.message}`);
      throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // the revision is append-only, so undoing is a new revision too rather than
  // a step back to an old number
  if (ops.length > 0) draft.timeline.revision = timeline.revision + 1;

  inverses.reverse();
  return { timeline: draft.timeline, inverse: inverses.flat() };
}
