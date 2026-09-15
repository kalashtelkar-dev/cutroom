/**
 * Adding and removing transitions.
 *
 * In OTIO and in Cutroom, a Transition sits on a track between two items (or at an edge),
 * occupying ZERO timeline duration and defining inOffset and outOffset.
 */
import { frames } from '../time/frames.ts';
import type { EditOp, Timeline, Transition } from './types.ts';

export const TRANSITION_TYPES = [
  { id: 'SMPTE_Dissolve', name: 'Cross Dissolve' },
  { id: 'CrossFade', name: 'Audio Crossfade' },
  { id: 'DipToBlack', name: 'Dip to Black' },
  { id: 'DipToWhite', name: 'Dip to White' },
];

export function addTransitionOps(
  timeline: Timeline,
  trackId: string,
  clipId: string,
  transitionType = 'SMPTE_Dissolve',
  durationFrames = 24,
): EditOp[] {
  const trackIndex = timeline.tracks.findIndex((t) => t.id === trackId);
  if (trackIndex === -1) return [];
  const track = timeline.tracks[trackIndex];
  const itemIndex = track.items.findIndex((item) => item.id === clipId);
  if (itemIndex === -1) return [];

  const half = Math.floor(durationFrames / 2);
  const transition: Transition = {
    id: `trn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    kind: 'transition',
    transitionType,
    inOffset: frames(half),
    outOffset: frames(durationFrames - half),
  };

  const newItems = [...track.items];
  newItems.splice(itemIndex + 1, 0, transition);

  return [
    { op: 'remove_track', trackId: track.id },
    { op: 'add_track', track: { ...track, items: newItems }, at: trackIndex },
  ];
}

export function removeTransitionOps(
  timeline: Timeline,
  trackId: string,
  transitionId: string,
): EditOp[] {
  const trackIndex = timeline.tracks.findIndex((t) => t.id === trackId);
  if (trackIndex === -1) return [];
  const track = timeline.tracks[trackIndex];
  const newItems = track.items.filter((i) => i.id !== transitionId);

  return [
    { op: 'remove_track', trackId: track.id },
    { op: 'add_track', track: { ...track, items: newItems }, at: trackIndex },
  ];
}

