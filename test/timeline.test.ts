import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATES, frames, timeRange, type Frames,
} from '../lib/time/frames.ts';
import { emptyTimeline, place, placeTrack, trackDuration, findTrack } from '../lib/timeline/document.ts';
import { applyEdits, EditError } from '../lib/timeline/edits.ts';
import { fromOtio, otioRate, toOtio, OtioError, type OtioClip } from '../lib/timeline/otio.ts';
import { validateTimeline } from '../lib/timeline/validate.ts';
import { createHistory, HISTORY_LIMIT } from '../lib/timeline/history.ts';
import type {
  Clip, EditOp, MediaRef, Timeline, Track, TrackItem,
} from '../lib/timeline/types.ts';

const R = RATES.film;
const f = frames;

const media = (key: string, duration: number, kind: MediaRef['kind'] = 'video'): MediaRef =>
  ({ key, name: key.split('/').pop() ?? key, kind, available: timeRange(f(0), f(duration)) });

const clip = (id: string, mediaKey: string, start: number, duration: number): Clip => ({
  id, kind: 'clip', name: id, mediaKey,
  sourceRange: timeRange(f(start), f(duration)),
  enabled: true, effects: [],
});

/**
 * A range as it arrives from the wire, past the constructors that check it.
 * `timeRange` refuses a negative duration and `frames` refuses a fraction, so
 * a document written by something that thought in seconds can only be built
 * this way, which is exactly how it reaches `applyEdits` in production.
 */
const rawRange = (start: number, duration: number) =>
  ({ start: start as Frames, duration: duration as Frames });

/**
 * V1: clp_a [0,100) then clp_b [100,148).  A1: clp_c [0,200).
 * Two markers. Everything else empty.
 */
function base(): Timeline {
  const doc = emptyTimeline('tl_1', 'Test', R);
  doc.media = {
    'm/a.mov': media('m/a.mov', 100),
    'm/b.mov': media('m/b.mov', 200),
    'm/c.wav': media('m/c.wav', 400, 'audio'),
  };
  return applyEdits(doc, [
    { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_a', 'm/a.mov', 0, 100), at: f(0) },
    { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_b', 'm/b.mov', 10, 48), at: f(100) },
    { op: 'add_clip', trackId: 'trk_a1', clip: clip('clp_c', 'm/c.wav', 0, 200), at: f(0) },
    { op: 'add_marker', marker: { id: 'mrk_1', at: f(24), name: 'one', colour: 'red' } },
    { op: 'add_marker', marker: { id: 'mrk_2', at: f(120), name: 'two', colour: 'blue' } },
  ]).timeline;
}

/** Everything except the revision, which is append-only and moves on an undo too. */
const shape = (t: Timeline) => ({
  id: t.id, name: t.name, rate: t.rate,
  tracks: t.tracks, markers: t.markers, media: t.media, etag: t.etag,
});

const items = (t: Timeline, trackId: string): TrackItem[] => findTrack(t, trackId)!.items;
const ids = (t: Timeline, trackId: string): string[] => items(t, trackId).map((i) => i.id);
const starts = (t: Timeline, trackId: string): number[] =>
  placeTrack(findTrack(t, trackId)!).map((p) => p.range.start);
const clipIn = (t: Timeline, trackId: string, index: number): Clip => {
  const item = items(t, trackId)[index];
  assert.equal(item.kind, 'clip', `expected a clip at ${trackId}[${index}]`);
  return item as Clip;
};

// ── placing a clip at a frame ───────────────────────────────────────────

describe('a position is implicit, so placing a clip is a structural edit', () => {
  test('inserting mid-clip splits it and keeps every source frame', () => {
    const after = applyEdits(base(), [
      { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_x', 'm/b.mov', 0, 24), at: f(50) },
    ]).timeline;

    assert.deepEqual(ids(after, 'trk_v1'), ['clp_a', 'clp_x', 'clp_a_b', 'clp_b']);
    assert.deepEqual(starts(after, 'trk_v1'), [0, 50, 74, 124]);
    // the halves between them use exactly the source the whole clip used
    assert.deepEqual(clipIn(after, 'trk_v1', 0).sourceRange, timeRange(f(0), f(50)));
    assert.deepEqual(clipIn(after, 'trk_v1', 2).sourceRange, timeRange(f(50), f(50)));
    assert.equal(trackDuration(findTrack(after, 'trk_v1')!), 172);
  });

  test('inserting on a cut splits nothing', () => {
    const after = applyEdits(base(), [
      { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_x', 'm/b.mov', 0, 24), at: f(100) },
    ]).timeline;
    assert.deepEqual(ids(after, 'trk_v1'), ['clp_a', 'clp_x', 'clp_b']);
  });

  test('the frame one past the last one is the end of the track, not inside it', () => {
    // half-open: [100,148) ends at 148, so 148 appends and 147 splits
    const appended = applyEdits(base(), [
      { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_x', 'm/b.mov', 0, 24), at: f(148) },
    ]).timeline;
    assert.deepEqual(ids(appended, 'trk_v1'), ['clp_a', 'clp_b', 'clp_x']);

    const split = applyEdits(base(), [
      { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_x', 'm/b.mov', 0, 24), at: f(147) },
    ]).timeline;
    assert.deepEqual(ids(split, 'trk_v1'), ['clp_a', 'clp_b', 'clp_x', 'clp_b_b']);
    assert.equal(clipIn(split, 'trk_v1', 3).sourceRange.duration, 1);
  });

  test('a frame past the end is padded with exactly one gap', () => {
    const after = applyEdits(base(), [
      { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_x', 'm/b.mov', 0, 24), at: f(200) },
    ]).timeline;
    const pad = items(after, 'trk_v1')[2];
    assert.equal(pad.kind, 'gap');
    assert.equal(pad.kind === 'gap' && pad.duration, 52);
    assert.deepEqual(starts(after, 'trk_v1'), [0, 100, 148, 200]);
  });

  test('a negative position is refused rather than clamped', () => {
    assert.throws(
      () => applyEdits(base(), [
        { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_x', 'm/b.mov', 0, 24), at: f(-1) },
      ]),
      (err: unknown) => err instanceof EditError && err.code === 'bad_position',
    );
  });

  test('a source in-point that is not a whole frame is refused', () => {
    // it would validate clean, serialise, and then fail to read back: OTIO's
    // value is a double and `fromRationalTime` refuses anything off a boundary
    const half = { ...clip('clp_x', 'm/b.mov', 0, 24), sourceRange: rawRange(0.5, 24) };
    assert.throws(
      () => applyEdits(base(), [{ op: 'add_clip', trackId: 'trk_v1', clip: half, at: f(0) }]),
      (err: unknown) => err instanceof EditError && err.code === 'bad_position',
    );
    assert.throws(
      () => applyEdits(base(), [{ op: 'patch_clip', clipId: 'clp_a', set: { sourceRange: rawRange(0.5, 24) } }]),
      (err: unknown) => err instanceof EditError && err.code === 'bad_position',
    );
  });

  test('a document that keeps its in-points whole survives a save', () => {
    const after = applyEdits(base(), [
      { op: 'patch_clip', clipId: 'clp_a', set: { sourceRange: timeRange(f(12), f(60)) } },
    ]).timeline;
    assert.deepEqual(fromOtio(JSON.parse(JSON.stringify(toOtio(after))) as unknown, R), after);
  });

  test('an id already in the document is refused', () => {
    assert.throws(
      () => applyEdits(base(), [
        { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_b', 'm/b.mov', 0, 24), at: f(0) },
      ]),
      (err: unknown) => err instanceof EditError && err.code === 'duplicate_id',
    );
  });
});

// ── removing ───────────────────────────────────────────────────────────

/** base() plus V2 with auto-select off and a locked A2, both carrying a clip. */
function rippleBed(): Timeline {
  return applyEdits(base(), [
    { op: 'add_clip', trackId: 'trk_v2', clip: clip('clp_d', 'm/b.mov', 0, 100), at: f(0) },
    { op: 'patch_track', trackId: 'trk_v2', set: { autoSelect: false } },
    { op: 'add_clip', trackId: 'trk_a2', clip: clip('clp_e', 'm/c.wav', 0, 300), at: f(0) },
    { op: 'patch_track', trackId: 'trk_a2', set: { locked: true } },
  ]).timeline;
}

describe('removing a clip', () => {
  test('without ripple it leaves a gap of its own length', () => {
    const after = applyEdits(base(), [{ op: 'remove_clip', clipId: 'clp_a' }]).timeline;
    const gap = items(after, 'trk_v1')[0];
    assert.equal(gap.kind, 'gap');
    assert.equal(gap.kind === 'gap' && gap.duration, 100);
    assert.deepEqual(starts(after, 'trk_v1'), [0, 100]);
    assert.equal(trackDuration(findTrack(after, 'trk_v1')!), 148, 'nothing after it moved');
  });

  test('with ripple the hole closes on every auto-select unlocked track', () => {
    const before = rippleBed();
    const after = applyEdits(before, [{ op: 'remove_clip', clipId: 'clp_a', ripple: true }]).timeline;

    // its own track closes up
    assert.deepEqual(ids(after, 'trk_v1'), ['clp_b']);
    assert.deepEqual(starts(after, 'trk_v1'), [0]);

    // A1 follows: the first 100 frames of clp_c are gone and the tail slid left
    const tail = clipIn(after, 'trk_a1', 0);
    assert.equal(tail.id, 'clp_c_b');
    assert.deepEqual(tail.sourceRange, timeRange(f(100), f(100)));
    assert.equal(trackDuration(findTrack(after, 'trk_a1')!), 100);

    // V2 has auto-select off, A2 is locked: neither is touched
    assert.deepEqual(ids(after, 'trk_v2'), ['clp_d']);
    assert.equal(trackDuration(findTrack(after, 'trk_v2')!), 100);
    assert.equal(trackDuration(findTrack(after, 'trk_a2')!), 300);
  });

  test('a ripple that undoes cleanly puts every track back', () => {
    const before = rippleBed();
    const result = applyEdits(before, [{ op: 'remove_clip', clipId: 'clp_a', ripple: true }]);
    const back = applyEdits(result.timeline, result.inverse).timeline;
    assert.deepEqual(shape(back), shape(before));
  });

  test('a ripple leaves a track that ends before the cut exactly as it was', () => {
    const before = base();
    // V2, A2 and A3 are empty and auto-select: a hole at frame 100 is past the
    // end of all three, so there is nothing there for them to close up
    const after = applyEdits(before, [{ op: 'remove_clip', clipId: 'clp_b', ripple: true }]).timeline;
    for (const id of ['trk_v2', 'trk_a2', 'trk_a3']) {
      assert.deepEqual(items(after, id), [], `${id} grew a trailing gap out of nothing`);
      assert.equal(trackDuration(findTrack(after, id)!), 0);
    }
    // the tracks that do reach the cut still close up
    assert.equal(trackDuration(findTrack(after, 'trk_v1')!), 100);
    assert.equal(trackDuration(findTrack(after, 'trk_a1')!), 152);
  });

  test('successive ripples never lengthen a track that ends before the cut', () => {
    // V2 carries 50 frames and every cut is past it, so it is never involved
    let doc = applyEdits(base(), [
      { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_x', 'm/b.mov', 0, 100), at: f(148) },
      { op: 'add_clip', trackId: 'trk_v2', clip: clip('clp_v2', 'm/b.mov', 0, 50), at: f(0) },
    ]).timeline;
    for (const clipId of ['clp_x', 'clp_b']) {
      doc = applyEdits(doc, [{ op: 'remove_clip', clipId, ripple: true }]).timeline;
      assert.equal(trackDuration(findTrack(doc, 'trk_v2')!), 50, `the ripple of ${clipId} moved V2`);
    }
    assert.deepEqual(ids(doc, 'trk_v2'), ['clp_v2']);
  });

  test('a track the cut reaches into is truncated, not padded', () => {
    // V2 ends at 120, inside the [100,148) hole: the 20 frames in the hole go
    // and there is nothing after them to slide left
    const before = applyEdits(base(), [
      { op: 'add_clip', trackId: 'trk_v2', clip: clip('clp_v2', 'm/b.mov', 0, 120), at: f(0) },
    ]).timeline;
    const after = applyEdits(before, [{ op: 'remove_clip', clipId: 'clp_b', ripple: true }]).timeline;
    assert.equal(trackDuration(findTrack(after, 'trk_v2')!), 100);
    assert.deepEqual(clipIn(after, 'trk_v2', 0).sourceRange, timeRange(f(0), f(100)));
  });

  test('a clip that is not there names itself in the error', () => {
    assert.throws(
      () => applyEdits(base(), [{ op: 'remove_clip', clipId: 'clp_ghost' }]),
      (err: unknown) => err instanceof EditError && err.code === 'no_such_clip' && /clp_ghost/.test(err.message),
    );
  });
});

// ── locking ────────────────────────────────────────────────────────────

describe('a locked track refuses content edits', () => {
  const locked = (): Timeline =>
    applyEdits(base(), [{ op: 'patch_track', trackId: 'trk_v1', set: { locked: true } }]).timeline;

  const rejected: Array<[string, EditOp]> = [
    ['add_clip', { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_x', 'm/b.mov', 0, 24), at: f(0) }],
    ['remove_clip', { op: 'remove_clip', clipId: 'clp_a' }],
    ['patch_clip', { op: 'patch_clip', clipId: 'clp_a', set: { name: 'nope' } }],
    ['move_clip out', { op: 'move_clip', clipId: 'clp_a', trackId: 'trk_v2', to: f(0) }],
    ['move_clip in', { op: 'move_clip', clipId: 'clp_c', trackId: 'trk_v1', to: f(0) }],
    ['add_gap', { op: 'add_gap', trackId: 'trk_v1', at: f(0), duration: f(24) }],
  ];

  for (const [name, op] of rejected) {
    test(`${name} is refused`, () => {
      const doc = locked();
      assert.throws(
        () => applyEdits(doc, [op]),
        (err: unknown) => err instanceof EditError && err.code === 'track_locked',
      );
    });
  }

  test('patch_track still works, because it is how a lock comes off', () => {
    const after = applyEdits(locked(), [{ op: 'patch_track', trackId: 'trk_v1', set: { locked: false } }]).timeline;
    assert.equal(findTrack(after, 'trk_v1')!.locked, false);
  });
});

// ── a track arrives whole ──────────────────────────────────────────────

describe('add_track carries its items, so the items are checked at the door', () => {
  const carrying = (carried: TrackItem[]): Omit<Track, 'items'> & { items?: TrackItem[] } => ({
    id: 'trk_new', kind: 'video', name: 'New',
    locked: false, muted: false, solo: false, enabled: true, autoSelect: true,
    items: carried,
  });
  const add = (carried: TrackItem[]): EditOp => ({ op: 'add_track', track: carrying(carried), at: 0 });

  const refused: Array<[string, TrackItem, string]> = [
    ['a negative gap', { id: 'gap_bad', kind: 'gap', duration: f(-24) }, 'bad_duration'],
    ['a negative clip', { ...clip('clp_bad', 'm/b.mov', 0, 24), sourceRange: rawRange(0, -24) }, 'bad_duration'],
    ['a fractional in-point', { ...clip('clp_bad', 'm/b.mov', 0, 24), sourceRange: rawRange(0.5, 24) }, 'bad_position'],
    ['a negative transition offset', { id: 'tr_bad', kind: 'transition', transitionType: 'SMPTE_Dissolve', inOffset: f(-6), outOffset: f(6) }, 'bad_duration'],
  ];

  for (const [name, item, code] of refused) {
    test(`${name} is refused rather than placed`, () => {
      // one of these in the document makes place() throw for every track, not
      // just for the one carrying it
      assert.throws(
        () => applyEdits(base(), [add([item])]),
        (err: unknown) => err instanceof EditError && err.code === code,
      );
    });
  }

  test('a track whose items are lengths arrives whole and places', () => {
    const after = applyEdits(base(), [add([
      { id: 'gap_lead', kind: 'gap', duration: f(12) },
      clip('clp_n', 'm/b.mov', 0, 48),
    ])]).timeline;
    assert.deepEqual(ids(after, 'trk_new'), ['gap_lead', 'clp_n']);
    assert.deepEqual(starts(after, 'trk_new'), [0, 12]);
    assert.equal(place(after).length, 5, 'every item in the document still places');
  });
});

// ── inverses ───────────────────────────────────────────────────────────

const ROUND_TRIP: Array<[string, EditOp]> = [
  ['add_clip mid-clip', { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_x', 'm/b.mov', 0, 24), at: f(50) }],
  ['add_clip past the end', { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_x', 'm/b.mov', 0, 24), at: f(400) }],
  ['remove_clip', { op: 'remove_clip', clipId: 'clp_a' }],
  ['remove_clip rippling', { op: 'remove_clip', clipId: 'clp_a', ripple: true }],
  ['patch_clip trim', { op: 'patch_clip', clipId: 'clp_a', set: { sourceRange: timeRange(f(10), f(40)), name: 'trimmed' } }],
  ['patch_clip effects', { op: 'patch_clip', clipId: 'clp_b', set: { enabled: false, effects: [{ kind: 'ffmpeg/volume', params: { volume: 2 }, enabled: true }] } }],
  ['move_clip across tracks', { op: 'move_clip', clipId: 'clp_b', trackId: 'trk_v2', to: f(0) }],
  ['move_clip within a track', { op: 'move_clip', clipId: 'clp_a', trackId: 'trk_v1', to: f(300) }],
  ['add_gap', { op: 'add_gap', trackId: 'trk_v1', at: f(50), duration: f(36) }],
  ['add_track', { op: 'add_track', track: { id: 'trk_v3', kind: 'video', name: 'Video 3', locked: false, muted: false, solo: false, enabled: true, autoSelect: true }, at: 0 }],
  ['remove_track', { op: 'remove_track', trackId: 'trk_a1' }],
  ['patch_track', { op: 'patch_track', trackId: 'trk_v1', set: { locked: true, name: 'Locked' } }],
  ['add_marker', { op: 'add_marker', marker: { id: 'mrk_3', at: f(60), name: 'three', colour: 'green' } }],
  ['remove_marker', { op: 'remove_marker', markerId: 'mrk_1' }],
];

describe('every op inverts exactly', () => {
  for (const [name, op] of ROUND_TRIP) {
    test(name, () => {
      const before = base();
      const result = applyEdits(before, [op]);
      assert.notDeepEqual(shape(result.timeline), shape(before), 'the op did nothing, so the test proves nothing');

      const back = applyEdits(result.timeline, result.inverse).timeline;
      assert.deepEqual(shape(back), shape(before));
    });
  }

  test('a new marker lands in (at, id) order', () => {
    const after = applyEdits(base(), [
      { op: 'add_marker', marker: { id: 'mrk_3', at: f(60), name: 'three', colour: 'green' } },
    ]).timeline;
    assert.deepEqual(after.markers.map((m) => m.id), ['mrk_1', 'mrk_3', 'mrk_2']);
  });

  test('add_marker leaves the markers it did not touch where they were', () => {
    // a document off the wire whose markers did not arrive in order: re-sorting
    // the array would move markers this op never touched, and the matching
    // remove_marker only takes its own back out, so undo would not be an undo
    const before = base();
    before.markers = [...before.markers].reverse();
    const result = applyEdits(before, [
      { op: 'add_marker', marker: { id: 'mrk_3', at: f(60), name: 'three', colour: 'green' } },
    ]);
    assert.deepEqual(
      result.timeline.markers.filter((m) => m.id !== 'mrk_3').map((m) => m.id),
      ['mrk_2', 'mrk_1'],
    );
    assert.deepEqual(shape(applyEdits(result.timeline, result.inverse).timeline), shape(before));
  });

  test('a batch inverts as a whole, in reverse order', () => {
    const before = base();
    const result = applyEdits(before, [
      { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_x', 'm/b.mov', 0, 24), at: f(50) },
      { op: 'patch_clip', clipId: 'clp_x', set: { name: 'renamed', sourceRange: timeRange(f(0), f(12)) } },
      { op: 'remove_clip', clipId: 'clp_b', ripple: true },
      { op: 'move_clip', clipId: 'clp_x', trackId: 'trk_v2', to: f(30) },
      { op: 'add_marker', marker: { id: 'mrk_9', at: f(5), name: 'nine', colour: 'orange' } },
      { op: 'remove_marker', markerId: 'mrk_2' },
    ]);
    assert.deepEqual(shape(applyEdits(result.timeline, result.inverse).timeline), shape(before));
  });

  test('the inverse of the inverse is the redo', () => {
    const before = base();
    const forward = applyEdits(before, [{ op: 'remove_clip', clipId: 'clp_a', ripple: true }]);
    const undone = applyEdits(forward.timeline, forward.inverse);
    assert.deepEqual(shape(undone.timeline), shape(before));
    const redone = applyEdits(undone.timeline, undone.inverse).timeline;
    assert.deepEqual(shape(redone), shape(forward.timeline));
  });

  test('the revision is append-only: an undo is a new revision, not an old one', () => {
    const before = base();
    const forward = applyEdits(before, [{ op: 'remove_clip', clipId: 'clp_a' }]);
    assert.equal(forward.timeline.revision, before.revision + 1);
    assert.equal(applyEdits(forward.timeline, forward.inverse).timeline.revision, before.revision + 2);
  });

  test('an empty batch is not an edit', () => {
    const before = base();
    const result = applyEdits(before, []);
    assert.deepEqual(result.inverse, []);
    assert.equal(result.timeline.revision, before.revision);
  });
});

// ── atomicity ──────────────────────────────────────────────────────────

describe('a batch is all or nothing', () => {
  test('a bad op late in the batch undoes the good ones before it', () => {
    const before = base();
    const untouched = structuredClone(before);
    assert.throws(
      () => applyEdits(before, [
        { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_x', 'm/b.mov', 0, 24), at: f(50) },
        { op: 'remove_clip', clipId: 'clp_c' },
        { op: 'add_clip', trackId: 'trk_nope', clip: clip('clp_y', 'm/b.mov', 0, 24), at: f(0) },
      ]),
      (err: unknown) => err instanceof EditError && err.code === 'no_such_track' && /op 2 \(add_clip\)/.test(err.message),
    );
    assert.deepEqual(before, untouched, 'the input was mutated');
  });

  test('a successful batch does not alias the input either', () => {
    const before = base();
    const untouched = structuredClone(before);
    const after = applyEdits(before, [{ op: 'patch_clip', clipId: 'clp_a', set: { name: 'changed' } }]).timeline;
    assert.deepEqual(before, untouched);
    assert.notEqual(after.tracks, before.tracks);
  });
});

// ── normalisation ──────────────────────────────────────────────────────

describe('normalisation', () => {
  test('adjacent gaps merge into one', () => {
    const after = applyEdits(base(), [
      { op: 'add_gap', trackId: 'trk_a3', at: f(0), duration: f(24) },
      { op: 'add_gap', trackId: 'trk_a3', at: f(0), duration: f(12) },
    ]).timeline;
    assert.equal(items(after, 'trk_a3').length, 1);
    assert.equal(trackDuration(findTrack(after, 'trk_a3')!), 36);
  });

  test('a zero-duration gap occupies nothing and is dropped', () => {
    const after = applyEdits(base(), [
      { op: 'add_gap', trackId: 'trk_a3', at: f(0), duration: f(0) },
    ]).timeline;
    assert.deepEqual(items(after, 'trk_a3'), []);
  });

  test('a trailing gap is kept, because it is the track length', () => {
    const after = applyEdits(base(), [{ op: 'remove_clip', clipId: 'clp_b' }]).timeline;
    assert.deepEqual(ids(after, 'trk_v1').length, 2);
    assert.equal(trackDuration(findTrack(after, 'trk_v1')!), 148);
  });

  test('a negative duration is refused at the door', () => {
    assert.throws(
      () => applyEdits(base(), [{ op: 'add_gap', trackId: 'trk_v1', at: f(0), duration: f(-5) }]),
      (err: unknown) => err instanceof EditError && err.code === 'bad_duration',
    );
  });
});

// ── moving ─────────────────────────────────────────────────────────────

describe('moving a clip', () => {
  test('lifts from the source and overwrites at the destination', () => {
    const before = rippleBed();
    const after = applyEdits(before, [{ op: 'move_clip', clipId: 'clp_b', trackId: 'trk_v2', to: f(0) }]).timeline;

    // the source keeps its shape: a gap where the clip was
    assert.deepEqual(ids(after, 'trk_v1'), ['clp_a', items(after, 'trk_v1')[1].id]);
    assert.equal(items(after, 'trk_v1')[1].kind, 'gap');
    assert.equal(trackDuration(findTrack(after, 'trk_v1')!), 148);

    // the destination is overwritten for exactly the clip's length
    assert.deepEqual(ids(after, 'trk_v2'), ['clp_b', 'clp_d_b']);
    assert.deepEqual(starts(after, 'trk_v2'), [0, 48]);
    assert.deepEqual(clipIn(after, 'trk_v2', 1).sourceRange, timeRange(f(48), f(52)));
  });

  test('moving a clip to where it already is changes nothing', () => {
    const before = base();
    const after = applyEdits(before, [{ op: 'move_clip', clipId: 'clp_a', trackId: 'trk_v1', to: f(0) }]).timeline;
    assert.deepEqual(shape(after), shape(before), 'the lift and the drop have to cancel exactly');
  });

  test('moving to a frame past the end pads the gap between', () => {
    const after = applyEdits(base(), [{ op: 'move_clip', clipId: 'clp_a', trackId: 'trk_v2', to: f(240) }]).timeline;
    assert.deepEqual(starts(after, 'trk_v2'), [0, 240]);
    assert.equal(items(after, 'trk_v2')[0].kind, 'gap');
  });
});

// ── OTIO ───────────────────────────────────────────────────────────────

/** Everything the model can express: subtitle track, transition, effects, unused media. */
function rich(): Timeline {
  const doc = base();
  doc.etag = 'W/"rev-7"';
  doc.media['m/d.png'] = { key: 'm/d.png', name: 'lower third', kind: 'image', available: timeRange(f(0), f(100)), rate: { num: 48, den: 2 } };
  doc.media['m/unused.mov'] = media('m/unused.mov', 999);
  /**
   * Everything import actually writes onto a pool entry.
   *
   * These were dropped by `toOtio` for a long time and this test passed
   * anyway, because the fixture never had any: a project could be saved and
   * reopened with no thumbnails and nothing playable, which is the pair of
   * things import spends the most time making.
   */
  doc.media['m/a.mp4'] = {
    ...media('m/a.mp4', 480),
    frames: ['output/a-0.jpg', 'output/a-1.jpg', 'output/a-2.jpg'],
    proxy: 'output/a-proxy.mp4',
    width: 1920,
    height: 1080,
  };
  const subtitle: Omit<Track, 'items'> & { items?: TrackItem[] } = {
    id: 'trk_s1', kind: 'subtitle', name: 'Subtitles',
    locked: false, muted: false, solo: false, enabled: true, autoSelect: false,
    items: [
      { id: 'gap_lead', kind: 'gap', duration: f(12) },
      clip('clp_s1', 'm/d.png', 0, 48),
      { id: 'tr_1', kind: 'transition', transitionType: 'SMPTE_Dissolve', inOffset: f(6), outOffset: f(6) },
      clip('clp_s2', 'm/d.png', 48, 48),
    ],
  };
  return applyEdits(doc, [
    { op: 'add_track', track: subtitle, at: 0 },
    { op: 'patch_clip', clipId: 'clp_a', set: { effects: [{ kind: 'ffmpeg/volume', params: { volume: 0.5, curve: 'linear' }, enabled: true }] } },
    { op: 'patch_track', trackId: 'trk_a3', set: { locked: true, muted: true } },
  ]).timeline;
}

describe('OTIO', () => {
  test('a round trip through JSON is lossless', () => {
    const before = rich();
    const doc = toOtio(before);
    const back = fromOtio(JSON.parse(JSON.stringify(doc)) as unknown, R);
    assert.deepEqual(back, before);
  });

  test('a transition occupies no time on either side of the boundary', () => {
    // 12 of gap, 48, a dissolve, 48: the dissolve overlaps its neighbours
    // rather than adding to them, so the track is 108 and not 120
    const doc = rich();
    assert.equal(trackDuration(findTrack(doc, 'trk_s1')!), 108);
    assert.equal(trackDuration(findTrack(fromOtio(toOtio(doc), R), 'trk_s1')!), 108);
  });

  test('something that is not a timeline is refused, not half-read', () => {
    assert.throws(() => fromOtio({ hello: 'world' }, R), (err: unknown) => err instanceof OtioError);
    assert.throws(() => fromOtio(null, R), (err: unknown) => err instanceof OtioError);
    assert.throws(
      () => fromOtio({ OTIO_SCHEMA: 'Timeline.1', tracks: { children: 'not an array' } }, R),
      (err: unknown) => err instanceof OtioError && /tracks.children/.test(err.message),
    );
  });

  test('the document is the shape an OTIO reader expects', () => {
    const doc = toOtio(base());
    assert.equal(doc.OTIO_SCHEMA, 'Timeline.1');
    assert.equal(doc.tracks.OTIO_SCHEMA, 'Stack.1');
    assert.equal(doc.tracks.children[1].OTIO_SCHEMA, 'Track.1');
    assert.equal(doc.tracks.children[1].kind, 'Video');

    const first = doc.tracks.children[1].children[0];
    assert.ok(first.OTIO_SCHEMA === 'Clip.2', 'the first item on V1 is a clip');
    // a source_range is frames at the project rate, never seconds
    assert.deepEqual(first.source_range.start_time, { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 });
    assert.deepEqual(first.source_range.duration, { OTIO_SCHEMA: 'RationalTime.1', value: 100, rate: 24 });
    assert.equal(first.media_reference.target_url, 'm/a.mov');
  });

  test('editor ids ride in metadata.editor_api and come back', () => {
    const doc = toOtio(base());
    const track = doc.tracks.children[1];
    assert.equal(track.metadata.editor_api?.id, 'trk_v1');
    assert.equal(track.children[0].metadata.editor_api?.id, 'clp_a');
    assert.equal(doc.tracks.markers[0].metadata.editor_api?.id, 'mrk_1');

    const back = fromOtio(doc, R);
    assert.deepEqual(ids(back, 'trk_v1'), ['clp_a', 'clp_b']);
    assert.deepEqual(back.markers.map((m) => m.id), ['mrk_1', 'mrk_2']);
  });

  test('a subtitle track survives a format that has no subtitle kind', () => {
    const doc = toOtio(rich());
    const track = doc.tracks.children[0];
    assert.equal(track.kind, 'Video', 'other readers must still see a track they understand');
    assert.equal(track.metadata.editor_api?.kind, 'subtitle');
    assert.equal(fromOtio(doc, R).tracks[0].kind, 'subtitle');
  });

  test('a foreign document with no metadata imports with derived ids and a media pool', () => {
    const rt = (value: number, rate = 24) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate });
    const foreign = {
      OTIO_SCHEMA: 'Timeline.1',
      name: 'From somewhere else',
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [{
          OTIO_SCHEMA: 'Track.1',
          name: 'V1',
          kind: 'Video',
          children: [
            { OTIO_SCHEMA: 'Gap.1', source_range: { start_time: rt(0), duration: rt(12) } },
            {
              OTIO_SCHEMA: 'Clip.2',
              name: 'shot 1',
              source_range: { start_time: rt(48), duration: rt(72) },
              media_reference: {
                OTIO_SCHEMA: 'ExternalReference.1',
                target_url: 's3://bucket/shot.mov',
                available_range: { start_time: rt(0), duration: rt(1000) },
              },
            },
          ],
        }],
      },
    };

    const doc = fromOtio(foreign, R);
    assert.equal(doc.tracks.length, 1);
    assert.deepEqual(ids(doc, 'trk_1'), ['trk_1_item_1', 'trk_1_item_2']);
    assert.equal(doc.tracks[0].autoSelect, true, 'an unknown track follows a ripple');
    assert.deepEqual(clipIn(doc, 'trk_1', 1).sourceRange, timeRange(f(48), f(72)));
    assert.deepEqual(doc.media['s3://bucket/shot.mov'].available, timeRange(f(0), f(1000)));
    assert.equal(validateTimeline(doc).length, 0);
  });

  test('a document at another rate is conformed frame by frame', () => {
    const before = base();
    const doc = toOtio(before);
    // pretend it was written at 48fps: every value doubles
    for (const track of doc.tracks.children) {
      for (const item of track.children) {
        if (item.OTIO_SCHEMA !== 'Clip.2') continue;
        item.source_range.start_time = { OTIO_SCHEMA: 'RationalTime.1', value: item.source_range.start_time.value * 2, rate: 48 };
        item.source_range.duration = { OTIO_SCHEMA: 'RationalTime.1', value: item.source_range.duration.value * 2, rate: 48 };
      }
    }
    const back = fromOtio(doc, R);
    assert.deepEqual(clipIn(back, 'trk_v1', 0).sourceRange, timeRange(f(0), f(100)));
    assert.deepEqual(clipIn(back, 'trk_v1', 1).sourceRange, timeRange(f(10), f(48)));
  });

  test('a time that is not on a frame boundary is refused, with the path', () => {
    const doc = toOtio(base());
    (doc.tracks.children[1].children[0] as OtioClip).source_range.start_time =
      { OTIO_SCHEMA: 'RationalTime.1', value: 7, rate: 25 };
    assert.throws(
      () => fromOtio(doc, R),
      (err: unknown) => err instanceof OtioError && /children\[0\]\.source_range\.start_time/.test(err.message),
    );
  });

  test('an item the model cannot hold is refused rather than silently dropped', () => {
    const doc = toOtio(base());
    // dropping a nested stack would change the length of the track
    (doc.tracks.children[1].children as unknown[])[1] = { OTIO_SCHEMA: 'Stack.1', name: 'nested', children: [] };
    assert.throws(() => fromOtio(doc, R), (err: unknown) => err instanceof OtioError && /unsupported/.test(err.message));
  });

  test('otioRate answers the exact rational, not a decimal of it', () => {
    assert.deepEqual(otioRate(toOtio(base())), { num: 24, den: 1 });
    assert.equal(otioRate({ nonsense: true }), null);

    // every RationalTime in an NTSC document carries 23.976023976023978,
    // which is a double that has already lost the only thing that makes
    // 24000/1001 a rate. Our own metadata has the rational, so it wins.
    const ntsc = emptyTimeline('tl_n', 'NTSC', RATES.ntscFilm);
    ntsc.media = { 'm/a.mov': media('m/a.mov', 100) };
    const doc = toOtio(applyEdits(ntsc, [
      { op: 'add_clip', trackId: 'trk_v1', clip: clip('clp_n', 'm/a.mov', 0, 100), at: f(0) },
    ]).timeline);
    const first = doc.tracks.children[1].children[0];
    assert.ok(first.OTIO_SCHEMA === 'Clip.2', 'the first item on V1 is a clip');
    assert.equal(first.source_range.start_time.rate, 24000 / 1001);
    assert.deepEqual(otioRate(doc), { num: 24000, den: 1001 });
  });

  test('a foreign document with only a decimal rate reads as the rational everyone means', () => {
    const clipAt = (rate: number) => ({
      OTIO_SCHEMA: 'Clip.2',
      source_range: { start_time: { value: 0, rate }, duration: { value: 10, rate } },
    });
    const foreign = (rate: number) =>
      ({ tracks: { children: [{ children: [clipAt(rate)] }] } });
    // 23.976 is how the rest of the world writes 24000/1001
    assert.deepEqual(otioRate(foreign(23.976)), { num: 24000, den: 1001 });
    assert.deepEqual(otioRate(foreign(29.97)), { num: 30000, den: 1001 });
    assert.deepEqual(otioRate(foreign(25)), { num: 25, den: 1 });
    assert.deepEqual(otioRate(foreign(23.5)), { num: 47, den: 2 });
    assert.equal(otioRate(foreign(0)), null);
  });
});

// ── validation ─────────────────────────────────────────────────────────

describe('validation', () => {
  const codes = (t: Timeline) => validateTimeline(t).map((p) => p.code);

  test('a clean document has nothing to say', () => {
    assert.deepEqual(validateTimeline(base()), []);
    assert.deepEqual(validateTimeline(rich()), []);
  });

  test('a clip trimmed past the end of its media is caught', () => {
    // m/a.mov is 100 frames; [80,120) asks for 20 that do not exist
    const after = applyEdits(base(), [
      { op: 'patch_clip', clipId: 'clp_a', set: { sourceRange: timeRange(f(80), f(40)) } },
    ]).timeline;
    const problems = validateTimeline(after);
    assert.deepEqual(problems.map((p) => p.code), ['past_media_end']);
    assert.equal(problems[0].clipId, 'clp_a');
    assert.match(problems[0].message, /\[0, 100\)/);
  });

  test('ending exactly on the last frame of the media is fine, one past it is not', () => {
    const exact = applyEdits(base(), [
      { op: 'patch_clip', clipId: 'clp_a', set: { sourceRange: timeRange(f(60), f(40)) } },
    ]).timeline;
    assert.deepEqual(validateTimeline(exact), []);

    const over = applyEdits(base(), [
      { op: 'patch_clip', clipId: 'clp_a', set: { sourceRange: timeRange(f(60), f(41)) } },
    ]).timeline;
    assert.deepEqual(codes(over), ['past_media_end']);
  });

  test('a clip whose media is not in the pool is caught', () => {
    const after = applyEdits(base(), [
      { op: 'add_clip', trackId: 'trk_v2', clip: clip('clp_x', 'm/ghost.mov', 0, 24), at: f(0) },
    ]).timeline;
    const problems = validateTimeline(after);
    assert.deepEqual(problems.map((p) => p.code), ['missing_media']);
    assert.equal(problems[0].clipId, 'clp_x');
  });

  test('media at a rate the document is not at is caught', () => {
    const doc = base();
    doc.media['m/a.mov'] = { ...doc.media['m/a.mov'], rate: RATES.pal };
    assert.deepEqual(codes(doc), ['mixed_rates']);
    // the same rate written differently is not a problem
    doc.media['m/a.mov'] = { ...doc.media['m/a.mov'], rate: { num: 48, den: 2 } };
    assert.deepEqual(codes(doc), []);
  });

  test('a duplicate id is caught, because ids are how an edit names a clip', () => {
    const doc = base();
    findTrack(doc, 'trk_v2')!.items.push(clip('clp_a', 'm/a.mov', 0, 10));
    const problems = validateTimeline(doc);
    assert.deepEqual(problems.map((p) => p.code), ['duplicate_id']);
    // V2 sits above V1, so the second clp_a the walk meets is the one on V1
    assert.equal(problems[0].trackId, 'trk_v1');
  });

  test('a negative duration is caught, and so is the overlap it causes', () => {
    // the invariant the model is meant to make impossible: a duration that
    // walks the cursor backwards puts the next clip on top of the last one
    const doc = base();
    doc.tracks = [{
      id: 'trk_x', kind: 'video', name: 'Broken',
      items: [
        clip('clp_1', 'm/a.mov', 0, 48),
        { id: 'gap_bad', kind: 'gap', duration: f(-24) },
        clip('clp_2', 'm/a.mov', 0, 48),
      ],
      locked: false, muted: false, solo: false, enabled: true, autoSelect: true,
    }];
    const problems = validateTimeline(doc);
    assert.deepEqual(problems.map((p) => p.code).sort(), ['negative_duration', 'overlap']);
    assert.equal(problems.find((p) => p.code === 'overlap')!.clipId, 'clp_2');
  });

  test('a transition offset that is missing is not a clean transition', () => {
    // a search for the offending VALUE answers undefined for a missing offset,
    // which reads back as "nothing was wrong": the check has to find the slot
    const doc = base();
    findTrack(doc, 'trk_v2')!.items.push({
      id: 'tr_x', kind: 'transition', transitionType: 'SMPTE_Dissolve',
      inOffset: undefined as unknown as Frames, outOffset: f(6),
    });
    const problems = validateTimeline(doc);
    assert.deepEqual(problems.map((p) => p.code), ['negative_duration']);
    assert.match(problems[0].message, /in-offset/);

    const negative = base();
    findTrack(negative, 'trk_v2')!.items.push({
      id: 'tr_y', kind: 'transition', transitionType: 'SMPTE_Dissolve',
      inOffset: f(6), outOffset: f(-6),
    });
    assert.match(validateTimeline(negative)[0].message, /out-offset/);
  });

  test('a source in-point off a frame boundary is caught on a wire document', () => {
    const doc = base();
    findTrack(doc, 'trk_v2')!.items.push({
      ...clip('clp_frac', 'm/a.mov', 0, 24), sourceRange: rawRange(0.5, 24),
    });
    const problems = validateTimeline(doc);
    assert.deepEqual(problems.map((p) => p.code), ['negative_duration']);
    assert.equal(problems[0].clipId, 'clp_frac');
  });

  test('a fractional duration is not a length either', () => {
    const doc = base();
    findTrack(doc, 'trk_v2')!.items.push({ id: 'gap_half', kind: 'gap', duration: 10.5 as Frames });
    assert.deepEqual(codes(doc), ['negative_duration']);
  });
});

// ── history ────────────────────────────────────────────────────────────

describe('history is a stack of batches, not of ops', () => {
  /** The caller owns the document; history only holds the batches. */
  function bench() {
    let doc = base();
    const history = createHistory();
    const apply = (ops: EditOp[]): EditOp[] => {
      const result = applyEdits(doc, ops);
      doc = result.timeline;
      return result.inverse;
    };
    const run = (label: string, ops: EditOp[]) => {
      history.push(label, apply(ops));
    };
    return { history, apply, run, read: () => doc };
  }

  test('a whole run is one entry, so one undo reverses the run', () => {
    const b = bench();
    const before = b.read();
    b.run('tighten the cut', [
      { op: 'patch_clip', clipId: 'clp_a', set: { sourceRange: timeRange(f(12), f(60)) } },
      { op: 'remove_clip', clipId: 'clp_b', ripple: true },
      { op: 'add_clip', trackId: 'trk_v2', clip: clip('clp_x', 'm/b.mov', 0, 36), at: f(0) },
      { op: 'add_marker', marker: { id: 'mrk_run', at: f(3), name: 'run', colour: 'orange' } },
    ]);
    assert.notDeepEqual(shape(b.read()), shape(before));

    assert.equal(b.history.canUndo, true);
    assert.equal(b.history.undo(b.apply), 'tighten the cut');
    assert.deepEqual(shape(b.read()), shape(before), 'four ops went back in one press');
    assert.equal(b.history.canUndo, false);
    assert.equal(b.history.canRedo, true);
  });

  test('redo puts it back', () => {
    const b = bench();
    b.run('trim', [{ op: 'patch_clip', clipId: 'clp_a', set: { name: 'trimmed' } }]);
    const edited = b.read();
    b.history.undo(b.apply);
    assert.equal(b.history.redo(b.apply), 'trim');
    assert.deepEqual(shape(b.read()), shape(edited));
    assert.equal(b.history.canRedo, false);
    assert.equal(b.history.canUndo, true);
  });

  test('a new edit after an undo abandons the redo branch', () => {
    const b = bench();
    b.run('first', [{ op: 'patch_clip', clipId: 'clp_a', set: { name: 'first' } }]);
    b.history.undo(b.apply);
    assert.equal(b.history.canRedo, true);
    b.run('second', [{ op: 'patch_clip', clipId: 'clp_b', set: { name: 'second' } }]);
    assert.equal(b.history.canRedo, false);
    assert.deepEqual(b.history.labels.undo, ['second']);
  });

  test('nothing to undo is null, not a throw', () => {
    const b = bench();
    assert.equal(b.history.undo(b.apply), null);
    assert.equal(b.history.redo(b.apply), null);
    assert.deepEqual(b.history.labels, { undo: [], redo: [] });
  });

  test('a batch the document refuses leaves the stack where it was', () => {
    const b = bench();
    b.history.push('impossible', [{ op: 'remove_clip', clipId: 'clp_ghost' }]);
    assert.throws(() => b.history.undo(b.apply), (err: unknown) => err instanceof EditError);
    assert.equal(b.history.canUndo, true);
    assert.deepEqual(b.history.labels.undo, ['impossible']);
  });

  test('the stack is capped, oldest first', () => {
    const b = bench();
    for (let n = 1; n <= HISTORY_LIMIT + 5; n++) b.history.push(`edit ${n}`, []);
    assert.equal(b.history.labels.undo.length, HISTORY_LIMIT);
    assert.equal(b.history.labels.undo[0], `edit ${HISTORY_LIMIT + 5}`);
    assert.equal(b.history.labels.undo[HISTORY_LIMIT - 1], 'edit 6');
  });

  test('clear empties both directions', () => {
    const b = bench();
    b.run('one', [{ op: 'patch_clip', clipId: 'clp_a', set: { name: 'one' } }]);
    b.history.undo(b.apply);
    b.history.clear();
    assert.equal(b.history.canUndo, false);
    assert.equal(b.history.canRedo, false);
  });
});

describe('marker order survives a round trip and an undo', () => {
  test('an OTIO document with markers out of order comes back sorted', () => {
    // The invariant insertMarker assumes has to be established somewhere, and
    // the import boundary is the only place that sees a foreign document.
    const t = emptyTimeline('t', 'T', RATES.film);
    t.markers = [
      { id: 'mrk_c', at: frames(300), name: 'c', colour: 'red' },
      { id: 'mrk_a', at: frames(100), name: 'a', colour: 'red' },
      { id: 'mrk_b', at: frames(200), name: 'b', colour: 'red' },
    ];
    const back = fromOtio(JSON.parse(JSON.stringify(toOtio(t))), RATES.film);
    assert.deepEqual(back.markers.map((m) => m.id), ['mrk_a', 'mrk_b', 'mrk_c']);
  });

  test('undoing a marker delete puts it back exactly where it was', () => {
    const t = emptyTimeline('t', 'T', RATES.film);
    t.markers = [
      { id: 'mrk_c', at: frames(300), name: 'c', colour: 'red' },
      { id: 'mrk_a', at: frames(100), name: 'a', colour: 'red' },
      { id: 'mrk_b', at: frames(200), name: 'b', colour: 'red' },
    ];
    const doc = fromOtio(JSON.parse(JSON.stringify(toOtio(t))), RATES.film);
    const { timeline: without, inverse } = applyEdits(doc, [{ op: 'remove_marker', markerId: 'mrk_a' }]);
    const { timeline: back } = applyEdits(without, inverse);
    assert.deepEqual(back.markers, doc.markers, 'the inverse has to be exact, not merely correct-ish');
  });
});
