/**
 * The timeline document.
 *
 * Mirrors OTIO's structure closely enough that serialising is mechanical,
 * but with the two corrections that matter:
 *
 *  - every time is `Frames` at the document's rate, never a float second
 *  - a clip's position is NOT stored. In OTIO it is implicit in the order of
 *    a track's children, and duplicating it into the item is how a document
 *    drifts out of agreement with itself. The UI wants absolute positions, so
 *    `place()` derives a flat `PlacedItem[]` on every mutation and nothing
 *    computes a position during render.
 */
import type { Frames, Rate, TimeRange } from '../time/frames.ts';

export type TrackKind = 'video' | 'audio' | 'subtitle';

/** Editor-API ids live in OTIO metadata as `trk_…` / `clp_…`. */
export type TrackId = string;
export type ClipId = string;

export interface MediaRef {
  /** Object key in the bucket, or an http(s) URL. Both are accepted upstream. */
  key: string;
  name: string;
  kind: 'video' | 'audio' | 'image';
  /** The whole of what exists, in source time. Trim handles cannot pass this. */
  available: TimeRange;
  rate?: Rate;
  /**
   * Object keys of frames extracted from this media, evenly spaced across it.
   *
   * Keys, not urls: a signed url dies in an hour and this document outlives
   * the session. `/api/media/frame?key=` signs one on demand.
   *
   * Empty means the extraction has not finished, or failed. It must never
   * mean "draw something plausible instead": showing an invented picture
   * where the user's footage belongs is worse than showing nothing, because
   * nothing is honest and a fake frame is not.
   */
  frames?: string[];
  /**
   * A playable copy, as an object key under `output/`.
   *
   * The original cannot be played. An upload lands under `input/` and nothing
   * will sign one, so a `<video src>` pointing at it is a 404. Import makes
   * this copy with `ffmpeg/transcode`, which is also what makes seeking cheap:
   * it is small and its moov atom is at the front.
   *
   * Absent means playback falls back to stepping through `frames`, which is
   * silent and not smooth, but honest.
   */
  proxy?: string;
  width?: number;
  height?: number;
}

export interface Effect {
  /** `ffmpeg/volume`, `ffmpeg/fade`, a transform, … */
  kind: string;
  params: Record<string, unknown>;
  enabled: boolean;
}

export interface Clip {
  id: ClipId;
  kind: 'clip';
  name: string;
  mediaKey: string;
  /** Which part of the source is used. Its duration is the clip's duration. */
  sourceRange: TimeRange;
  enabled: boolean;
  effects: Effect[];
}

/**
 * A piece of text on screen for a stretch of time.
 *
 * Not a media reference. A subtitle that lives as a `.srt` in the pool can be
 * burned on export and cannot be read in the viewer, edited, retimed, or
 * written by hand, and that is most of what anyone wants to do with one. So
 * the cue is the item and the file is an interchange format at the boundary,
 * which is the same rule OTIO gets: parse on the way in, write on the way out,
 * and keep one authority in the middle.
 *
 * Carries no position, like every other item: where it sits is the sum of the
 * durations before it, and gaps hold the space between cues.
 */
export interface Caption {
  id: string;
  kind: 'caption';
  text: string;
  duration: Frames;
  enabled: boolean;
  /**
   * How it is drawn. Absent means the project default, which is what almost
   * every cue wants: a caption that has to carry its own styling to look
   * normal is a caption nobody will ever write by hand.
   */
  style?: CaptionStyle;
}

export interface CaptionStyle {
  /** Where in the frame, as the ffmpeg/imagemagick gravity names. */
  place?: 'bottom' | 'top' | 'centre';
  /** Points at 1080p, scaled with the delivery height. */
  size?: number;
  colour?: string;
  /** A dark outline is what makes white text readable over anything. */
  outline?: boolean;
}

/** Gaps are real objects that occupy time, exactly as in OTIO. */
export interface Gap {
  id: string;
  kind: 'gap';
  duration: Frames;
}

/** Transitions contribute ZERO duration; they overlap their neighbours. */
export interface Transition {
  id: string;
  kind: 'transition';
  transitionType: string;
  inOffset: Frames;
  outOffset: Frames;
}

export type TrackItem = Clip | Gap | Transition | Caption;

export interface Track {
  id: TrackId;
  kind: TrackKind;
  name: string;
  items: TrackItem[];
  locked: boolean;
  muted: boolean;
  solo: boolean;
  enabled: boolean;
  /** Ripples and inserts skip a track with auto-select off. */
  autoSelect: boolean;
}

export interface Marker {
  id: string;
  at: Frames;
  name: string;
  colour: string;
}

export interface Timeline {
  id: string;
  name: string;
  rate: Rate;
  tracks: Track[];
  markers: Marker[];
  media: Record<string, MediaRef>;
  /** Mirrors the server's append-only revision number. */
  revision: number;
  /** Optimistic-concurrency token for PUT /v1/timelines/{id}. */
  etag?: string;
  /** Export pipeline ID preserved across machines and sessions. */
  exportPipelineId?: string;
}

/** Derived, never stored: an item with the absolute position it lands at. */
export interface PlacedItem {
  item: TrackItem;
  trackId: TrackId;
  index: number;
  range: TimeRange;
}

/**
 * Edit operations.
 *
 * These are the ops `POST /v1/timelines/{id}/edits` takes: up to 500, applied
 * atomically as ONE revision. That is the whole undo story, a model run is
 * one batch, so one undo reverses the run rather than its last step.
 */
export type EditOp =
  | { op: 'add_track'; track: Omit<Track, 'items'> & { items?: TrackItem[] }; at?: number }
  | { op: 'remove_track'; trackId: TrackId }
  | { op: 'patch_track'; trackId: TrackId; set: Partial<Omit<Track, 'id' | 'items'>> }
  | { op: 'add_clip'; trackId: TrackId; clip: Clip; at: Frames }
  | { op: 'remove_clip'; clipId: ClipId; ripple?: boolean }
  | { op: 'patch_clip'; clipId: ClipId; set: Partial<Pick<Clip, 'name' | 'enabled' | 'sourceRange' | 'effects' | 'mediaKey'>> }
  | { op: 'move_clip'; clipId: ClipId; trackId: TrackId; to: Frames }
  | { op: 'add_gap'; trackId: TrackId; at: Frames; duration: Frames }
  | { op: 'add_marker'; marker: Marker }
  | { op: 'remove_marker'; markerId: string }
  /**
   * Text on the timeline. Its own ops rather than a widened `add_clip`,
   * because a caption has no media and no source range, and every one of
   * `add_clip`'s checks is about media it does not have.
   */
  | { op: 'add_caption'; trackId: TrackId; caption: Caption; at: Frames }
  | { op: 'remove_caption'; captionId: string; ripple?: boolean }
  | { op: 'patch_caption'; captionId: string; set: Partial<Pick<Caption, 'text' | 'duration' | 'enabled' | 'style'>> }
  /**
   * Retime a cue: drag it along, or pull one of its edges.
   *
   * `duration` rides along with the position because both are the same lift
   * and drop, and because the other way round is wrong. A position on a track
   * is the sum of the durations before it, so setting a new duration through
   * `patch_caption` moves every cue after it: shorten one line by 12 frames
   * and the rest of the subtitles slide 12 frames early, which is the marker
   * bug with a different name. This op lifts the cue, leaves the hole it was
   * in, and drops it at its new place, so nothing else on the track moves.
   *
   * It overwrites what it lands on, exactly as `move_clip` does. The drag
   * that produces it stops at the neighbouring cue (`captionSpan`), so on the
   * timeline nothing can be overwritten by accident; a caller building this
   * op by hand is trusted to mean it.
   */
  | { op: 'move_caption'; captionId: string; trackId: TrackId; to: Frames; duration?: Frames }
  /**
   * The media pool is part of the document, so putting a file in it is an
   * edit like any other: atomic with whatever else is in the batch, and
   * undoable. An import that added media outside the edit system would be a
   * second way to change the document, which is how two sources of truth get
   * started.
   */
  | { op: 'add_media'; media: MediaRef }
  | { op: 'remove_media'; mediaKey: string };

export interface EditResult {
  timeline: Timeline;
  /** The inverse batch, for the client-side optimistic undo stack. */
  inverse: EditOp[];
}

export interface TimelineProblem {
  code: 'past_media_end' | 'missing_media' | 'mixed_rates' | 'duplicate_id' | 'negative_duration' | 'overlap';
  trackId?: TrackId;
  clipId?: ClipId;
  message: string;
}
