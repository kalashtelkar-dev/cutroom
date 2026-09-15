import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planDrop, firstFreeFrom, acceptsMedia, trackAtY, DRAG_TYPE } from '../lib/media/drop.ts';
import { applyEdits } from '../lib/timeline/edits.ts';
import { emptyTimeline, placeTrack } from '../lib/timeline/document.ts';
import { RATES, frames, timeRange, rangeEnd } from '../lib/time/frames.ts';
import type { MediaRef, Timeline } from '../lib/timeline/types.ts';

const media = (key: string, kind: MediaRef['kind'], seconds: number): MediaRef => ({
  key, name: `${key}.mov`, kind,
  available: timeRange(frames(0), frames(Math.round(seconds * 24))),
});

function project(): Timeline {
  const t = emptyTimeline('t', 'T', RATES.film);
  t.media = {
    'm/vid': media('m/vid', 'video', 4),
    'm/snd': media('m/snd', 'audio', 6),
    'm/pic': media('m/pic', 'image', 5),
  };
  return t;
}

let n = 0;
const newId = (p: string) => `${p}_${++n}`;

describe('a drop lands where the pointer was', () => {
  test('on an empty track, exactly there', () => {
    const t = project();
    const plan = planDrop(t, 'trk_v1', frames(100), 'm/vid', newId);
    assert.ok('op' in plan);
    assert.equal(plan.at, 100);
    assert.equal(plan.nudged, false);
    const { timeline } = applyEdits(t, [plan.op]);
    const placed = placeTrack(timeline.tracks.find((x) => x.id === 'trk_v1')!);
    const clip = placed.find((p) => p.item.kind === 'clip')!;
    assert.equal(clip.range.start, 100, 'a gap was inserted so it really starts there');
    assert.equal(clip.range.duration, 96, 'and it is 4 seconds long at 24fps');
  });

  test('the clip uses the whole of the media, which is what dragging a pool item means', () => {
    const t = project();
    const plan = planDrop(t, 'trk_a1', frames(0), 'm/snd', newId);
    assert.ok('op' in plan);
    const { timeline } = applyEdits(t, [plan.op]);
    const clip = placeTrack(timeline.tracks.find((x) => x.id === 'trk_a1')!)[0];
    assert.equal(clip.range.duration, 144);
  });
});

describe('a drop never silently overwrites', () => {
  test('it snaps past whatever is already there', () => {
    let t = project();
    const first = planDrop(t, 'trk_v1', frames(0), 'm/vid', newId);
    assert.ok('op' in first);
    t = applyEdits(t, [first.op]).timeline;

    // dropping into the middle of the clip that is already there
    const second = planDrop(t, 'trk_v1', frames(40), 'm/vid', newId);
    assert.ok('op' in second);
    assert.equal(second.nudged, true, 'and it says so, rather than moving it quietly');
    assert.equal(second.at, 96, 'landing at the end of the one it would have covered');

    const { timeline } = applyEdits(t, [second.op]);
    const clips = placeTrack(timeline.tracks.find((x) => x.id === 'trk_v1')!)
      .filter((p) => p.item.kind === 'clip');
    assert.equal(clips.length, 2, 'both clips survive');
    assert.ok(rangeEnd(clips[0].range) <= clips[1].range.start, 'and they do not overlap');
  });

  test('firstFreeFrom walks past a run of clips, not just the first', () => {
    let t = project();
    for (const at of [0, 96, 192]) {
      const p = planDrop(t, 'trk_v1', frames(at), 'm/vid', newId);
      assert.ok('op' in p);
      t = applyEdits(t, [p.op]).timeline;
    }
    const track = t.tracks.find((x) => x.id === 'trk_v1')!;
    assert.equal(firstFreeFrom(track, frames(10), frames(96)), 288);
  });
});

describe('a drop that cannot work says why', () => {
  test('audio onto a video track is refused with a readable reason', () => {
    const r = planDrop(project(), 'trk_v1', frames(0), 'm/snd', newId);
    assert.ok('error' in r);
    assert.match(r.error, /audio.*video track/);
  });

  test('a locked track refuses', () => {
    const t = project();
    t.tracks = t.tracks.map((x) => (x.id === 'trk_v1' ? { ...x, locked: true } : x));
    const r = planDrop(t, 'trk_v1', frames(0), 'm/vid', newId);
    assert.ok('error' in r);
    assert.match(r.error, /locked/);
  });

  test('media that is not in the pool refuses', () => {
    const r = planDrop(project(), 'trk_v1', frames(0), 'm/nope', newId);
    assert.ok('error' in r);
    assert.match(r.error, /not in the media pool/);
  });

  test('a still is video, so it goes on a video track', () => {
    const t = project();
    assert.equal(acceptsMedia(t.tracks.find((x) => x.id === 'trk_v1')!, t.media['m/pic']), true);
    assert.equal(acceptsMedia(t.tracks.find((x) => x.id === 'trk_a1')!, t.media['m/pic']), false);
  });
});

describe('which lane the pointer is over', () => {
  const boxes = [
    { trackId: 'v2', top: 0, height: 70 },
    { trackId: 'v1', top: 70, height: 70 },
    { trackId: 'a1', top: 140, height: 46 },
  ];
  test('the boundary belongs to the lane below, as a half-open range should', () => {
    assert.equal(trackAtY(boxes, 0), 'v2');
    assert.equal(trackAtY(boxes, 69), 'v2');
    assert.equal(trackAtY(boxes, 70), 'v1');
    assert.equal(trackAtY(boxes, 185), 'a1');
    assert.equal(trackAtY(boxes, 186), null, 'past the last lane is nothing, not the last lane');
  });
});

test('the drag type is specific, so a dragged file does not look like a pool item', () => {
  assert.match(DRAG_TYPE, /^application\/x-cutroom/);
});

test('dropping a video creates both video and audio clips on paired tracks', () => {
  const t = project();
  const plan = planDrop(t, 'trk_v1', frames(0), 'm/vid', newId);
  assert.ok('ops' in plan);
  assert.equal(plan.ops.length, 2, 'emitted video clip and paired audio clip');
  assert.equal(plan.ops[0].op, 'add_clip');
  assert.equal(plan.ops[0].trackId, 'trk_v1');
  assert.equal(plan.ops[1].op, 'add_clip');
  assert.equal(plan.ops[1].trackId, 'trk_a1');
});

