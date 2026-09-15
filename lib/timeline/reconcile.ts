/**
 * Reconcile operation outputs back to the timeline.
 *
 * When an AI or catalogue operation finishes, its output files must reach the
 * project cleanly: registered into the media pool with an add_media op, and
 * placed onto a track if there is an active target or selection.
 *
 * Everything here returns EditOp[] so the reconciliation is applied via the
 * standard commit() path and reverses with a single undo.
 */

import type { Clip, EditOp, MediaRef, PlacedItem, Timeline, TrackId } from './types.ts';
import { mediaKind } from '../media/import.ts';
import { frames, timeRange, ZERO, type Frames } from '../time/frames.ts';

export interface ReconcileContext {
  selected?: PlacedItem | null;
  playhead?: Frames;
  label?: string;
}

export function reconcileOutputs(
  timeline: Timeline,
  outputs: { key: string; bytes?: number; role?: string }[],
  ctx: ReconcileContext = {},
): EditOp[] {
  if (!outputs.length) return [];

  const ops: EditOp[] = [];

  for (const out of outputs) {
    const key = out.key;
    if (!key) continue;

    const filename = key.split('/').pop() ?? key;
    const kind = mediaKind('', filename);

    // If media is not in pool, register it
    let media = timeline.media[key];
    if (!media) {
      // Default duration: match selection duration if available, else 120 frames
      const dur = ctx.selected ? ctx.selected.range.duration : frames(120);
      media = {
        key,
        name: filename,
        kind,
        available: timeRange(ZERO, dur),
      };
      ops.push({ op: 'add_media', media });
    }

    // If there is a selected clip and the output is meant to replace or accompany it
    if (ctx.selected) {
      const placed = ctx.selected;
      if (placed.item.kind === 'clip') {
        const track = timeline.tracks.find((t) => t.id === placed.trackId);
        if (track && track.kind === kind) {
          const newClipId = `clp_${Math.random().toString(36).slice(2, 10)}`;
          ops.push(
            { op: 'remove_clip', clipId: placed.item.id },
            {
              op: 'add_clip',
              trackId: placed.trackId,
              clip: {
                ...placed.item,
                id: newClipId,
                mediaKey: key,
              },
              at: placed.range.start,
            },
          );
        } else {
          // Otherwise, place on a compatible track at the same time range
          const targetTrack = timeline.tracks.find((t) => t.kind === kind && !t.locked);
          if (targetTrack) {
            const newClipId = `clp_${Math.random().toString(36).slice(2, 10)}`;
            const newClip: Clip = {
              id: newClipId,
              kind: 'clip',
              name: `${filename}`,
              mediaKey: key,
              sourceRange: timeRange(ZERO, placed.range.duration),
              enabled: true,
              effects: [],
            };
            ops.push({
              op: 'add_clip',
              trackId: targetTrack.id,
              clip: newClip,
              at: placed.range.start,
            });
          }
        }
      }
    } else if (ctx.playhead !== undefined) {
      // Place at the playhead on the first compatible unlocked track
      const targetTrack = timeline.tracks.find((t) => t.kind === kind && !t.locked);
      if (targetTrack) {
        const newClipId = `clp_${Math.random().toString(36).slice(2, 10)}`;
        const dur = frames(120);
        const newClip: Clip = {
          id: newClipId,
          kind: 'clip',
          name: filename,
          mediaKey: key,
          sourceRange: timeRange(ZERO, dur),
          enabled: true,
          effects: [],
        };
        ops.push({
          op: 'add_clip',
          trackId: targetTrack.id,
          clip: newClip,
          at: ctx.playhead,
        });
      }
    }
  }

  return ops;
}
