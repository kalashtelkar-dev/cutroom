/**
 * Subtitles as timeline items.
 *
 * The bug these exist over: a transcription finished, an empty subtitle track
 * was added, and nothing ever put the words on it. The job said "done" and the
 * timeline was empty, which is the worst kind of success.
 *
 * Every placement test asserts on the document that comes out of `applyEdits`,
 * not on the ops: two op builders have shipped past a green suite in this repo
 * producing batches that corrupt or throw.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { RATES, frames, timeRange } from '../lib/time/frames.ts';
import { emptyTimeline, place, placeTrack, findTrack, trackDuration } from '../lib/timeline/document.ts';
import { applyEdits, EditError } from '../lib/timeline/edits.ts';
import { fromOtio, toOtio } from '../lib/timeline/otio.ts';
import { parseSrt, toSrt, stampOf, SrtError } from '../lib/subtitles/srt.ts';
import {
  captionAt, cuesOf, placeCuesOps, placeSrtOps, subtitleTrack, timelineSrt,
} from '../lib/subtitles/place.ts';
import type { Caption, Timeline } from '../lib/timeline/types.ts';

const R = RATES.film;            // 24fps, so a second is 24 frames
const f = frames;

/** What whisperx actually writes, down to the comma and the CRLF. */
const REAL_SRT = '1\r\n00:00:01,000 --> 00:00:02,500\r\nHello there\r\n\r\n'
  + '2\r\n00:00:03,000 --> 00:00:05,000\r\nSecond line\r\nover two rows\r\n\r\n';

function withSubtitleTrack(): Timeline {
  const t = emptyTimeline('tl_1', 'Test', R);
  return applyEdits(t, [{
    op: 'add_track',
    at: 0,
    track: {
      id: 'trk_s1', kind: 'subtitle', name: 'Subtitles 1',
      locked: false, muted: false, solo: false, enabled: true, autoSelect: true,
    },
  }]).timeline;
}

describe('reading SRT', () => {
  test('real whisperx output, CRLF and all', () => {
    const cues = parseSrt(REAL_SRT, R);
    assert.equal(cues.length, 2);
    // 1.000s is frame 24, 2.500s is frame 60: half open, so 36 frames
    assert.deepEqual(cues[0], { start: 24, duration: 36, text: 'Hello there' });
    assert.deepEqual(cues[1], { start: 72, duration: 48, text: 'Second line\nover two rows' });
  });

  test('the end is exclusive, so touching cues do not overlap by a frame', () => {
    const cues = parseSrt(
      '1\n00:00:00,000 --> 00:00:01,000\na\n\n2\n00:00:01,000 --> 00:00:02,000\nb\n',
      R,
    );
    assert.equal(cues[0].start + cues[0].duration, cues[1].start);
  });

  test('a BOM, a missing index and a dot for milliseconds all read', () => {
    const cues = parseSrt('﻿00:00:01.500 --> 00:00:02.000\nfine\n', R);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].text, 'fine');
  });

  test('a cue with no words is dropped rather than made into a silent block', () => {
    assert.deepEqual(parseSrt('1\n00:00:01,000 --> 00:00:02,000\n\n', R), []);
  });

  test('a cue too short to be a frame is dropped, not rounded to zero length', () => {
    // 10ms at 24fps rounds to the same frame at both ends
    assert.deepEqual(parseSrt('1\n00:00:01,000 --> 00:00:01,010\nblink\n', R), []);
  });

  test('a cue that ends before it starts is an error, not a negative duration', () => {
    assert.throws(
      () => parseSrt('1\n00:00:05,000 --> 00:00:02,000\nbackwards\n', R),
      (e: unknown) => e instanceof SrtError,
    );
  });

  test('cues out of order come back in order', () => {
    const cues = parseSrt(
      '1\n00:00:05,000 --> 00:00:06,000\nsecond\n\n2\n00:00:01,000 --> 00:00:02,000\nfirst\n',
      R,
    );
    assert.deepEqual(cues.map((c) => c.text), ['first', 'second']);
  });

  test('nothing in, nothing out', () => {
    assert.deepEqual(parseSrt('', R), []);
    assert.deepEqual(parseSrt('WEBVTT\n\n', R), []);
  });
});

describe('writing SRT', () => {
  test('a round trip through the file changes nothing', () => {
    const cues = parseSrt(REAL_SRT, R);
    assert.deepEqual(parseSrt(toSrt(cues, R), R), cues);
  });

  test('a stamp is the frame it is, at the rate it is', () => {
    assert.equal(stampOf(f(0), R), '00:00:00,000');
    assert.equal(stampOf(f(24), R), '00:00:01,000');
    assert.equal(stampOf(f(24 * 60 * 60), R), '01:00:00,000');
  });

  test('a rate that is not a whole number still round trips', () => {
    const cues = parseSrt(REAL_SRT, RATES.ntscFilm);
    assert.deepEqual(parseSrt(toSrt(cues, RATES.ntscFilm), RATES.ntscFilm), cues);
  });
});

describe('putting cues on the timeline', () => {
  test('the words are on the track, at the right frames', () => {
    const before = withSubtitleTrack();
    const { ops, cues } = placeSrtOps(before, REAL_SRT, R);
    assert.equal(cues.length, 2);

    const { timeline } = applyEdits(before, ops);
    const placed = placeTrack(findTrack(timeline, 'trk_s1')!).filter((p) => p.item.kind === 'caption');
    assert.equal(placed.length, 2);
    assert.equal(placed[0].range.start, 24);
    assert.equal(placed[0].range.duration, 36);
    assert.equal((placed[0].item as Caption).text, 'Hello there');
    assert.equal(placed[1].range.start, 72);
  });

  test('cues land at absolute times, so a gap between them does not accumulate', () => {
    // the bug this guards: inserting rather than overwriting pushes every
    // later cue along by the length of the one before it
    const before = withSubtitleTrack();
    const { ops } = placeSrtOps(before, REAL_SRT, R);
    const { timeline } = applyEdits(before, ops);
    const cues = cuesOf(timeline);
    assert.deepEqual(cues.map((c) => c.start), [24, 72]);
  });

  test('one undo takes the whole transcription back off', () => {
    const before = withSubtitleTrack();
    const { ops } = placeSrtOps(before, REAL_SRT, R);
    const { timeline, inverse } = applyEdits(before, ops);
    assert.equal(cuesOf(timeline).length, 2);
    const back = applyEdits(timeline, inverse).timeline;
    assert.equal(cuesOf(back).length, 0);
    assert.equal(trackDuration(findTrack(back, 'trk_s1')!), 0);
  });

  test('running it twice replaces, it does not stack', () => {
    const before = withSubtitleTrack();
    const once = applyEdits(before, placeSrtOps(before, REAL_SRT, R).ops).timeline;
    const twice = applyEdits(once, placeSrtOps(once, REAL_SRT, R).ops).timeline;
    assert.equal(cuesOf(twice).length, 2, 'two runs, two cues, not four');
  });

  test('an empty transcript leaves what is already there alone', () => {
    const before = withSubtitleTrack();
    const withCues = applyEdits(before, placeSrtOps(before, REAL_SRT, R).ops).timeline;
    const { ops, cues } = placeSrtOps(withCues, '', R);
    assert.deepEqual(cues, []);
    assert.deepEqual(ops, [], 'silence must not wipe subtitles somebody already had');
  });

  test('an offset moves everything, for a clip that does not start at zero', () => {
    const before = withSubtitleTrack();
    const { ops } = placeSrtOps(before, REAL_SRT, R, { offset: f(48) });
    const timeline = applyEdits(before, ops).timeline;
    assert.deepEqual(cuesOf(timeline).map((c) => c.start), [72, 120]);
  });

  test('a project with no subtitle track says so instead of guessing a track', () => {
    const t = emptyTimeline('tl_x', 'No subs', R);
    assert.throws(() => placeCuesOps(t, [{ start: f(0), duration: f(24), text: 'hi' }]), /no subtitle track/);
  });

  test('a caption with no words is refused by the document', () => {
    const before = withSubtitleTrack();
    assert.throws(
      () => applyEdits(before, [{
        op: 'add_caption',
        trackId: 'trk_s1',
        at: f(0),
        caption: { id: 'cap_x', kind: 'caption', text: '   ', duration: f(24), enabled: true },
      }]),
      (e: unknown) => e instanceof EditError,
    );
  });
});

describe('reading the timeline back', () => {
  const built = () => {
    const before = withSubtitleTrack();
    return applyEdits(before, placeSrtOps(before, REAL_SRT, R).ops).timeline;
  };

  test('the caption under the playhead, half open at both ends', () => {
    const t = built();
    assert.equal(captionAt(t, f(23)), null, 'a frame before the first cue');
    assert.equal(captionAt(t, f(24))?.text, 'Hello there');
    assert.equal(captionAt(t, f(59))?.text, 'Hello there', 'the last frame it covers');
    assert.equal(captionAt(t, f(60)), null, 'the end is exclusive');
    assert.equal(captionAt(t, f(72))?.text, 'Second line\nover two rows');
  });

  test('a disabled caption is not on screen', () => {
    const t = built();
    const id = cuesOf(t).length ? placeTrack(findTrack(t, 'trk_s1')!)
      .find((p) => p.item.kind === 'caption')!.item.id : '';
    const off = applyEdits(t, [{ op: 'patch_caption', captionId: id, set: { enabled: false } }]).timeline;
    assert.equal(captionAt(off, f(30)), null);
  });

  test('a disabled track takes its captions off screen with it', () => {
    const t = built();
    const off = applyEdits(t, [{ op: 'patch_track', trackId: 'trk_s1', set: { enabled: false } }]).timeline;
    assert.equal(captionAt(off, f(30)), null);
    assert.deepEqual(cuesOf(off), []);
  });

  test('the document writes back the file it was made from', () => {
    assert.deepEqual(parseSrt(timelineSrt(built()), R), parseSrt(REAL_SRT, R));
  });

  test('subtitleTrack refuses a track that is not one', () => {
    const t = built();
    assert.equal(subtitleTrack(t, 'trk_v1'), null);
    assert.equal(subtitleTrack(t, 'trk_s1')?.id, 'trk_s1');
  });
});

describe('captions survive being saved', () => {
  test('a round trip through OTIO keeps the words, the timing and the style', () => {
    const before = withSubtitleTrack();
    const withCues = applyEdits(before, placeSrtOps(before, REAL_SRT, R, {
      style: { place: 'top', size: 42, colour: '#ffcc00', outline: true },
    }).ops).timeline;

    const back = fromOtio(JSON.parse(JSON.stringify(toOtio(withCues))), R);
    assert.deepEqual(back.tracks, withCues.tracks);
  });

  test('a caption read back is a caption, not an empty clip', () => {
    const before = withSubtitleTrack();
    const withCues = applyEdits(before, placeSrtOps(before, REAL_SRT, R).ops).timeline;
    const back = fromOtio(toOtio(withCues), R);
    const items = placeTrack(findTrack(back, 'trk_s1')!).map((p) => p.item.kind);
    assert.ok(items.includes('caption'), `got ${items.join(', ')}`);
    assert.equal(captionAt(back, f(24))?.text, 'Hello there');
  });
});
