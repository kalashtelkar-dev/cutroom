/**
 * Taking a file back out.
 *
 * These assert on the document that comes out of `applyEdits`, not on the
 * shape of the ops: an op builder that returns plausible-looking ops and
 * produces a broken timeline is the exact defect this repo has shipped twice.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RATES, frames, timeRange } from '../lib/time/frames.ts';
import { emptyTimeline, place, trackDuration, findTrack, isClip } from '../lib/timeline/document.ts';
import { applyEdits, EditError } from '../lib/timeline/edits.ts';
import { mediaUsage, removeMediaOps, removeMediaLabel } from '../lib/timeline/removeMedia.ts';
import type { Clip, MediaRef, Timeline } from '../lib/timeline/types.ts';

const R = RATES.film;
const f = frames;

const media = (key: string, name: string): MediaRef =>
  ({ key, name, kind: 'video', available: timeRange(f(0), f(480)) });

/**
 * A document compared for what it holds, not for how it got there.
 *
 * `revision` counts edits, so an undo is revision n+1 rather than n-1, and a
 * pool is a map whose key order follows insertion. Neither is part of what
 * the user gets back.
 */
const same = (t: Timeline) => ({
  ...t,
  revision: 0,
  media: Object.fromEntries(Object.entries(t.media).sort(([a], [b]) => a.localeCompare(b))),
});

const clip = (id: string, mediaKey: string, duration: number): Clip => ({
  id, kind: 'clip', name: id, mediaKey,
  sourceRange: timeRange(f(0), f(duration)), enabled: true, effects: [],
});

/**
 * V1: a(broll) [0,48), b(main) [48,148).
 * V2: c(broll) [0,60).
 * The pool also holds `unused`, which nothing cuts from.
 */
function project(): Timeline {
  const { timeline } = applyEdits(emptyTimeline('tl_1', 'A cut', R), [
    { op: 'add_media', media: media('input/broll.mp4', 'broll.mp4') },
    { op: 'add_media', media: media('input/main.mp4', 'main.mp4') },
    { op: 'add_media', media: media('input/unused.mp4', 'unused.mp4') },
    { op: 'add_clip', trackId: 'trk_v1', at: f(0), clip: clip('clp_a', 'input/broll.mp4', 48) },
    { op: 'add_clip', trackId: 'trk_v1', at: f(48), clip: clip('clp_b', 'input/main.mp4', 100) },
    { op: 'add_clip', trackId: 'trk_v2', at: f(0), clip: clip('clp_c', 'input/broll.mp4', 60) },
  ]);
  return timeline;
}

describe('what a file would take with it', () => {
  test('usage names every clip, across tracks, in document order', () => {
    const u = mediaUsage(project(), 'input/broll.mp4');
    assert.ok(u);
    assert.deepEqual(u.clips.map((c) => c.item.id), ['clp_c', 'clp_a']);
    assert.deepEqual(u.trackIds, ['trk_v2', 'trk_v1']);
  });

  test('media nothing cuts from reports no clips', () => {
    const u = mediaUsage(project(), 'input/unused.mp4');
    assert.ok(u);
    assert.equal(u.clips.length, 0);
  });

  test('a key not in the pool is null, not an empty usage', () => {
    assert.equal(mediaUsage(project(), 'input/nope.mp4'), null);
  });

  test('the label says what is about to go', () => {
    const p = project();
    assert.equal(removeMediaLabel(mediaUsage(p, 'input/broll.mp4')!), 'Remove broll.mp4 and 2 clips');
    assert.equal(removeMediaLabel(mediaUsage(p, 'input/main.mp4')!), 'Remove main.mp4 and 1 clip');
    assert.equal(removeMediaLabel(mediaUsage(p, 'input/unused.mp4')!), 'Remove unused.mp4');
  });
});

describe('removing a file', () => {
  test('the file and its clips are gone from the document', () => {
    const before = project();
    const { timeline } = applyEdits(before, removeMediaOps(before, 'input/broll.mp4'));

    assert.equal(timeline.media['input/broll.mp4'], undefined);
    const ids = place(timeline).filter((p) => isClip(p.item)).map((p) => p.item.id);
    assert.deepEqual(ids, ['clp_b']);
  });

  test('the rest of the cut does not move', () => {
    const before = project();
    const { timeline } = applyEdits(before, removeMediaOps(before, 'input/broll.mp4'));
    // clp_b was at 48 and stays at 48: removing a file is not a ripple
    const b = place(timeline).find((p) => p.item.id === 'clp_b');
    assert.equal(b?.range.start, 48);
    assert.equal(trackDuration(findTrack(timeline, 'trk_v1')!), 148);
  });

  test('one undo puts the file and every clip back, exactly', () => {
    const before = project();
    const { timeline, inverse } = applyEdits(before, removeMediaOps(before, 'input/broll.mp4'));
    const { timeline: back } = applyEdits(timeline, inverse);
    assert.deepEqual(same(back), same(before));
  });

  test('unused media goes on its own, and comes back on its own', () => {
    const before = project();
    const ops = removeMediaOps(before, 'input/unused.mp4');
    assert.equal(ops.length, 1);
    const { timeline, inverse } = applyEdits(before, ops);
    assert.equal(Object.keys(timeline.media).length, 2);
    assert.deepEqual(same(applyEdits(timeline, inverse).timeline), same(before));
  });

  test('a key not in the pool throws before anything is applied', () => {
    assert.throws(() => removeMediaOps(project(), 'input/nope.mp4'), /no media/);
  });

  test('the batch is atomic: a bad op in it changes nothing', () => {
    const before = project();
    const ops = [...removeMediaOps(before, 'input/broll.mp4'), { op: 'remove_clip' as const, clipId: 'clp_zzz' }];
    assert.throws(() => applyEdits(before, ops), (e: unknown) => e instanceof EditError);
    // the throw is the point: `before` is untouched because the work happened
    // on a clone that was never handed back
    assert.ok(before.media['input/broll.mp4']);
    assert.equal(place(before).filter((p) => isClip(p.item)).length, 3);
  });
});
