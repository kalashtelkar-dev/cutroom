/**
 * Taking a file back out of the project.
 *
 * `remove_media` refuses to strand a clip: a key still referenced by a clip
 * cannot leave the pool, and that rule is worth keeping, because a timeline
 * pointing at media that is not there is a document that renders to an error
 * an hour later instead of a message now.
 *
 * So removal is a *batch*: every clip that uses the key, then the key. One
 * batch is one revision on the server and one entry on the undo stack, which
 * is what makes "remove it" reversible in a single step rather than clip by
 * clip in reverse.
 */
import type { ClipId, EditOp, MediaRef, PlacedItem, Timeline } from './types.ts';
import { isClip, place } from './document.ts';

export interface MediaUsage {
  media: MediaRef;
  /** Every clip cut from this media, in document order. */
  clips: PlacedItem[];
  /** The tracks those clips sit on, deduped, in document order. */
  trackIds: string[];
}

/** What would go with this key. `null` when the key is not in the pool. */
export function mediaUsage(timeline: Timeline, mediaKey: string): MediaUsage | null {
  const media = timeline.media[mediaKey];
  if (!media) return null;

  const clips = place(timeline).filter((p) => isClip(p.item) && p.item.mediaKey === mediaKey);
  const trackIds: string[] = [];
  for (const c of clips) if (!trackIds.includes(c.trackId)) trackIds.push(c.trackId);

  return { media, clips, trackIds };
}

/**
 * The batch that removes a file and everything cut from it.
 *
 * Deliberately never a ripple, and not offered as an option. A rippled
 * `remove_clip` is a timeline-wide edit: it closes the hole on every track
 * that is following along, so removing two clips of the same file from two
 * tracks splices the second hole out of the first track as well and takes
 * unrelated clips with it. That is a much larger edit than "remove this
 * file", and it is not recoverable by looking at the result.
 *
 * So the rest of the cut stays exactly where it was and the holes are
 * visible. A visible hole is the honest result: it is the thing you would
 * then decide to close, on the tracks you meant.
 */
export function removeMediaOps(timeline: Timeline, mediaKey: string): EditOp[] {
  const usage = mediaUsage(timeline, mediaKey);
  if (!usage) throw new Error(`no media "${mediaKey}" in the pool`);

  const ops: EditOp[] = usage.clips.map((p) => ({
    op: 'remove_clip' as const,
    clipId: p.item.id as ClipId,
  }));
  ops.push({ op: 'remove_media', mediaKey });
  return ops;
}

/** What the undo stack and the dialog call it. One phrasing, used in both. */
export function removeMediaLabel(usage: MediaUsage): string {
  const n = usage.clips.length;
  if (n === 0) return `Remove ${usage.media.name}`;
  return `Remove ${usage.media.name} and ${n} clip${n === 1 ? '' : 's'}`;
}
