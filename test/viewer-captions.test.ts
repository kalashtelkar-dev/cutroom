/**
 * A caption has to be on screen while the video is PLAYING.
 *
 * The bug these exist over: subtitles were transcribed, placed, drawn by the
 * viewer and visible when you scrubbed, and then invisible the moment you
 * pressed play. Nothing about the caption was wrong. The viewer deliberately
 * does not re-render per frame during playback: a rAF loop compares
 * `activeTimelineSignature` and only tells React the position when that
 * string moves. The signature named every CLIP on screen and no caption, so
 * over a single clip it never moved, `position` stayed where playback began,
 * and `captionAt(timeline, position)` answered with whatever had been on
 * screen at that one frame. Usually nothing.
 *
 * So these assert the signature, not the drawing: the signature is what
 * decides whether the drawing is ever asked for again.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { activeTimelineSignature } from '../components/viewer/onscreen.ts';
import { RATES, frames, timeRange, type Frames } from '../lib/time/frames.ts';
import { emptyTimeline, placeTrack, findTrack } from '../lib/timeline/document.ts';
import { applyEdits } from '../lib/timeline/edits.ts';
import { captionAt } from '../lib/subtitles/place.ts';
import type { Caption, Clip, MediaRef, Timeline } from '../lib/timeline/types.ts';

const R = RATES.film;
const f = frames;

/**
 * Media WITH a proxy, on purpose. A clip whose media has no proxy steps
 * through extracted stills, so its frame key moves and the signature moves
 * with it, which would hide the defect behind the video's own churn. A proxy
 * is the ordinary case and the one where the picture is otherwise still.
 */
const withProxy: MediaRef = {
  key: 'm/a.mp4',
  name: 'a.mp4',
  kind: 'video',
  available: timeRange(f(0), f(480)),
  proxy: 'obj/a-proxy.mp4',
};

const clip = (id: string, duration: number): Clip => ({
  id, kind: 'clip', name: id, mediaKey: withProxy.key,
  sourceRange: timeRange(f(0), f(duration)),
  enabled: true, effects: [],
});

const cue = (id: string, text: string, duration: number): Caption =>
  ({ id, kind: 'caption', text, duration: f(duration), enabled: true });

/**
 * One clip running [0,240), and two cues: "one" over [24,60) and "two" over
 * [72,120). Exactly the shape of a transcribed talking head, which is where
 * this was found.
 */
function fixture(): Timeline {
  const doc = emptyTimeline('tl_1', 'Test', R);
  return applyEdits(doc, [
    { op: 'add_media', media: withProxy },
    {
      op: 'add_track',
      track: {
        id: 'trk_s1', kind: 'subtitle', name: 'Subtitles 1',
        locked: false, muted: false, solo: false, enabled: true, autoSelect: true,
      },
    },
    { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_a', 240), at: f(0) },
    { op: 'add_caption', trackId: 'trk_s1', caption: cue('cap_1', 'one', 36), at: f(24) },
    { op: 'add_caption', trackId: 'trk_s1', caption: cue('cap_2', 'two', 48), at: f(72) },
  ]).timeline;
}

const sig = (t: Timeline, at: number): string => activeTimelineSignature(t, f(at) as Frames);

describe('the fixture is the thing the bug needed', () => {
  test('there are captions to find, and the picture is otherwise still', () => {
    const track = findTrack(fixture(), 'trk_s1')!;
    const caps = placeTrack(track).filter((p) => p.item.kind === 'caption');
    assert.equal(caps.length, 2, 'no captions means every assertion below compares nothing');
    assert.equal(captionAt(fixture(), f(30))?.text, 'one');
    assert.equal(captionAt(fixture(), f(100))?.text, 'two');
    // one clip, one proxy: nothing in the video moves across the whole range
    assert.equal(
      sig(fixture(), 0).includes('clp_a'), true,
      'the video track has to be in the signature, or this proves nothing about captions',
    );
  });
});

describe('the playback loop is told when a caption comes and goes', () => {
  test('a cue arriving moves the signature', () => {
    const t = fixture();
    assert.notEqual(sig(t, 23), sig(t, 24), 'the frame the first cue starts on');
  });

  test('a cue leaving moves it', () => {
    const t = fixture();
    assert.notEqual(sig(t, 59), sig(t, 60), 'the end is exclusive, so 60 is clear');
  });

  test('one cue replacing another moves it', () => {
    const t = fixture();
    assert.notEqual(sig(t, 30), sig(t, 100), 'two different cues are two different pictures');
  });

  test('it does NOT move while one cue is up, so playback is still cheap', () => {
    const t = fixture();
    assert.equal(sig(t, 24), sig(t, 59), 'a re-render per frame is the thing this avoids');
    assert.equal(sig(t, 60), sig(t, 71), 'and the gap between cues is one picture too');
  });

  test('every frame of the run is accounted for, not just the two boundaries', () => {
    const t = fixture();
    const moved: number[] = [];
    for (let at = 1; at <= 240; at++) if (sig(t, at) !== sig(t, at - 1)) moved.push(at);
    // 240 is the end of the clip, not a cue: the run is half-open, so that is
    // the first frame with no picture at all. Its being here is the check that
    // captions were ADDED to the signature rather than put in place of clips.
    assert.deepEqual(moved, [24, 60, 72, 120, 240],
      'the signature moves on cue edges, the clip end, and nowhere else');
  });
});

describe('the signature agrees with what is actually drawn', () => {
  test('a disabled caption is not drawn, so it does not move the signature', () => {
    const t = applyEdits(fixture(), [
      { op: 'patch_caption', captionId: 'cap_1', set: { enabled: false } },
    ]).timeline;
    assert.equal(captionAt(t, f(30)), null, 'captionAt has to agree, or the fix is a wrong one');
    assert.equal(sig(t, 23), sig(t, 30), 'nothing arrived on screen');
  });

  test('a disabled subtitle track is not drawn either', () => {
    const t = applyEdits(fixture(), [
      { op: 'patch_track', trackId: 'trk_s1', set: { enabled: false } },
    ]).timeline;
    assert.equal(captionAt(t, f(30)), null);
    assert.equal(sig(t, 23), sig(t, 30));
  });

  test('editing a cue\'s text changes what is on screen and says so', () => {
    const before = fixture();
    const after = applyEdits(before, [
      { op: 'patch_caption', captionId: 'cap_1', set: { text: 'one, rewritten' } },
    ]).timeline;
    assert.notEqual(sig(before, 30), sig(after, 30));
  });
});

/**
 * House rule 10: a mechanism claimed to be connected gets a test that the
 * connection exists. Everything above passes perfectly well against a module
 * the viewer has stopped importing.
 */
describe('the viewer is the thing using this', () => {
  const src = readFileSync(new URL('../components/viewer/Viewer.tsx', import.meta.url), 'utf8');

  test('Viewer.tsx imports the signature rather than keeping its own', () => {
    assert.match(src, /import\s*\{\s*activeTimelineSignature\s*\}\s*from\s*'\.\/onscreen\.ts'/);
    assert.equal(
      /function\s+activeTimelineSignature/.test(src), false,
      'a second copy in the viewer is the drift this split exists to stop',
    );
  });

  test('the rAF playback loop is still what compares it', () => {
    assert.match(src, /activeTimelineSignature\(timeline,\s*cur\)/);
    assert.match(src, /requestAnimationFrame\(draw\)/);
  });
});
