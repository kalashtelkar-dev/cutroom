/**
 * The program monitor's sound, and the bug of hearing audio from a stretch of
 * timeline that has no audio clip in it.
 *
 * Split the A/V of a clip, slide the audio later to delay it, and the head of
 * the timeline now has picture and no sound. The picture element is streaming
 * a proxy that still carries the file's own audio, so something has to keep it
 * quiet. It used to be kept quiet only while an audio clip sat under the
 * playhead, which is exactly the frames the gap does not have: across the gap
 * the picture unmuted and played the sound that had just been moved out of it,
 * and the delay sounded like it had done nothing.
 *
 * So the assertion with teeth here is not the truth table, it is that the
 * answer does not move as the playhead crosses the gap.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RATES, frames, timeRange, type Frames } from '../lib/time/frames.ts';
import { emptyTimeline, findTrack, isClip, itemAt } from '../lib/timeline/document.ts';
import { applyEdits } from '../lib/timeline/edits.ts';
import type { Clip, MediaRef, Timeline } from '../lib/timeline/types.ts';
import { layerMuted, timelineHasAudioTracks } from '../components/viewer/sound.ts';

const R = RATES.film;
const f = frames;

const VIDEO_AT = 0;
const VIDEO_LEN = 240;
/** The delay. The head of the timeline is picture with no sound on it. */
const AUDIO_AT = 48;

const media = (key: string, duration: number, kind: MediaRef['kind']): MediaRef =>
  ({ key, name: key.split('/').pop() ?? key, kind, available: timeRange(f(0), f(duration)) });

const clip = (id: string, mediaKey: string, duration: number): Clip => ({
  id, kind: 'clip', name: id, mediaKey,
  sourceRange: timeRange(f(0), f(duration)),
  enabled: true, effects: [],
});

/** One file, unlinked, its audio slid `AUDIO_AT` frames later than its picture. */
function delayedAudio(): Timeline {
  const doc = emptyTimeline('tl_s', 'Sound', R);
  doc.media = { 'm/take.mp4': media('m/take.mp4', VIDEO_LEN, 'video') };
  return applyEdits(doc, [
    { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_v', 'm/take.mp4', VIDEO_LEN), at: f(VIDEO_AT) },
    { op: 'add_clip', trackId: 'trk_a1', clip: clip('clp_a', 'm/take.mp4', VIDEO_LEN), at: f(AUDIO_AT) },
  ]).timeline;
}

/**
 * Whether an audio clip actually sounds at this frame. The delay is stored as
 * a gap item, not as an absence, so `itemAt` answers with something either
 * way and only `isClip` tells the two apart. That distinction is the one the
 * viewer makes when it decides whether to mount an audio element.
 */
function audioSoundsAt(t: Timeline, trackId: string, at: Frames): boolean {
  const placed = itemAt(findTrack(t, trackId)!, at);
  return !!placed && isClip(placed.item) && placed.item.enabled;
}

const withoutAudioTracks = (t: Timeline): Timeline =>
  ({ ...t, tracks: t.tracks.filter((tr) => tr.kind !== 'audio') });

describe('a delayed audio clip silences the picture across the gap it leaves', () => {
  test('the gap is really there, on both sides of the cut', () => {
    const doc = delayedAudio();
    const v1 = findTrack(doc, 'trk_v1')!;

    // a comparison of nothing passes: prove the fixture has the shape the rest
    // of this file is arguing about before arguing about it
    assert.equal(audioSoundsAt(doc, 'trk_a1', f(12)), false, 'the head of A1 must be silent for this test to mean anything');
    assert.equal(audioSoundsAt(doc, 'trk_a1', f(AUDIO_AT + 12)), true, 'and the audio clip must sound further in');
    assert.ok(itemAt(v1, f(12)), 'the picture runs across the gap');
  });

  test('the picture is muted at every frame, gap included', () => {
    const doc = delayedAudio();
    const soundOnAudioTracks = timelineHasAudioTracks(doc);

    let inGap = 0;
    let overAudio = 0;
    for (let at = 0; at < VIDEO_AT + VIDEO_LEN; at += 1) {
      if (audioSoundsAt(doc, 'trk_a1', f(at))) overAudio += 1; else inGap += 1;
      assert.equal(
        layerMuted({ z: 0, trackAudible: true, soundOnAudioTracks }),
        true,
        `the picture made a sound at frame ${at}`,
      );
    }
    assert.ok(inGap > 0, 'no frames without audio under them: the fixture proves nothing');
    assert.ok(overAudio > 0, 'no frames with audio under them: the fixture proves nothing');
  });

  test('the rule cannot be asked about a frame at all', () => {
    // the old bug was a function of the playhead. This one takes tracks and
    // nothing else, which is why it cannot come back the same way.
    const doc = delayedAudio();
    assert.equal(timelineHasAudioTracks(doc), true);
    assert.equal(timelineHasAudioTracks.length, 1, 'one argument, and it is not a frame');
  });

  test('an audio track with nothing on it still owns the sound', () => {
    const empty = emptyTimeline('tl_e', 'Empty', R);
    const a1 = findTrack(empty, 'trk_a1')!;
    assert.equal(a1.items.length, 0, 'expected an empty audio track to test with');
    assert.equal(timelineHasAudioTracks(empty), true);
  });
});

describe('what is still allowed to make a sound', () => {
  test('a timeline with no audio track at all leaves the bottom picture audible', () => {
    const doc = withoutAudioTracks(delayedAudio());
    assert.ok(doc.tracks.length > 0, 'expected video tracks to survive the filter');
    assert.equal(timelineHasAudioTracks(doc), false);
    assert.equal(
      layerMuted({ z: 0, trackAudible: true, soundOnAudioTracks: timelineHasAudioTracks(doc) }),
      false,
      'nowhere else for the sound to live, so the picture carries it',
    );
  });

  test('the source monitor plays its own sound: it has no tracks', () => {
    assert.equal(layerMuted({ z: 0, trackAudible: true, soundOnAudioTracks: false }), false);
  });

  test('only the bottom layer was ever a candidate', () => {
    assert.equal(layerMuted({ z: 1, trackAudible: true, soundOnAudioTracks: false }), true);
    assert.equal(layerMuted({ z: 2, trackAudible: true, soundOnAudioTracks: false }), true);
  });

  test('a muted or soloed-out track is silent whatever the audio tracks say', () => {
    assert.equal(layerMuted({ z: 0, trackAudible: false, soundOnAudioTracks: false }), true);
    assert.equal(layerMuted({ z: 0, trackAudible: false, soundOnAudioTracks: true }), true);
  });
});
