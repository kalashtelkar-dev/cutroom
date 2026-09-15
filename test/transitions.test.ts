import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { frames, timeRange, RATES } from '../lib/time/frames.ts';
import { emptyTimeline } from '../lib/timeline/document.ts';
import { applyEdits } from '../lib/timeline/edits.ts';
import { addTransitionOps, removeTransitionOps, TRANSITION_TYPES } from '../lib/timeline/transitions.ts';
import type { Clip, Timeline } from '../lib/timeline/types.ts';

function createSampleTimeline(): Timeline {
  const tl = emptyTimeline('tl_test', 'Transition Test', RATES.film);
  const clip1: Clip = {
    id: 'clp_1',
    kind: 'clip',
    name: 'Clip 1',
    mediaKey: 'm1',
    sourceRange: timeRange(frames(0), frames(48)),
    effects: [],
    enabled: true,
  };
  const clip2: Clip = {
    id: 'clp_2',
    kind: 'clip',
    name: 'Clip 2',
    mediaKey: 'm2',
    sourceRange: timeRange(frames(0), frames(48)),
    effects: [],
    enabled: true,
  };
  tl.media = {
    m1: { key: 'm1', name: 'Media 1', kind: 'video', available: timeRange(frames(0), frames(100)) },
    m2: { key: 'm2', name: 'Media 2', kind: 'video', available: timeRange(frames(0), frames(100)) },
  };
  const res = applyEdits(tl, [
    { op: 'add_clip', trackId: 'trk_v1', clip: clip1, at: frames(0) },
    { op: 'add_clip', trackId: 'trk_v1', clip: clip2, at: frames(48) },
  ]);
  return res.timeline;
}

describe('transitions', () => {
  test('supported transition types are defined', () => {
    assert.ok(TRANSITION_TYPES.length >= 2);
    assert.ok(TRANSITION_TYPES.some((t) => t.id === 'SMPTE_Dissolve'));
  });

  test('addTransitionOps places transition right after the selected clip', () => {
    const tl = createSampleTimeline();
    const ops = addTransitionOps(tl, 'trk_v1', 'clp_1', 'SMPTE_Dissolve', 24);
    assert.ok(ops.length > 0, 'emits edit ops');

    const updated = applyEdits(tl, ops).timeline;
    const track = updated.tracks.find((t) => t.id === 'trk_v1');
    assert.ok(track, 'track exists');

    const transition = track.items.find((i) => i.kind === 'transition');
    assert.ok(transition && transition.kind === 'transition', 'transition placed on track');
    assert.equal(transition.transitionType, 'SMPTE_Dissolve');
    assert.equal(transition.inOffset, frames(12));
    assert.equal(transition.outOffset, frames(12));
  });

  test('removeTransitionOps removes the transition from the track', () => {
    const tl = createSampleTimeline();
    const addOps = addTransitionOps(tl, 'trk_v1', 'clp_1', 'SMPTE_Dissolve', 24);
    const withTransition = applyEdits(tl, addOps).timeline;

    const track = withTransition.tracks.find((t) => t.id === 'trk_v1')!;
    const trn = track.items.find((i) => i.kind === 'transition')!;

    const removeOps = removeTransitionOps(withTransition, 'trk_v1', trn.id);
    const cleaned = applyEdits(withTransition, removeOps).timeline;

    const cleanedTrack = cleaned.tracks.find((t) => t.id === 'trk_v1')!;
    assert.equal(cleanedTrack.items.filter((i) => i.kind === 'transition').length, 0);
    assert.equal(cleanedTrack.items.filter((i) => i.kind === 'clip').length, 2);
  });

  test('transition operations invert cleanly through undo', () => {
    const tl = createSampleTimeline();
    const ops = addTransitionOps(tl, 'trk_v1', 'clp_1', 'SMPTE_Dissolve', 24);
    const result = applyEdits(tl, ops);

    const inverted = applyEdits(result.timeline, result.inverse).timeline;
    const track = inverted.tracks.find((t) => t.id === 'trk_v1')!;
    assert.equal(track.items.filter((i) => i.kind === 'transition').length, 0);
  });
});

