/**
 * Timeline geometry, as pure functions.
 *
 * Every drag, trim, blade and snap decision in the NLE is decided here, over
 * `Frames`, with no DOM and no React. Two reasons, both learned the hard way:
 *
 *  - The interesting bugs in an editor are all off-by-one-frame bugs, and a
 *    one-frame bug is invisible in a browser and obvious in an assertion.
 *  - The same maths runs from a pointer, from the keyboard and from an
 *    assistant tool call. Written once against frames, it cannot disagree
 *    with itself depending on how the edit was started.
 *
 * Pixels enter and leave only through `framesToPx` / `pxToFrames`. Nothing
 * downstream of those two functions is allowed to hold a pixel.
 */
import {
  ZERO, addFrames, clampFrames, frames, lastFrame, maxFrames, rangeEnd, rangesOverlap,
  secondsToFrames, subFrames, timeRange,
  type Frames, type Rate, type TimeRange,
} from '../../lib/time/frames.ts';
import { isClip, placeTrack, snap, trackDuration, trimBounds } from '../../lib/timeline/document.ts';
import type {
  Clip, EditOp, MediaRef, PlacedItem, Timeline, Track, TrackId, TrackKind,
} from '../../lib/timeline/types.ts';

// ── zoom and pixels ─────────────────────────────────────────────────────

/**
 * Zoom is expressed as pixels-per-FRAME, not pixels-per-second, so that no
 * conversion through the project rate sits between the model and the screen.
 * The bounds are "the whole hour fits" to "one frame is a finger-width".
 */
export const PPF_MIN = 0.01;
export const PPF_MAX = 24;

/** How far from a target an edge starts sticking, in screen pixels. */
export const SNAP_PX = 8;

/** Clips thinner than this are still drawn, so a 1-frame clip stays clickable. */
export const MIN_CLIP_PX = 3;

function assertPpf(ppf: number): void {
  if (!Number.isFinite(ppf) || ppf <= 0) {
    throw new RangeError(`pixels-per-frame must be a positive finite number, got ${ppf}`);
  }
}

export const framesToPx = (f: Frames, ppf: number): number => {
  assertPpf(ppf);
  return f * ppf;
};

/**
 * Pixels to frames, rounded away from zero. Correct for *deltas*: half a
 * frame of mouse travel should round up to a frame of movement, and it must
 * round up by the same amount in both directions. `Math.round` breaks ties
 * toward positive infinity, which makes a drag left one frame shorter than
 * the identical drag right and leaves a clip a frame off where it started
 * after a there-and-back nudge.
 */
export const pxToFrames = (px: number, ppf: number): Frames => {
  assertPpf(ppf);
  const q = px / ppf;
  return frames(Math.sign(q) * Math.round(Math.abs(q)));
};

/**
 * Pixels to frames, truncated. Correct for *positions*, you are standing on
 * frame N from the pixel it starts at until the pixel N+1 starts, which is
 * the same half-open reading the rest of the model uses.
 */
export const pxToFrameAt = (px: number, ppf: number): Frames => {
  assertPpf(ppf);
  return frames(Math.floor(px / ppf));
};

/** Zoom slider position (0…1) to pixels-per-frame. Exponential: linear zoom feels wrong. */
export function ppfFromZoom(z: number, min = PPF_MIN, max = PPF_MAX): number {
  const t = Number.isFinite(z) ? Math.min(1, Math.max(0, z)) : 0;
  return min * Math.pow(max / min, t);
}

export function zoomFromPpf(ppf: number, min = PPF_MIN, max = PPF_MAX): number {
  assertPpf(ppf);
  const t = Math.log(ppf / min) / Math.log(max / min);
  return Math.min(1, Math.max(0, t));
}

export const clampPpf = (ppf: number, min = PPF_MIN, max = PPF_MAX): number =>
  Math.min(max, Math.max(min, ppf));

// ── snapping ────────────────────────────────────────────────────────────

export interface SnapResult {
  /** The value to use. Unchanged when nothing was within tolerance. */
  value: Frames;
  /** The target that was hit, for drawing the snap line. Null means no snap. */
  hit: Frames | null;
}

/**
 * A pixel tolerance in frames.
 *
 * Floors rather than rounds, and is allowed to reach zero: zoomed far enough
 * in that 8px is less than a frame, "snapping" must mean exact equality or it
 * would fight the frame-accurate nudge the user zoomed in to make.
 */
export function snapTolerance(ppf: number, px: number = SNAP_PX): Frames {
  assertPpf(ppf);
  return frames(Math.max(0, Math.floor(px / ppf)));
}

export function snapValue(value: Frames, targets: readonly Frames[], tolerance: Frames): SnapResult {
  const hit = snap(value, targets as Frames[], tolerance);
  return hit === null ? { value, hit: null } : { value: hit, hit };
}

/**
 * Snap a clip that is being moved.
 *
 * Both edges are candidates and the closer one wins, which is what makes a
 * clip drop cleanly against the clip in front of it. Ties go to the head,
 * because the head is the edge the user is looking at.
 */
export function snapMove(
  start: Frames,
  duration: Frames,
  targets: readonly Frames[],
  tolerance: Frames,
): SnapResult {
  const head = snap(start, targets as Frames[], tolerance);
  const tail = snap(addFrames(start, duration), targets as Frames[], tolerance);
  const headGap = head === null ? Infinity : Math.abs(head - start);
  const tailGap = tail === null ? Infinity : Math.abs(tail - (start + duration));
  if (head !== null && headGap <= tailGap) return { value: head, hit: head };
  if (tail !== null) return { value: subFrames(tail, duration), hit: tail };
  return { value: start, hit: null };
}

// ── moving a clip ───────────────────────────────────────────────────────

export interface MoveInput {
  /** Where the clip started when the pointer went down, never re-read mid-drag. */
  origin: Frames;
  duration: Frames;
  deltaPx: number;
  ppf: number;
  targets: readonly Frames[];
  tolerance: Frames;
  snapping: boolean;
}

export interface MoveResult {
  start: Frames;
  hit: Frames | null;
}

/**
 * Where a dragged clip lands.
 *
 * The drag is computed from the pointer's total travel and the position the
 * drag began at, never by accumulating per-move deltas, accumulating loses a
 * frame every time the pointer moves less than half a frame.
 */
export function dragMove(i: MoveInput): MoveResult {
  const raw = addFrames(i.origin, pxToFrames(i.deltaPx, i.ppf));
  const floored = maxFrames(ZERO, raw); // nothing lives before the start of the timeline
  if (!i.snapping) return { start: floored, hit: null };
  const s = snapMove(floored, i.duration, i.targets, i.tolerance);
  // a tail snap can pull the head negative; the wall at zero outranks the snap
  return s.value < 0 ? { start: floored, hit: null } : { start: s.value, hit: s.hit };
}

// ── trimming ────────────────────────────────────────────────────────────

export type TrimEdge = 'in' | 'out';

export interface TrimInput {
  placed: PlacedItem;
  /** The media behind the clip. Without it only the source's own zero bounds it. */
  media: MediaRef | undefined;
  edge: TrimEdge;
  deltaPx: number;
  ppf: number;
  targets: readonly Frames[];
  tolerance: Frames;
  snapping: boolean;
  /** A clip may not be trimmed away entirely. One frame by default. */
  minDuration?: Frames;
}

export interface TrimResult {
  /** Where the clip now begins on the timeline. Only an in-trim moves it. */
  start: Frames;
  sourceRange: TimeRange;
  hit: Frames | null;
  /** True when a handle hit a limit, the UI paints the handle red. */
  clamped: boolean;
}

const UNBOUNDED = Number.MAX_SAFE_INTEGER as Frames;

/**
 * Where a trim handle lands.
 *
 * The two limits are different in kind and both are hard:
 *
 *  - the media limit, you cannot pull out frames that were never shot. This
 *    is `trimBounds()` in the document module, computed from how much source
 *    sits either side of the current in/out.
 *  - the geometry limit, a clip cannot be trimmed past its other edge, and a
 *    clip cannot begin before frame zero.
 *
 * Snapping happens BEFORE clamping, so a handle snapped onto a cut that lies
 * outside the available range still stops at the range rather than jumping
 * past it.
 */
export function trimClip(i: TrimInput): TrimResult {
  const clip = i.placed.item;
  if (!isClip(clip)) throw new TypeError(`only a clip can be trimmed, got a ${clip.kind}`);

  const pos = i.placed.range.start;
  const end = rangeEnd(i.placed.range);
  const src = clip.sourceRange;
  const minDur = i.minDuration ?? frames(1);
  const delta = pxToFrames(i.deltaPx, i.ppf);

  // trimBounds() is null when the media is unknown; the source's own zero is
  // then the only head limit we can honestly claim, and the tail is open.
  const bounds = trimBounds(i.placed, i.media);
  const head = bounds ? bounds.minStart : maxFrames(ZERO, subFrames(pos, src.start));
  const tail = bounds ? bounds.maxEnd : UNBOUNDED;

  if (i.edge === 'in') {
    const wanted = addFrames(pos, delta);
    const snapped = i.snapping ? snapValue(wanted, i.targets, i.tolerance) : { value: wanted, hit: null };
    const lo = head;
    const hi = subFrames(end, minDur);
    const at = clampFrames(snapped.value, lo, hi);
    const d = subFrames(at, pos);
    return {
      start: at,
      sourceRange: timeRange(addFrames(src.start, d), subFrames(i.placed.range.duration, d)),
      hit: at === snapped.hit ? snapped.hit : null,
      clamped: at !== snapped.value,
    };
  }

  const wanted = addFrames(end, delta);
  const snapped = i.snapping ? snapValue(wanted, i.targets, i.tolerance) : { value: wanted, hit: null };
  const lo = addFrames(pos, minDur);
  const at = clampFrames(snapped.value, lo, tail);
  return {
    start: pos,
    sourceRange: timeRange(src.start, subFrames(at, pos)),
    hit: at === snapped.hit ? snapped.hit : null,
    clamped: at !== snapped.value,
  };
}

/**
 * Which handle a click grabs in trim mode.
 *
 * Trim mode is edge-based: the clip body is not a drag handle, it is a way of
 * saying "the near edge of this clip". The two candidates are the in-point at
 * `start` and the out-point at `rangeEnd`, which is the first frame past the
 * clip and therefore the frame the out-handle straddles. A tie goes to the
 * in-point, the same way a snap does.
 */
export const nearestEdge = (range: TimeRange, at: Frames): TrimEdge =>
  at - range.start <= rangeEnd(range) - at ? 'in' : 'out';

// ── blade ───────────────────────────────────────────────────────────────

export interface BladeResult {
  /** Source range for the part that keeps the original id. */
  left: TimeRange;
  /** Source range for the new clip. */
  right: TimeRange;
  /** Where the new clip starts on the timeline. */
  at: Frames;
}

/**
 * Split a clip at a frame.
 *
 * Null unless the frame is strictly inside: a cut at the first frame produces
 * an empty left half, and a cut at `rangeEnd` is already past the clip, the
 * half-open reading again. Everything the two halves are made of comes out of
 * the original, so their durations sum to it exactly and no frame of source
 * is invented or lost.
 */
export function bladeAt(placed: PlacedItem, at: Frames): BladeResult | null {
  const clip = placed.item;
  if (!isClip(clip)) return null;
  const start = placed.range.start;
  const end = rangeEnd(placed.range);
  if (at <= start || at >= end) return null;

  const consumed = subFrames(at, start);
  return {
    left: timeRange(clip.sourceRange.start, consumed),
    right: timeRange(
      addFrames(clip.sourceRange.start, consumed),
      subFrames(placed.range.duration, consumed),
    ),
    at,
  };
}

/**
 * The edit batch a blade produces.
 *
 * Two ops, in this order: the original is shortened first so the new clip has
 * somewhere to land. The batch is applied atomically, so a half-cut clip
 * cannot be observed.
 */
export function bladeOps(placed: PlacedItem, at: Frames, newClipId: string): EditOp[] {
  const cut = bladeAt(placed, at);
  if (!cut) return [];
  const clip = placed.item as Clip;
  return [
    { op: 'patch_clip', clipId: clip.id, set: { sourceRange: cut.left } },
    {
      op: 'add_clip',
      trackId: placed.trackId,
      at: cut.at,
      clip: { ...clip, id: newClipId, sourceRange: cut.right, effects: [...clip.effects] },
    },
  ];
}

// ── ripple ──────────────────────────────────────────────────────────────

export interface RippleShift {
  trackId: TrackId;
  clipId: string;
  from: Frames;
  to: Frames;
}

/**
 * Which clips a ripple pulls left, and to where.
 *
 * A preview, not an edit. It answers "what would move" for the overlay a
 * drag draws, and it moves whole clips, which is NOT what `remove_clip
 * { ripple: true }` does to a clip straddling the hole. Turning these shifts
 * into `move_clip` ops is how `rippleDeleteOps` came to delete the same
 * frames twice: the document closes the hole on every listening track by
 * itself.
 *
 * Auto-select is the whole point of the control in the track header: a track
 * with it off keeps its sync while everything else closes up, which is how
 * you protect a music bed under a re-cut. Locked tracks never move either.
 * `exceptTrackId` is the track the deletion happened on, the document closes
 * that hole by itself, so shifting it here would move it twice.
 */
export function rippleShifts(
  timeline: Timeline,
  at: Frames,
  amount: Frames,
  exceptTrackId?: TrackId,
): RippleShift[] {
  const out: RippleShift[] = [];
  if (amount <= 0) return out;
  for (const track of timeline.tracks) {
    if (track.id === exceptTrackId || !track.autoSelect || track.locked) continue;
    for (const p of placeTrack(track)) {
      if (!isClip(p.item) || p.range.start < at) continue;
      out.push({
        trackId: track.id,
        clipId: p.item.id,
        from: p.range.start,
        to: maxFrames(ZERO, subFrames(p.range.start, amount)),
      });
    }
  }
  return out;
}

/**
 * Ripple-delete a clip: remove it and close the hole everywhere that is
 * listening.
 *
 * `remove_clip { ripple: true }` is the whole edit. It already cuts the
 * deleted span out of the home track AND of every other auto-select track, so
 * adding a `move_clip` per shifted clip moves each of them a second time,
 * against ids the ripple has just consumed: a clip the ripple cut in half no
 * longer exists under its old id and the batch is rejected in full.
 *
 * A home track with auto-select off is the one case that needs a second op.
 * The A toggle has to mean the same thing on the clip's own track as it does
 * on every other one, so the ripple runs everywhere and the home track is
 * then handed its hole back as a gap. Deleting the clip itself is never in
 * question: it was selected, which outranks auto-select.
 */
export function rippleDeleteOps(timeline: Timeline, placed: PlacedItem): EditOp[] {
  const clip = placed.item;
  if (!isClip(clip)) return [];
  const home = timeline.tracks.find((t) => t.id === placed.trackId);
  if (!home || home.locked) return [];
  const ops: EditOp[] = [{ op: 'remove_clip', clipId: clip.id, ripple: true }];
  if (!home.autoSelect) {
    ops.push({
      op: 'add_gap',
      trackId: home.id,
      at: placed.range.start,
      duration: placed.range.duration,
    });
  }
  return ops;
}

// ── edit ops for the direct manipulations ───────────────────────────────

/**
 * The edit batch a trim produces.
 *
 * A trim must move the clip it is holding and nothing else: that is what the
 * drag preview shows, and a neighbour that shifts because you shortened a
 * shot three cuts earlier is how sync is lost. A position is implicit in the
 * sum of the durations before it, so `patch_clip` alone drags everything
 * after the clip by exactly the amount the clip gave back. The compensation
 * is a gap of that size, which is position-independent and cannot overwrite
 * anything:
 *
 *  - the head was pulled right: a gap at the clip's old start puts the head
 *    back where the user dropped it and leaves the rest of the track alone.
 *  - the tail was pulled left: a gap at the clip's new end holds the space
 *    the clip gave up, so the next clip does not slide into it.
 *
 * `move_clip` used to do the first of those and cannot: it drops as an
 * overwrite, and by the time it runs the patch has already pulled the next
 * clip left, so the move eats that clip's head and renames what is left.
 *
 * A trim that LENGTHENS a clip still ripples the rest of the track right.
 * That is not an oversight: no op in the vocabulary gives time back to a gap
 * (`move_clip` frees exactly as much as it consumes, and only `remove_clip`
 * shortens a track), so a longer clip always makes a longer track. Resolve's
 * ripple trim does the same thing, and the head therefore stays where it is
 * while the extra frames appear at the tail.
 */
export function trimOps(placed: PlacedItem, result: TrimResult, track?: Track): EditOp[] {
  const clip = placed.item;
  if (!isClip(clip)) return [];
  const ops: EditOp[] = [
    { op: 'patch_clip', clipId: clip.id, set: { sourceRange: result.sourceRange } },
  ];

  const headGiven = subFrames(result.start, placed.range.start);
  if (headGiven > 0) {
    ops.push({
      op: 'add_gap', trackId: placed.trackId, at: placed.range.start, duration: headGiven,
    });
  }

  const newEnd = addFrames(result.start, result.sourceRange.duration);
  const tailGiven = subFrames(rangeEnd(placed.range), newEnd);
  // nothing but empty time after the clip means nothing to hold in place, and
  // trimming the last shot of a track should shorten the track
  const holdsTail = track
    ? track.items.slice(placed.index + 1).some((i) => i.kind !== 'gap')
    : true;
  if (tailGiven > 0 && holdsTail) {
    ops.push({ op: 'add_gap', trackId: placed.trackId, at: newEnd, duration: tailGiven });
  }

  return ops;
}

export function moveOps(placed: PlacedItem, to: Frames, trackId: TrackId): EditOp[] {
  if (!isClip(placed.item)) return [];
  if (to === placed.range.start && trackId === placed.trackId) return [];
  return [{ op: 'move_clip', clipId: placed.item.id, trackId, to }];
}

// ── the visible window ──────────────────────────────────────────────────

/** Overscan either side of the viewport so a scroll does not reveal blank lanes. */
export const OVERSCAN_PX = 240;

/**
 * The slice of time on screen, in frames, as a half-open range.
 *
 * Only clips intersecting this get DOM nodes. At 0.01 px/frame a two-hour
 * timeline is 1700px wide and everything is visible; at 24 px/frame it is
 * 4 million pixels wide and this is the only reason the page is usable.
 */
export function visibleRange(
  scrollLeft: number,
  viewportWidth: number,
  ppf: number,
  overscanPx: number = OVERSCAN_PX,
): TimeRange {
  assertPpf(ppf);
  const leftPx = Math.max(0, scrollLeft - overscanPx);
  const rightPx = Math.max(leftPx, scrollLeft + Math.max(0, viewportWidth) + overscanPx);
  const start = pxToFrameAt(leftPx, ppf);
  const end = frames(Math.ceil(rightPx / ppf));
  return timeRange(start, subFrames(end, start));
}

/**
 * Does this item need a DOM node?
 *
 * Deliberately stricter than `rangesOverlap`, which counts an empty range
 * sitting inside the window as an overlap. An empty range covers no pixel and
 * so has nothing to render; transitions, which are the zero-duration items in
 * this document, get their box from `transitionBox` instead.
 */
export const inWindow = (r: TimeRange, win: TimeRange): boolean =>
  r.duration > 0 && rangesOverlap(r, win);

/**
 * The space a transition occupies on screen. It contributes no duration to
 * the track (it overlaps its two neighbours) so its box is derived from the
 * cut it straddles rather than from a range in the document.
 */
export function transitionBox(cutAt: Frames, inOffset: Frames, outOffset: Frames): TimeRange {
  const start = maxFrames(ZERO, subFrames(cutAt, inOffset));
  return timeRange(start, subFrames(addFrames(cutAt, outOffset), start));
}

// ── ruler ticks ─────────────────────────────────────────────────────────

export interface TickPlan {
  /** Distance between labelled ticks. */
  major: Frames;
  /** Distance between unlabelled ticks. Always divides `major`. */
  minor: Frames;
}

/** Seconds worth trying, coarsest last. Below a second we step in whole frames. */
const TICK_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
const TICK_FRAMES = [1, 2, 5, 10];

/**
 * The unlabelled step under a labelled one.
 *
 * It has to DIVIDE the major step or the minor ticks walk out of alignment
 * with the labels a few seconds in, and a second is a whole number of frames
 * at 24 or 25fps but not at 29.97 (a second is 30 frames, ten seconds is 300,
 * thirty is 899). Rounding a ratio is what broke it: pick from the divisors
 * the step actually has, coarsest usable first, and fall back to the major
 * step itself when it has none, which paints no minor tick rather than a
 * misaligned one.
 */
const minorFor = (step: Frames): Frames =>
  frames(step / ([5, 4, 3, 2].find((d) => step % d === 0) ?? 1));

/**
 * Pick a tick spacing that leaves room for a timecode label.
 *
 * Timecode is fixed-width, so "room" is a constant and the answer depends
 * only on zoom. The frame-level steps matter: zoomed all the way in an editor
 * labels individual frames, and falling back to one-second ticks there would
 * leave the ruler almost empty.
 */
export function chooseTicks(ppf: number, rate: Rate, minLabelPx = 58): TickPlan {
  assertPpf(ppf);
  for (const f of TICK_FRAMES) {
    if (f * ppf >= minLabelPx) return { major: frames(f), minor: frames(1) };
  }
  for (const sec of TICK_SECONDS) {
    const step = secondsToFrames(sec, rate);
    if (step * ppf >= minLabelPx) return { major: step, minor: minorFor(step) };
  }
  const coarsest = secondsToFrames(TICK_SECONDS[TICK_SECONDS.length - 1], rate);
  return { major: coarsest, minor: minorFor(coarsest) };
}

/** Every major tick inside a window, aligned to absolute zero, not to the window. */
export function ticksIn(win: TimeRange, step: Frames): Frames[] {
  if (step <= 0) throw new RangeError(`tick step must be positive, got ${step}`);
  const first = Math.floor(win.start / step) * step;
  const out: Frames[] = [];
  for (let t = first; t < rangeEnd(win) + step; t += step) {
    if (t >= 0) out.push(frames(t));
  }
  return out;
}

// ── lane geometry ───────────────────────────────────────────────────────

export const TRACK_HEIGHT: Record<TrackKind, number> = {
  video: 68,
  audio: 46,
  subtitle: 30,
};

export interface LaneBox {
  trackId: TrackId;
  kind: TrackKind;
  top: number;
  height: number;
}

export function laneBoxes(tracks: readonly Track[], heightOf = laneHeight): LaneBox[] {
  let top = 0;
  return tracks.map((t) => {
    const height = heightOf(t);
    const box = { trackId: t.id, kind: t.kind, top, height };
    top += height;
    return box;
  });
}

export const laneHeight = (t: Track): number => TRACK_HEIGHT[t.kind];

export const lanesHeight = (boxes: readonly LaneBox[]): number =>
  boxes.reduce((h, b) => h + b.height, 0);

/**
 * Which lane a y offset is over. Half-open, like everything else: the pixel a
 * lane's border sits on belongs to the lane below, so dropping a clip exactly
 * on a boundary is never ambiguous.
 */
export function laneAtY(boxes: readonly LaneBox[], y: number): LaneBox | null {
  for (const b of boxes) {
    if (y >= b.top && y < b.top + b.height) return b;
  }
  return null;
}

// ── marquee ─────────────────────────────────────────────────────────────

/** A band dragged over empty lane space, in lane-stack local pixels. */
export interface MarqueeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Two corners to a box, so a drag up-left gives the same band as down-right. */
export function marqueeBox(x0: number, y0: number, x1: number, y1: number): MarqueeBox {
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/**
 * Every clip the band touches.
 *
 * Touching, not enclosing. A band has to select a clip whose body it crosses,
 * because requiring containment means dragging across the middle of a long
 * shot selects nothing, and at any useful zoom most shots are wider than the
 * screen. Resolve behaves the same way.
 *
 * Pixels convert to frames once, here, and the comparison after that is the
 * same half-open overlap the rest of the timeline uses. The band is widened
 * to at least one frame first: at high zoom a real drag of several pixels
 * floors to a zero-length range, and a zero-length range sitting exactly on a
 * clip's first frame does not overlap it.
 */
export function marqueeHits(
  lanes: readonly { track: Track; placed: readonly PlacedItem[] }[],
  boxes: readonly LaneBox[],
  box: MarqueeBox,
  ppf: number,
): string[] {
  const start = pxToFrameAt(Math.max(0, box.left), ppf);
  const end = maxFrames(
    addFrames(start, frames(1)),
    pxToFrameAt(Math.max(0, box.left + box.width), ppf),
  );
  const span = timeRange(start, subFrames(end, start));
  const bottom = box.top + box.height;

  const hits: string[] = [];
  for (const { track, placed } of lanes) {
    const lane = boxes.find((b) => b.trackId === track.id);
    if (!lane) continue;
    // half-open vertically too: a band that stops on a lane's top edge has
    // not reached into that lane
    if (lane.top >= bottom || lane.top + lane.height <= box.top) continue;
    for (const p of placed) {
      if (!isClip(p.item)) continue;
      if (p.range.duration > 0 && rangesOverlap(p.range, span)) hits.push(p.item.id);
    }
  }
  return hits;
}

// ── navigation ──────────────────────────────────────────────────────────

/**
 * The next cut point in a direction, for up/down arrow navigation. Strictly
 * past `from`, so holding the key walks the edit instead of sticking.
 */
export function nextEdge(targets: readonly Frames[], from: Frames, dir: 1 | -1): Frames | null {
  let best: Frames | null = null;
  for (const t of targets) {
    if (dir > 0 ? t > from : t < from) {
      if (best === null || (dir > 0 ? t < best : t > best)) best = t;
    }
  }
  return best;
}

/**
 * The last frame the playhead may park on.
 *
 * A range is half-open, so a timeline of `duration` frames ends on
 * `duration - 1` and `duration` itself is the first frame that is in no clip:
 * parking there stops playback on a black program viewer. An empty timeline
 * has no frame to stand on, so it holds the playhead at zero.
 */
export const playheadLimit = (duration: Frames): Frames =>
  lastFrame(timeRange(ZERO, maxFrames(ZERO, duration))) ?? ZERO;

/** How wide the scrollable content is. Never narrower than the viewport. */
export function contentWidth(timeline: Timeline, ppf: number, viewportWidth = 0): number {
  assertPpf(ppf);
  const dur = timeline.tracks.length
    ? Math.max(...timeline.tracks.map((t) => trackDuration(t)))
    : 0;
  // a tail of empty time so the last clip is not welded to the right edge
  const tail = Math.max(1, Math.round(240 / ppf));
  // whole pixels: a fractional scroll width leaves a sub-pixel seam at the
  // right edge and makes every clip's `left` land off the device grid
  return Math.ceil(Math.max(viewportWidth, (dur + tail) * ppf));
}

/** Zoom-to-fit: the pixels-per-frame that puts the whole edit on screen. */
export function fitPpf(duration: Frames, viewportWidth: number, padPx = 24): number {
  if (duration <= 0 || viewportWidth <= padPx) return PPF_MIN;
  return clampPpf((viewportWidth - padPx) / duration);
}
