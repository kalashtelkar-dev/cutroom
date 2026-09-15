/**
 * Pointing a pipeline tool at something.
 *
 * The trap here survives a green typecheck: "the whole timeline" is not one
 * file the moment there are two of them, and a tool that quietly picks the
 * first has read something the user did not point it at.
 *
 * This file also held the B-roll plan's arithmetic, which went with
 * `lib/tools/broll-plan.ts` when the `broll-b1` card was archived. That
 * arithmetic was the subtle part and is worth reading before Auto B-roll is
 * built again:
 *
 *     git log --diff-filter=D -- lib/tools/broll-plan.ts
 *     git show <that commit>^:lib/tools/broll-plan.ts
 *
 * and not `git show HEAD:...`, which works only until the delete is
 * committed and is exactly the kind of instruction this repo keeps writing
 * down for having given once already.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RATES, frames, timeRange, type Frames } from '../lib/time/frames.ts';
import { emptyTimeline, findTrack, placeTrack, isClip } from '../lib/timeline/document.ts';
import { applyEdits } from '../lib/timeline/edits.ts';
import type { Clip, MediaRef, PlacedItem, Timeline } from '../lib/timeline/types.ts';
import { resolveToolSource, isRefusal } from '../lib/tools/source.ts';

const R = RATES.film;          // 24fps, so a second is exactly 24 frames
const f = frames;

const media = (key: string, over: Partial<MediaRef> = {}): MediaRef => ({
  key, name: `${key}.mp4`, kind: 'video', available: timeRange(f(0), f(2400)), ...over,
});

const clip = (id: string, mediaKey: string, sourceStart: number, duration: number): Clip => ({
  id, kind: 'clip', name: id, mediaKey,
  sourceRange: timeRange(f(sourceStart), f(duration)),
  enabled: true, effects: [],
});

/** V1 holds one clip of `take`, trimmed to start 120 frames into the media. */
function oneSource(): Timeline {
  const doc = emptyTimeline('tl', 'Test', R);
  doc.media = { take: media('take', { proxy: 'output/abc/take.mp4' }) };
  return applyEdits(doc, [
    { op: 'add_clip', trackId: 'trk_v1', clip: clip('c1', 'take', 120, 480), at: f(240) },
  ]).timeline;
}

function twoSources(): Timeline {
  const doc = emptyTimeline('tl', 'Test', R);
  doc.media = { take: media('take'), other: media('other') };
  return applyEdits(doc, [
    { op: 'add_clip', trackId: 'trk_v1', clip: clip('c1', 'take', 0, 240), at: f(0) },
    { op: 'add_clip', trackId: 'trk_v1', clip: clip('c2', 'other', 0, 240), at: f(240) },
  ]).timeline;
}

const placedOf = (t: Timeline, trackId: string, i = 0): PlacedItem => {
  const track = findTrack(t, trackId)!;
  const p = placeTrack(track).filter((x) => isClip(x.item))[i];
  assert.ok(p, `expected a clip at ${trackId}[${i}]`);
  return p;
};

describe('what a pipeline tool is pointed at', () => {
  test('one video on the timeline is the whole timeline, and the proxy is what is sent', () => {
    const r = resolveToolSource(oneSource(), null, 'Whole timeline');
    assert.ok(!isRefusal(r));
    assert.equal(r.key, 'output/abc/take.mp4', 'the proxy, which the API wrote and can open');
    assert.equal(r.viaProxy, true);
    assert.equal(r.mediaKey, 'take');
  });

  test('with no proxy yet it falls back to the media itself rather than refusing', () => {
    const r = resolveToolSource(twoSources(), placedOf(twoSources(), 'trk_v1'), 'Selected clip, c1');
    assert.ok(!isRefusal(r));
    assert.equal(r.key, 'take');
    assert.equal(r.viaProxy, false);
  });

  test('a timeline cutting between two files has no single answer, and says which', () => {
    const r = resolveToolSource(twoSources(), null, 'Whole timeline');
    assert.ok(isRefusal(r), 'picking the first would analyse footage nobody pointed at');
    assert.match(r.error, /cuts between 2/);
    assert.match(r.error, /"take\.mp4"/);
    assert.match(r.error, /"other\.mp4"/);
  });

  test('the selected clip with nothing selected is a refusal, not the whole timeline', () => {
    const r = resolveToolSource(oneSource(), null, 'Selected clip (none yet)');
    assert.ok(isRefusal(r), 'falling back would silently run over something else');
    assert.match(r.error, /nothing is selected/);
  });

  test('an empty timeline has nothing to read', () => {
    const r = resolveToolSource(emptyTimeline('tl', 'Empty', R), null, 'Whole timeline');
    assert.ok(isRefusal(r));
    assert.match(r.error, /no video on the timeline/);
  });

  test('both keys for the same footage come back, so a swept proxy is not a lost clip', () => {
    // an upload and a job output expire on their own schedules, and the
    // document names both. Offering only one turns a sweep into "re-import".
    const r = resolveToolSource(oneSource(), null, 'Whole timeline');
    assert.ok(!isRefusal(r));
    assert.equal(r.key, 'output/abc/take.mp4', 'the proxy is tried first');
    assert.equal(r.fallbackKey, 'take', 'and the original is the second chance');
  });

  test('media with no proxy offers no fallback, rather than offering itself twice', () => {
    const doc = twoSources();
    const r = resolveToolSource(doc, placedOf(doc, 'trk_v1'), 'Selected clip, c1');
    assert.ok(!isRefusal(r));
    assert.equal(r.key, 'take');
    assert.equal(r.fallbackKey, undefined, 'checking the same key twice is a wasted job');
  });

  test('the selected clip carries its own source offset, which is not the media start', () => {
    const doc = oneSource();
    const r = resolveToolSource(doc, placedOf(doc, 'trk_v1'), 'Selected clip, c1');
    assert.ok(!isRefusal(r));
    assert.equal(r.sourceOffset, 120, 'the clip starts 120 frames into its media');
  });
});

