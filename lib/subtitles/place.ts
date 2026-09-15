/**
 * Cues onto a track.
 *
 * The gap between "the transcription finished" and "I can see subtitles" is
 * this file, and it was the whole of what was missing: the job succeeded, an
 * empty subtitle track got added, and nothing ever put the words on it.
 *
 * One batch, so a run that lays down two hundred cues is one undo, exactly
 * like every other edit here.
 */
import type { Caption, EditOp, Timeline, Track, TrackId } from '../timeline/types.ts';
import { frames, ZERO, type Frames, type Rate } from '../time/frames.ts';
import { placeTrack } from '../timeline/document.ts';
import { parseSrt, toSrt, type Cue } from './srt.ts';

/** A stable id per cue, so re-running a transcription replaces rather than stacks. */
const captionId = (n: number, seed: string): string =>
  `cap_${seed}_${String(n).padStart(4, '0')}`;

export interface PlaceOptions {
  /** Which subtitle track. Defaults to the first one. */
  trackId?: TrackId;
  /**
   * Distinguishes one transcription's cues from another's, so running the
   * tool twice does not collide ids and does not silently interleave.
   */
  seed?: string;
  /** Everything after this is offset, for a clip that is not at zero. */
  offset?: Frames;
  style?: Caption['style'];
}

/** The subtitle track a caption should land on, or null if there is none. */
export function subtitleTrack(timeline: Timeline, trackId?: TrackId): Track | null {
  if (trackId) {
    const named = timeline.tracks.find((t) => t.id === trackId);
    return named && named.kind === 'subtitle' ? named : null;
  }
  return timeline.tracks.find((t) => t.kind === 'subtitle') ?? null;
}

/**
 * The batch that clears a subtitle track and lays these cues on it.
 *
 * Clearing first is deliberate. Re-running a transcription over a track that
 * already has one leaves two sets of overlapping cues, and on a subtitle
 * track that is not a layer, it is a mess nobody can see to fix.
 */
export function placeCuesOps(
  timeline: Timeline,
  cues: readonly Cue[],
  opts: PlaceOptions = {},
): EditOp[] {
  const track = subtitleTrack(timeline, opts.trackId);
  if (!track) throw new Error('this project has no subtitle track to put captions on');

  const offset = opts.offset ?? ZERO;
  const seed = opts.seed ?? 'srt';
  const ops: EditOp[] = [];

  // out with the old, in document order, so the inverse of the batch puts
  // them back where they were
  for (const placed of placeTrack(track)) {
    if (placed.item.kind === 'caption') ops.push({ op: 'remove_caption', captionId: placed.item.id });
    else if (placed.item.kind === 'clip') ops.push({ op: 'remove_clip', clipId: placed.item.id });
  }

  cues.forEach((cue, n) => {
    const caption: Caption = {
      id: captionId(n, seed),
      kind: 'caption',
      text: cue.text,
      duration: cue.duration,
      enabled: true,
      ...(opts.style ? { style: opts.style } : {}),
    };
    ops.push({
      op: 'add_caption',
      trackId: track.id,
      caption,
      at: frames(Math.max(0, cue.start + offset)),
    });
  });

  return ops;
}

/** An SRT file straight onto the timeline. The two halves, in one call. */
export function placeSrtOps(
  timeline: Timeline,
  srt: string,
  rate: Rate,
  opts: PlaceOptions = {},
): { ops: EditOp[]; cues: Cue[] } {
  const cues = parseSrt(srt, rate);
  if (!cues.length) {
    // an empty transcript is a real answer: silence, or the wrong language.
    // Wiping the track for it would destroy subtitles somebody already had.
    return { ops: [], cues };
  }
  return { ops: placeCuesOps(timeline, cues, opts), cues };
}

/** Every caption on every subtitle track, in order, as cues. */
export function cuesOf(timeline: Timeline): Cue[] {
  const out: Cue[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== 'subtitle' || !track.enabled) continue;
    for (const placed of placeTrack(track)) {
      const item = placed.item;
      if (item.kind !== 'caption' || !item.enabled) continue;
      out.push({ start: placed.range.start, duration: placed.range.duration, text: item.text });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** The document's captions as an SRT file. */
export const timelineSrt = (timeline: Timeline): string => toSrt(cuesOf(timeline), timeline.rate);

/** The caption on screen at a frame, or null. Half-open, like every range. */
export function captionAt(timeline: Timeline, at: Frames): Caption | null {
  for (const track of timeline.tracks) {
    if (track.kind !== 'subtitle' || !track.enabled) continue;
    for (const placed of placeTrack(track)) {
      const item = placed.item;
      if (item.kind !== 'caption' || !item.enabled) continue;
      if (at >= placed.range.start && at < placed.range.start + placed.range.duration) return item;
    }
  }
  return null;
}
