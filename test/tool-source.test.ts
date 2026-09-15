/**
 * Pointing a pipeline tool at something, and putting what it returns back.
 *
 * Two arithmetic traps live here and both survive a green typecheck.
 *
 * A pipeline reads one file and returns times in THAT FILE's seconds. The
 * timeline counts frames from its own zero, and the clip in between may start
 * partway into its media and sit anywhere on the track. A marker placed
 * without both corrections lands somewhere plausible and wrong.
 *
 * And "the whole timeline" is not one file the moment there are two of them.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RATES, frames, timeRange, type Frames } from '../lib/time/frames.ts';
import { emptyTimeline, findTrack, placeTrack, isClip } from '../lib/timeline/document.ts';
import { applyEdits } from '../lib/timeline/edits.ts';
import type { Clip, MediaRef, PlacedItem, Timeline } from '../lib/timeline/types.ts';
import { resolveToolSource, isRefusal } from '../lib/tools/source.ts';
import { readBrollPlan, brollMarkerOps, brollSummary, markerName } from '../lib/tools/broll-plan.ts';

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

describe('reading the plan the pipeline returns', () => {
  const PLAN = { broll: [{ start: 10, end: 13, duration: 3, scene: 'a workshop bench' }], count: 1, dropped: 2, dropped_reasons: ['confidence'] };

  test('it is read whether it arrives as JSON text or as an object', () => {
    for (const raw of [PLAN, JSON.stringify(PLAN)]) {
      const plan = readBrollPlan(raw);
      assert.ok(plan, 'both shapes come back from runs');
      assert.equal(plan.broll.length, 1);
      assert.equal(plan.dropped, 2);
    }
  });

  test('no plan at all is not an empty plan', () => {
    // "the pipeline returned nothing" and "the pipeline planned nothing" are
    // different answers and only one of them means the tool worked
    for (const junk of [null, undefined, '', 'not json', {}, { broll: 'soon' }, 42]) {
      assert.equal(readBrollPlan(junk), null, `${JSON.stringify(junk)} is not a plan`);
    }
    assert.deepEqual(readBrollPlan({ broll: [] })?.broll, [], 'but an empty list is');
  });

  test('an entry with no times is dropped rather than placed at zero', () => {
    const plan = readBrollPlan({ broll: [{ scene: 'no times' }, { start: 1, end: 2 }] });
    assert.equal(plan?.broll.length, 1);
  });
});

describe('the plan lands on the timeline where the words actually are', () => {
  const ids = (i: number) => `mrk_${i}`;

  test('source seconds become timeline frames through the clip, both corrections applied', () => {
    const doc = oneSource();           // clip at frame 240, from source frame 120
    const target = placedOf(doc, 'trk_v1');
    // 10s into the SOURCE is source frame 240, which is 120 frames into the
    // clip, which is timeline frame 360. Not 240, and not 240 + 240.
    const plan = readBrollPlan({ broll: [{ start: 10, end: 13, scene: 'bench' }] })!;
    const { ops, placed, outside } = brollMarkerOps(plan, target, R, ids);
    assert.equal(placed, 1);
    assert.equal(outside, 0);

    const after = applyEdits(doc, ops).timeline;
    assert.equal(after.markers.length, 1, 'assert on the document, not on the ops');
    assert.equal(after.markers[0].at, 360);
    assert.equal(after.markers[0].name, 'bench');
  });

  test('a cutaway before the clip s in point is skipped, never clamped to its head', () => {
    const doc = oneSource();           // the clip starts at source frame 120, which is 5s
    const target = placedOf(doc, 'trk_v1');
    const plan = readBrollPlan({ broll: [{ start: 1, end: 3 }, { start: 10, end: 12 }] })!;
    const { ops, placed, outside } = brollMarkerOps(plan, target, R, ids);
    assert.equal(placed, 1);
    assert.equal(outside, 1, 'a marker pinned to the head is a lie about where the cutaway goes');

    const after = applyEdits(doc, ops).timeline;
    assert.deepEqual(after.markers.map((m) => m.at), [360]);
  });

  test('a cutaway past the clip s out point is skipped too', () => {
    const doc = oneSource();           // 480 frames used, so source 120..600, which is 5s..25s
    const target = placedOf(doc, 'trk_v1');
    const plan = readBrollPlan({ broll: [{ start: 400, end: 403 }] })!;
    const { placed, outside } = brollMarkerOps(plan, target, R, ids);
    assert.equal(placed, 0);
    assert.equal(outside, 1);
  });

  test('every marker the plan produced survives being applied', () => {
    const doc = oneSource();
    const target = placedOf(doc, 'trk_v1');
    const plan = readBrollPlan({
      broll: [
        { start: 6, end: 9, scene: 'one' },
        { start: 14, end: 17, scene: 'two' },
        { start: 22, end: 25, scene: 'three' },
      ],
    })!;
    const { ops } = brollMarkerOps(plan, target, R, ids);
    const after = applyEdits(doc, ops).timeline;
    assert.equal(after.markers.length, 3, 'three ops that apply, not three ops that look right');
    assert.deepEqual(after.markers.map((m) => m.name), ['one', 'two', 'three']);
    // starts must not go backwards once mapped
    const at = after.markers.map((m) => m.at);
    assert.deepEqual([...at].sort((a, b) => a - b), at);
  });

  test('a marker is named for the scene, falling back to the words, then to a number', () => {
    assert.equal(markerName({ start: 0, end: 1, scene: 'a bench' }, 0), 'a bench');
    assert.equal(markerName({ start: 0, end: 1, quote: 'we built it by hand' }, 0), 'we built it by hand');
    assert.equal(markerName({ start: 0, end: 1 }, 2), 'B-roll 3');
  });

  test('the summary tells the difference between declining and failing', () => {
    assert.match(brollSummary(readBrollPlan({ broll: [] })!, 0, 0), /found nothing/);
    assert.match(
      brollSummary(readBrollPlan({ broll: [], dropped: 4, dropped_reasons: ['confidence'] })!, 0, 0),
      /4 dropped/,
    );
    assert.match(brollSummary(readBrollPlan({ broll: [{ start: 1, end: 2 }] })!, 1, 0), /1 cutaway marked/);
    assert.match(brollSummary(readBrollPlan({ broll: [{ start: 1, end: 2 }] })!, 1, 2), /2 outside/);
  });
});
