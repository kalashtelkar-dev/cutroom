/**
 * Which frame the program monitor shows.
 *
 * The bug this guards: painting the TIMELINE frame number instead of the
 * SOURCE frame number. A clip trimmed to start at source frame 300 and placed
 * at timeline frame 0 would show the head of the file, so the player showed a
 * different part of the video than the timeline said was under the playhead.
 * That is precisely what "the player shows old data" looked like.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { frameKeyAt } from '../lib/media/frameAt.ts';
import { frames, timeRange, type Frames } from '../lib/time/frames.ts';
import type { MediaRef } from '../lib/timeline/types.ts';

const F = (n: number): Frames => frames(n);

const media = (over: Partial<MediaRef> = {}): MediaRef => ({
  key: 'obj/a.mp4',
  name: 'a.mp4',
  kind: 'video',
  available: timeRange(F(0), F(800)),
  frames: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'],
  ...over,
});

describe('the program monitor picks the frame nearest the source position', () => {
  test('the start of the media is the first extracted frame', () => {
    assert.equal(frameKeyAt(media(), 0), 'f0');
  });

  test('the end of the media is the last one', () => {
    assert.equal(frameKeyAt(media(), 800), 'f7');
  });

  test('the middle is the middle', () => {
    assert.equal(frameKeyAt(media(), 400), 'f4');
  });

  test('a still has one frame and it is that frame everywhere', () => {
    const still = media({ kind: 'image', frames: ['only'], available: timeRange(F(0), F(120)) });
    assert.equal(frameKeyAt(still, 0), 'only');
    assert.equal(frameKeyAt(still, 60), 'only');
    assert.equal(frameKeyAt(still, 119), 'only');
  });

  test('no extracted frames means NO frame, never an invented one', () => {
    assert.equal(frameKeyAt(media({ frames: [] }), 100), null);
    assert.equal(frameKeyAt(media({ frames: undefined }), 100), null);
  });

  test('a position past either end clamps rather than reading off the array', () => {
    assert.equal(frameKeyAt(media(), -500), 'f0');
    assert.equal(frameKeyAt(media(), 99999), 'f7');
  });

  test('media that does not start at zero is measured from its own start', () => {
    const m = media({ available: timeRange(F(240), F(800)) });
    assert.equal(frameKeyAt(m, 240), 'f0', 'the start of the media is not the start of the timeline');
    assert.equal(frameKeyAt(m, 1040), 'f7');
  });
});
