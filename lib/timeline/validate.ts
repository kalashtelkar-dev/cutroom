/**
 * What is wrong with this timeline.
 *
 * Everything here is checked before a compile rather than after a render,
 * because the failures it catches are the ones that cost money: a clip
 * trimmed past the end of its source is a black frame or an ffmpeg error
 * twenty minutes into a job, and a source at 25fps in a 24fps document is a
 * gradual drift that only shows up against sync sound.
 *
 * The overlap check is different in kind from the rest. Two clips cannot
 * overlap on one track by construction, because a position is the sum of the
 * durations before it, so this is an assertion of that invariant rather than
 * a check on user input. It can only fire if a duration went negative and
 * walked the cursor backwards, which is exactly the corruption worth shouting
 * about, and it comes from a wire document rather than from `applyEdits`.
 */
import { rangeEnd, rateEquals, rateLabel, type Frames } from '../time/frames.ts';
import { itemDuration } from './document.ts';
import type { Timeline, TimelineProblem, TrackItem } from './types.ts';

/**
 * A whole number of frames, at least zero. A fractional duration is reported
 * under the same code as a negative one: both are a length that the model
 * cannot represent, and both arrived the same way, from a document written by
 * something that thought in seconds.
 */
const badDuration = (value: Frames): boolean => !Number.isInteger(value) || value < 0;

function itemProblem(item: TrackItem, trackId: string): TimelineProblem | null {
  if (item.kind === 'transition') {
    // the offset is carried next to its name rather than tested by value:
    // `badDuration` is true of a missing offset, and a search that answered
    // with the offending value would answer `undefined` for exactly that case
    // and be read back as "nothing was wrong"
    const offsets: Array<[string, Frames]> = [['in', item.inOffset], ['out', item.outOffset]];
    const bad = offsets.find(([, value]) => badDuration(value));
    if (!bad) return null;
    return {
      code: 'negative_duration',
      trackId,
      message: `transition "${item.id}" has an ${bad[0]}-offset of ${bad[1]} frames, which is not a length`,
    };
  }
  const duration = itemDuration(item);
  if (badDuration(duration)) {
    return {
      code: 'negative_duration',
      trackId,
      ...(item.kind === 'clip' ? { clipId: item.id } : {}),
      message: `${item.kind} "${item.id}" is ${duration} frames long, which is not a length`,
    };
  }
  // the in-point is a frame in the media, and a wire document written by
  // something that thought in seconds lands between two of them. It survives
  // every other check here and then cannot be read back after a save.
  if (item.kind === 'clip' && badDuration(item.sourceRange.start)) {
    return {
      code: 'negative_duration',
      trackId,
      clipId: item.id,
      message: `clip "${item.id}" starts at source frame ${item.sourceRange.start}, which is not a frame`,
    };
  }
  return null;
}

export function validateTimeline(timeline: Timeline): TimelineProblem[] {
  const problems: TimelineProblem[] = [];
  const seen = new Set<string>();

  const claim = (id: string, what: string, trackId?: string, clipId?: string) => {
    if (seen.has(id)) {
      problems.push({
        code: 'duplicate_id',
        ...(trackId ? { trackId } : {}),
        ...(clipId ? { clipId } : {}),
        message: `id "${id}" is used by more than one ${what}: ids address edits, so a duplicate makes an edit ambiguous`,
      });
    }
    seen.add(id);
  };

  for (const track of timeline.tracks) {
    claim(track.id, 'track', track.id);

    // positions are walked here rather than taken from `placeTrack`, which
    // builds a TimeRange and would throw on the corrupt document this
    // function exists to describe
    let cursor = 0;
    // the invariant: a clip never starts before the previous clip has ended
    let reach: number | null = null;

    for (const item of track.items) {
      claim(item.id, 'item', track.id, item.kind === 'clip' ? item.id : undefined);

      const bad = itemProblem(item, track.id);
      if (bad) problems.push(bad);

      const start = cursor;
      cursor += itemDuration(item);

      if (item.kind !== 'clip') continue;

      if (reach !== null && start < reach) {
        problems.push({
          code: 'overlap',
          trackId: track.id,
          clipId: item.id,
          message: `clip "${item.id}" starts at frame ${start}, before frame ${reach} where the previous clip ends: one of the durations before it is not a real length`,
        });
      }
      reach = Math.max(reach ?? 0, cursor);

      const media = timeline.media[item.mediaKey];
      if (!media) {
        problems.push({
          code: 'missing_media',
          trackId: track.id,
          clipId: item.id,
          message: `clip "${item.name}" wants media "${item.mediaKey}", which is not in this timeline`,
        });
        continue;
      }

      const src = item.sourceRange;
      // half-open on both sides, so `rangeEnd` is one past the last frame of
      // each: a clip whose end equals the media's end uses every frame that
      // exists and is fine, and only one that reaches further is not
      if (src.start < media.available.start || rangeEnd(src) > rangeEnd(media.available)) {
        problems.push({
          code: 'past_media_end',
          trackId: track.id,
          clipId: item.id,
          message: `clip "${item.name}" uses source [${src.start}, ${rangeEnd(src)}) of "${media.name}", which only has [${media.available.start}, ${rangeEnd(media.available)})`,
        });
      }

      if (media.rate && !rateEquals(media.rate, timeline.rate)) {
        problems.push({
          code: 'mixed_rates',
          trackId: track.id,
          clipId: item.id,
          message: `"${media.name}" is ${rateLabel(media.rate)} in a ${rateLabel(timeline.rate)} timeline: conform it or the cut drifts`,
        });
      }
    }
  }

  for (const marker of timeline.markers) {
    claim(marker.id, 'marker');
    if (!Number.isInteger(marker.at) || marker.at < 0) {
      problems.push({
        code: 'negative_duration',
        message: `marker "${marker.name}" is at frame ${marker.at}, which is not a frame`,
      });
    }
  }

  return problems;
}
