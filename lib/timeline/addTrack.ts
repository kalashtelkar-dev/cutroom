/**
 * Where a new track goes, and what it is called.
 *
 * Both were wrong when this was a line in the page: `add_track` appended, so a
 * new video track landed at the BOTTOM of the array, which is below the audio
 * tracks and therefore in the audio section of the timeline. It was reported
 * as exactly that, after deleting V2 and adding a video track back.
 *
 * The array IS the stacking order, index 0 is the topmost lane, and the
 * sections are contiguous: picture, then sound, then subtitles. A track
 * inserted anywhere else does not just look wrong, it puts a picture track
 * under a sound track for the compiler's layering too.
 */
import type { EditOp, Timeline, Track, TrackKind } from './types.ts';

/** Picture on top, sound under it, subtitles last. */
const SECTION: Record<TrackKind, number> = { video: 0, audio: 1, subtitle: 2 };

const LABEL: Record<TrackKind, string> = {
  video: 'Video',
  audio: 'Audio',
  subtitle: 'Subtitles',
};

const PREFIX: Record<TrackKind, string> = { video: 'v', audio: 'a', subtitle: 's' };

/**
 * The index a new track of this kind belongs at.
 *
 * A new picture track goes on TOP of the picture tracks, which is what a
 * video editor means by "add a video track": V3 sits above V2. A new sound
 * track goes at the BOTTOM of the sound tracks, because A1 is the dialogue
 * bed and later tracks are additions under it. Both are Resolve's behaviour.
 */
export function trackInsertIndex(tracks: readonly Track[], kind: TrackKind): number {
  const section = SECTION[kind];

  if (kind === 'video') {
    // above every video track, and above anything that sorts after it
    const first = tracks.findIndex((t) => SECTION[t.kind] >= section);
    return first === -1 ? tracks.length : first;
  }

  // after the last track of this kind, or where the section would start
  let last = -1;
  for (let i = 0; i < tracks.length; i += 1) {
    if (SECTION[tracks[i].kind] <= section) last = i;
  }
  return last + 1;
}

/**
 * The next free number for a kind.
 *
 * Counting the tracks is not enough: delete V1 and keep V2 and the count says
 * the next one is 2, which is the name already on screen. The numbers in the
 * existing names decide, so a deleted track's number is reused only once
 * nothing above it is holding it.
 */
export function nextTrackNumber(tracks: readonly Track[], kind: TrackKind): number {
  let highest = 0;
  for (const t of tracks) {
    if (t.kind !== kind) continue;
    const fromName = /(\d+)\s*$/.exec(t.name)?.[1];
    const fromId = /(\d+)$/.exec(t.id)?.[1];
    highest = Math.max(highest, Number(fromName ?? 0) || 0, Number(fromId ?? 0) || 0);
  }
  return highest + 1;
}

/** An id nothing in the document is already using. */
function freeId(timeline: Timeline, kind: TrackKind, n: number): string {
  const taken = new Set(timeline.tracks.map((t) => t.id));
  let id = `trk_${PREFIX[kind]}${n}`;
  for (let bump = 2; taken.has(id); bump += 1) id = `trk_${PREFIX[kind]}${n}_${bump}`;
  return id;
}

export function addTrackOp(timeline: Timeline, kind: TrackKind): EditOp {
  const n = nextTrackNumber(timeline.tracks, kind);
  return {
    op: 'add_track',
    at: trackInsertIndex(timeline.tracks, kind),
    track: {
      id: freeId(timeline, kind, n),
      kind,
      name: `${LABEL[kind]} ${n}`,
      locked: false,
      muted: false,
      solo: false,
      enabled: true,
      autoSelect: true,
    },
  };
}
