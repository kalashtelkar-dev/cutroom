/**
 * Which element in the program monitor is allowed to make a sound.
 *
 * A picture layer streams a proxy that still carries the file's own audio, and
 * the drop that placed that file also laid its audio onto an audio track. The
 * same sound therefore exists twice in the monitor and one of the two has to
 * be silent. The rule is the one an NLE lives by: you hear the audio tracks.
 * A timeline that has audio tracks decides its sound there, and the picture is
 * muted, whatever is or is not under the playhead.
 *
 * The bug this is written against: the picture was muted only while an audio
 * clip sat under the playhead. Unlink the audio, slide it later to delay it,
 * and the gap it leaves at the head unmuted the picture, which then played the
 * sound that had just been moved out of that stretch of timeline. The delay
 * looked like it did nothing. The decision cannot be a function of the
 * playhead frame, because the question is where a file's sound lives, not what
 * is under the cursor right now.
 *
 * The source monitor looks like an exception and is not one: it has no tracks,
 * so there is nowhere else for its sound to come from and it plays its own.
 * That is why the flag travels on the layer rather than being read off the
 * timeline in here.
 */

import type { Timeline } from '../../lib/timeline/types.ts';

/**
 * Whether this timeline keeps its sound on audio tracks.
 *
 * An empty audio track counts. It is having somewhere for sound to live that
 * settles the question, not whether a clip happens to be sitting under the
 * playhead: a track that is empty at frame 0 and full at frame 100 must not
 * change what the picture does at frame 0. That conditional is the whole bug.
 */
export function timelineHasAudioTracks(timeline: Pick<Timeline, 'tracks'>): boolean {
  return timeline.tracks.some((t) => t.kind === 'audio');
}

export interface LayerSound {
  /** Stacking order. Only the bottom picture layer was ever a candidate. */
  z: number;
  /** False when the track is off, muted, or losing to another track's solo. */
  trackAudible?: boolean;
  /** True when this layer's sound belongs to the audio tracks instead. */
  soundOnAudioTracks?: boolean;
}

/** Whether a picture element plays silent. */
export function layerMuted({ z, trackAudible, soundOnAudioTracks }: LayerSound): boolean {
  if (z > 0) return true;
  if (trackAudible === false) return true;
  return soundOnAudioTracks === true;
}
