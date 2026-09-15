import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RATES, frames, rangeEnd, timeRange, type Frames, type Rate,
} from '../lib/time/frames.ts';
import {
  clipAt, emptyTimeline, findClip, placeTrack, snapTargets, timelineDuration, trimBounds,
} from '../lib/timeline/document.ts';
import { applyEdits } from '../lib/timeline/edits.ts';
import { demoProject } from '../lib/fixtures/project.ts';
import type {
  Clip, EditOp, MediaRef, PlacedItem, Timeline, Track,
} from '../lib/timeline/types.ts';
import {
  PPF_MAX, PPF_MIN, bladeAt, bladeOps, chooseTicks, clampPpf, contentWidth, dragMove,
  fitPpf, framesToPx, inWindow, laneAtY, laneBoxes, lanesHeight, marqueeBox, marqueeHits,
  moveOps, nearestEdge, nextEdge, playheadLimit, ppfFromZoom, pxToFrameAt, pxToFrames,
  rippleDeleteOps, rippleShifts, snapMove, snapTolerance, snapValue, ticksIn, transitionBox,
  trimClip, trimOps, visibleRange, zoomFromPpf,
  captionSpan, dragCaption, trimCaption, captionOps, captionTextOps,
} from '../components/timeline/interactions.ts';

// ── fixtures ────────────────────────────────────────────────────────────
// 24fps throughout, so a frame is a frame and the numbers stay readable.

const RATE = RATES.film;
const F = (n: number): Frames => frames(n);

function media(key: string, availStart: number, availDur: number): MediaRef {
  return {
    key,
    name: key,
    kind: 'video',
    available: timeRange(F(availStart), F(availDur)),
    rate: RATE,
  };
}

function clip(id: string, srcStart: number, dur: number, mediaKey = 'm1'): Clip {
  return {
    id,
    kind: 'clip',
    name: id,
    mediaKey,
    sourceRange: timeRange(F(srcStart), F(dur)),
    enabled: true,
    effects: [],
  };
}

/**
 * V1: c1 [0,48) from source 24, c2 [48,120) from source 0.
 * Media m1 holds 480 frames starting at 0, so c1 has 24 frames of head and
 * 408 of tail, both limits are reachable in a test without absurd numbers.
 */
function fixture(): Timeline {
  const t = emptyTimeline('tl_1', 'Test', RATE);
  const v1 = t.tracks.find((x) => x.id === 'trk_v1') as Track;
  v1.items = [clip('c1', 24, 48), clip('c2', 0, 72, 'm2')];
  const a1 = t.tracks.find((x) => x.id === 'trk_a1') as Track;
  a1.items = [{ id: 'g1', kind: 'gap', duration: F(12) }, clip('a1', 0, 96, 'm3')];
  t.media = {
    m1: media('m1', 0, 480),
    m2: media('m2', 0, 96),
    m3: media('m3', 0, 600),
  };
  return t;
}

const placedOf = (t: Timeline, id: string): PlacedItem => {
  const p = findClip(t, id);
  assert.ok(p, `fixture is missing clip ${id}`);
  return p;
};

const TRIM_BASE = {
  ppf: 1,
  targets: [] as Frames[],
  tolerance: F(0),
  snapping: false,
} as const;

const trackOf = (t: Timeline, id: string): Track => {
  const track = t.tracks.find((x) => x.id === id);
  assert.ok(track, `fixture is missing track ${id}`);
  return track;
};

/**
 * Apply a batch and read a track back as a string.
 *
 * An op builder can only be trusted through `applyEdits`: the ops are a
 * proposal, and the bugs live in what the document does with them, not in
 * their shape. One line of "who is where" catches a clip that moved, one that
 * lost frames and one that came back under a new id, which is exactly the set
 * of things a bad batch does.
 */
function laidOut(t: Timeline, ops: readonly EditOp[], trackId: string): string {
  const after = applyEdits(t, ops).timeline;
  return placeTrack(trackOf(after, trackId))
    .map((p) => `${p.item.kind === 'clip' ? p.item.id : p.item.kind}[${p.range.start},${rangeEnd(p.range)})`)
    .join(' ');
}

// ── frame ↔ pixel ───────────────────────────────────────────────────────

describe('frames and pixels round-trip', () => {
  test('a frame survives the trip at every zoom level', () => {
    const zooms = [PPF_MIN, 0.03, 0.25, 1, 2.5, 7, 13.37, PPF_MAX];
    const samples = [0, 1, 2, 23, 24, 119, 1000, 86_400].map(F);
    for (const ppf of zooms) {
      for (const f of samples) {
        assert.equal(pxToFrames(framesToPx(f, ppf), ppf), f, `${f} frames at ${ppf} px/frame`);
      }
    }
  });

  test('a position truncates and a delta rounds, they are different questions', () => {
    // 10 px/frame: 15px is 1.5 frames in. You are standing ON frame 1…
    assert.equal(pxToFrameAt(15, 10), 1);
    // …but a drag of 15px has moved you two frames.
    assert.equal(pxToFrames(15, 10), 2);
    assert.equal(pxToFrameAt(9.99, 10), 0);
    assert.equal(pxToFrameAt(10, 10), 1);
  });

  test('negative pixel deltas round symmetrically about zero', () => {
    assert.equal(pxToFrames(-30, 10), -3);
    assert.equal(pxToFrames(-4, 10), -0);
    // the half-frame case is the whole point: rounding toward positive
    // infinity makes a drag left one frame shorter than the same drag right,
    // so a there-and-back nudge leaves the clip a frame off where it started
    for (const px of [5, 15, 25, 35]) {
      assert.equal(pxToFrames(-px, 10), -pxToFrames(px, 10), `${px}px at 10 px/frame`);
    }
  });

  test('a zero or non-finite zoom is refused rather than producing Infinity frames', () => {
    assert.throws(() => pxToFrames(100, 0), /positive finite/);
    assert.throws(() => pxToFrames(100, -2), /positive finite/);
    assert.throws(() => framesToPx(F(10), NaN), /positive finite/);
  });

  test('zoom maps to pixels-per-frame exponentially and back', () => {
    for (const z of [0, 0.17, 0.34, 0.5, 0.9, 1]) {
      assert.ok(Math.abs(zoomFromPpf(ppfFromZoom(z)) - z) < 1e-9, `zoom ${z}`);
    }
    assert.equal(ppfFromZoom(0), PPF_MIN);
    assert.equal(ppfFromZoom(1), PPF_MAX);
    // half the slider is the geometric mean, not the arithmetic one
    assert.ok(ppfFromZoom(0.5) < (PPF_MIN + PPF_MAX) / 2);
  });

  test('zoom input outside 0…1 is clamped, never extrapolated', () => {
    assert.equal(ppfFromZoom(-5), PPF_MIN);
    assert.equal(ppfFromZoom(99), PPF_MAX);
    assert.equal(clampPpf(1e6), PPF_MAX);
    assert.equal(clampPpf(1e-9), PPF_MIN);
  });

  test('fit puts the whole edit on screen and stays inside the zoom range', () => {
    const ppf = fitPpf(F(1200), 800);
    assert.ok(framesToPx(F(1200), ppf) <= 800);
    assert.equal(fitPpf(F(0), 800), PPF_MIN);          // an empty timeline has nothing to fit
    assert.equal(fitPpf(F(100_000_000), 800), PPF_MIN); // longer than the zoom range allows
  });
});

// ── snapping ────────────────────────────────────────────────────────────

describe('snapping', () => {
  const targets = [0, 48, 120, 300].map(F);

  test('the nearest target inside tolerance wins', () => {
    assert.deepEqual(snapValue(F(50), targets, F(6)), { value: F(48), hit: F(48) });
    assert.deepEqual(snapValue(F(115), targets, F(6)), { value: F(120), hit: F(120) });
  });

  test('outside tolerance the value is left exactly alone', () => {
    assert.deepEqual(snapValue(F(60), targets, F(6)), { value: F(60), hit: null });
    // one frame past the tolerance is outside it
    assert.deepEqual(snapValue(F(55), targets, F(6)), { value: F(55), hit: null });
    // and exactly at the tolerance is inside it
    assert.deepEqual(snapValue(F(54), targets, F(6)), { value: F(48), hit: F(48) });
  });

  test('the nearer of two targets wins, not the first one found', () => {
    const near = [100, 110].map(F);
    assert.equal(snapValue(F(108), near, F(20)).value, F(110));
    assert.equal(snapValue(F(102), near, F(20)).value, F(100));
  });

  test('a zero tolerance still snaps on an exact hit and nothing else', () => {
    // zoomed in past a frame per 8px, snapping must not fight a frame-nudge
    assert.equal(snapValue(F(48), targets, F(0)).hit, F(48));
    assert.equal(snapValue(F(49), targets, F(0)).hit, null);
  });

  test('tolerance in frames follows the zoom and floors at zero', () => {
    assert.equal(snapTolerance(1), 8);    // 1 px/frame: 8px is 8 frames
    assert.equal(snapTolerance(4), 2);
    assert.equal(snapTolerance(16), 0);   // 16 px/frame: 8px is less than a frame
    assert.equal(snapTolerance(0.1), 80);
  });

  test('a moving clip snaps by whichever edge is closer', () => {
    // head at 44 is 4 from the cut at 48; tail at 44+72=116 is 4 from 120.
    // Tie goes to the head, which is the edge under the pointer.
    assert.deepEqual(snapMove(F(44), F(72), targets, F(6)), { value: F(48), hit: F(48) });
    // head at 40 is 8 away (outside), tail at 112 is 8 from 120 (outside)
    assert.equal(snapMove(F(40), F(72), targets, F(6)).hit, null);
    // a 70-frame clip at 52: head is 4 from the cut at 48, tail is 2 from the
    // cut at 120. The tail is nearer, so the head lands where the TAIL sticks.
    assert.deepEqual(snapMove(F(52), F(70), targets, F(6)), { value: F(50), hit: F(120) });
  });
});

// ── dragging ────────────────────────────────────────────────────────────

describe('dragging a clip', () => {
  const base = { duration: F(48), ppf: 2, targets: [] as Frames[], tolerance: F(0), snapping: false };

  test('a drag that would go negative clamps at frame zero', () => {
    assert.equal(dragMove({ ...base, origin: F(24), deltaPx: -1000 }).start, 0);
    assert.equal(dragMove({ ...base, origin: F(0), deltaPx: -1 }).start, 0);
    // and clamping is not a one-way street, it can still come back
    assert.equal(dragMove({ ...base, origin: F(24), deltaPx: 100 }).start, 74);
  });

  test('the drag is measured from where it began, not accumulated', () => {
    // three 5px nudges at 2px/frame: accumulating would round each to 3 frames
    // and land on 9; measuring total travel lands on 8, which is correct.
    assert.equal(dragMove({ ...base, origin: F(0), deltaPx: 15 }).start, 8);
  });

  test('a snap never pushes the head below zero', () => {
    // a 120-frame clip at 10, with the only cut at 100: the tail is 30 frames
    // from it and would snap by pulling the head to -20. Zero outranks the
    // snap, so the drag is left exactly where the pointer put it.
    const r = dragMove({
      ...base, duration: F(120), origin: F(10), deltaPx: 0, snapping: true,
      targets: [F(100)], tolerance: F(32),
    });
    assert.equal(r.start, 10);
    assert.equal(r.hit, null);
  });

  test('snapping off means the frame under the pointer, exactly', () => {
    const r = dragMove({
      ...base, origin: F(100), deltaPx: 2, snapping: false,
      targets: [F(101)], tolerance: F(24),
    });
    assert.equal(r.start, 101);
    assert.equal(r.hit, null); // no snap line is drawn for a coincidence
  });
});

// ── trimming ────────────────────────────────────────────────────────────

describe('trimming against the available media', () => {
  const t = fixture();
  const c1 = placedOf(t, 'c1');       // [0,48) on the timeline, source [24,72) of 480
  const m1 = t.media.m1;

  test('the fixture is what the trim tests think it is', () => {
    assert.deepEqual(c1.range, timeRange(F(0), F(48)));
    assert.deepEqual(trimBounds(c1, m1), { minStart: F(0), maxEnd: F(456) });
  });

  test('the in-handle cannot pull out source that was never shot', () => {
    // 24 frames of head exist, but the clip starts at timeline zero, so the
    // real wall is zero. Dragging a mile left stops there.
    const r = trimClip({ ...TRIM_BASE, placed: c1, media: m1, edge: 'in', deltaPx: -5000 });
    assert.equal(r.start, 0);
    assert.ok(r.clamped);
    assert.equal(r.sourceRange.start, 24);           // source untouched
    assert.equal(r.sourceRange.duration, 48);
  });

  test('a clip further down the track can use its whole head', () => {
    const t2 = fixture();
    const v1 = t2.tracks.find((x) => x.id === 'trk_v1') as Track;
    v1.items = [{ id: 'g0', kind: 'gap', duration: F(96) }, clip('c1', 24, 48)];
    const p = placedOf(t2, 'c1');                    // now at [96,144)
    assert.deepEqual(trimBounds(p, m1), { minStart: F(72), maxEnd: F(552) });

    const r = trimClip({ ...TRIM_BASE, placed: p, media: m1, edge: 'in', deltaPx: -5000 });
    assert.equal(r.start, 72);                       // 96 - 24 frames of head
    assert.equal(r.sourceRange.start, 0);            // exactly the first frame of media
    assert.equal(r.sourceRange.duration, 72);
    assert.ok(r.sourceRange.start >= m1.available.start);
  });

  test('the out-handle cannot run past the end of the media', () => {
    const r = trimClip({ ...TRIM_BASE, placed: c1, media: m1, edge: 'out', deltaPx: 5000 });
    assert.equal(r.start, 0);
    assert.ok(r.clamped);
    assert.equal(r.sourceRange.duration, 456);       // 480 available, 24 already consumed
    assert.equal(rangeEnd(r.sourceRange), rangeEnd(m1.available));
  });

  test('neither handle can be trimmed past the other', () => {
    const inward = trimClip({ ...TRIM_BASE, placed: c1, media: m1, edge: 'in', deltaPx: 5000 });
    assert.equal(inward.sourceRange.duration, 1);    // one frame is the floor
    assert.equal(inward.start, 47);

    const outward = trimClip({ ...TRIM_BASE, placed: c1, media: m1, edge: 'out', deltaPx: -5000 });
    assert.equal(outward.sourceRange.duration, 1);
    assert.equal(outward.start, 0);
  });

  test('an ordinary trim moves start and source by exactly the same amount', () => {
    const r = trimClip({ ...TRIM_BASE, placed: c1, media: m1, edge: 'in', deltaPx: 12 });
    assert.equal(r.start, 12);
    assert.equal(r.sourceRange.start, 36);
    assert.equal(r.sourceRange.duration, 36);        // the clip got 12 frames shorter
    assert.ok(!r.clamped);
  });

  test('an out-trim leaves the clip where it is', () => {
    const r = trimClip({ ...TRIM_BASE, placed: c1, media: m1, edge: 'out', deltaPx: -12 });
    assert.equal(r.start, c1.range.start);
    assert.equal(r.sourceRange.start, 24);           // the in-point is untouched
    assert.equal(r.sourceRange.duration, 36);
  });

  test('with no media the source cannot be pulled below zero either', () => {
    const r = trimClip({ ...TRIM_BASE, placed: c1, media: undefined, edge: 'in', deltaPx: -5000 });
    assert.ok(r.sourceRange.start >= 0);
    // c1 sits at timeline 0 with 24 frames of source head, so zero is the wall
    assert.equal(r.start, 0);
    assert.equal(r.sourceRange.start, 24);
  });

  test('a snapped handle still stops at the media limit', () => {
    // a cut sits at 600, well past the 456 the media can reach
    const r = trimClip({
      ...TRIM_BASE, placed: c1, media: m1, edge: 'out',
      deltaPx: 550, snapping: true, targets: [F(600)], tolerance: F(24),
    });
    assert.equal(rangeEnd(timeRange(r.start, r.sourceRange.duration)), 456);
    assert.ok(r.clamped);
    assert.equal(r.hit, null);  // no snap line: it did not actually reach the cut
  });

  test('a trim inside range reports the target it snapped to', () => {
    const r = trimClip({
      ...TRIM_BASE, placed: c1, media: m1, edge: 'out',
      deltaPx: 70, snapping: true, targets: [F(120)], tolerance: F(8),
    });
    assert.equal(r.sourceRange.duration, 120);
    assert.equal(r.hit, F(120));
    assert.ok(!r.clamped);
  });

  test('a gap cannot be trimmed, it is not a clip', () => {
    const gap = placeTrack(t.tracks.find((x) => x.id === 'trk_a1') as Track)[0];
    assert.throws(
      () => trimClip({ ...TRIM_BASE, placed: gap, media: undefined, edge: 'in', deltaPx: 4 }),
      /only a clip can be trimmed/,
    );
  });

  test('trim mode grabs the nearer edge of whatever was clicked', () => {
    // the clip body is a way of saying "the near edge of this clip": at a
    // zoom where a shot is 20px wide the two handles are not separately
    // hittable, which is what the mode is for
    assert.equal(nearestEdge(c1.range, F(1)), 'in');
    assert.equal(nearestEdge(c1.range, F(47)), 'out');
    assert.equal(nearestEdge(c1.range, F(24)), 'in');   // a tie goes to the head
    assert.equal(nearestEdge(c1.range, F(25)), 'out');
  });

  test('an in-trim leaves the head where it was dropped and the next clip alone', () => {
    const t2 = fixture();
    const p = placedOf(t2, 'c1');
    const inward = trimClip({ ...TRIM_BASE, placed: p, media: m1, edge: 'in', deltaPx: 12 });
    // a move_clip here drops as an overwrite onto a track the patch has
    // already pulled left, which eats 12 frames off c2 and renames it
    assert.equal(
      laidOut(t2, trimOps(p, inward, trackOf(t2, 'trk_v1')), 'trk_v1'),
      'gap[0,12) c1[12,48) c2[48,120)',
    );
  });

  test('an out-trim gives its frames back as a gap, it does not drag the track left', () => {
    const t2 = fixture();
    const p = placedOf(t2, 'c1');
    const outward = trimClip({ ...TRIM_BASE, placed: p, media: m1, edge: 'out', deltaPx: -12 });
    assert.equal(
      laidOut(t2, trimOps(p, outward, trackOf(t2, 'trk_v1')), 'trk_v1'),
      'c1[0,36) gap[36,48) c2[48,120)',
    );
  });

  test('trimming the last shot on a track shortens the track', () => {
    // there is nothing after it to hold in place, and a trailing gap would
    // leave the edit as long as it was before the trim
    const t2 = fixture();
    const p = placedOf(t2, 'c2');
    const outward = trimClip({ ...TRIM_BASE, placed: p, media: t2.media.m2, edge: 'out', deltaPx: -24 });
    assert.equal(
      laidOut(t2, trimOps(p, outward, trackOf(t2, 'trk_v1')), 'trk_v1'),
      'c1[0,48) c2[48,96)',
    );
  });

  test('a trim never invents, renames or shortens a clip it was not holding', () => {
    // every clip in a real cut, both handles, both directions
    const t2 = demoProject();
    const damage: string[] = [];
    for (const track of t2.tracks) {
      for (const p of placeTrack(track)) {
        if (p.item.kind !== 'clip') continue;
        const before = new Map(
          t2.tracks.flatMap((x) => placeTrack(x))
            .filter((q) => q.item.kind === 'clip')
            .map((q) => [q.item.id, q.range.duration]),
        );
        for (const edge of ['in', 'out'] as const) {
          for (const deltaPx of [-12, 12]) {
            const r = trimClip({
              ...TRIM_BASE, placed: p, media: t2.media[(p.item as Clip).mediaKey], edge, deltaPx,
            });
            const after = applyEdits(t2, trimOps(p, r, track)).timeline;
            for (const q of after.tracks.flatMap((x) => placeTrack(x))) {
              if (q.item.kind !== 'clip' || q.item.id === p.item.id) continue;
              const was = before.get(q.item.id);
              if (was === undefined) damage.push(`${p.item.id} ${edge} ${deltaPx}: invented ${q.item.id}`);
              else if (was !== q.range.duration) {
                damage.push(`${p.item.id} ${edge} ${deltaPx}: ${q.item.id} lost ${was - q.range.duration} frames`);
              }
            }
          }
        }
      }
    }
    assert.deepEqual(damage, [], damage.slice(0, 8).join('\n'));
  });
});

// ── blade ───────────────────────────────────────────────────────────────

describe('blade', () => {
  const t = fixture();
  const c1 = placedOf(t, 'c1');   // [0,48), source [24,72)

  test('the two halves sum to the original, frame for frame', () => {
    for (const at of [1, 12, 24, 33, 47].map(F)) {
      const cut = bladeAt(c1, at);
      assert.ok(cut, `blade at ${at}`);
      assert.equal(
        cut.left.duration + cut.right.duration,
        c1.range.duration,
        `durations must sum at ${at}`,
      );
      // and the source is continuous across the cut: no frame invented or lost
      assert.equal(rangeEnd(cut.left), cut.right.start);
      assert.equal(cut.left.start, (c1.item as Clip).sourceRange.start);
      assert.equal(rangeEnd(cut.right), rangeEnd((c1.item as Clip).sourceRange));
    }
  });

  test('a cut on either boundary is not a cut at all', () => {
    assert.equal(bladeAt(c1, F(0)), null);    // the first frame, left half would be empty
    assert.equal(bladeAt(c1, F(48)), null);   // rangeEnd is already the NEXT clip
    assert.equal(bladeAt(c1, F(49)), null);
    assert.equal(bladeAt(c1, F(-1)), null);
    assert.ok(bladeAt(c1, F(47)));            // the last frame in the clip still cuts
  });

  test('the new clip lands at the cut and keeps the media behind it', () => {
    const ops = bladeOps(c1, F(20), 'clp_new');
    assert.equal(ops.length, 2);
    const patch = ops[0];
    const add = ops[1];
    assert.equal(patch.op, 'patch_clip');
    assert.equal(add.op, 'add_clip');
    if (patch.op !== 'patch_clip' || add.op !== 'add_clip') return;
    assert.deepEqual(patch.set.sourceRange, timeRange(F(24), F(20)));
    assert.equal(add.at, 20);
    assert.equal(add.clip.id, 'clp_new');
    assert.equal(add.clip.mediaKey, 'm1');
    assert.deepEqual(add.clip.sourceRange, timeRange(F(44), F(28)));
    assert.notEqual(add.clip.effects, (c1.item as Clip).effects); // copied, not shared
  });

  test('a blade that cannot cut emits nothing at all', () => {
    assert.deepEqual(bladeOps(c1, F(48), 'clp_new'), []);
  });

  test('the cut lands in the document without moving anything else', () => {
    const t2 = fixture();
    const p = placedOf(t2, 'c1');
    assert.equal(
      laidOut(t2, bladeOps(p, F(20), 'clp_new'), 'trk_v1'),
      'c1[0,20) clp_new[20,48) c2[48,120)',
    );
  });
});

// ── ripple ──────────────────────────────────────────────────────────────

describe('ripple', () => {
  test('auto-select off holds a track still while the rest closes up', () => {
    const t = fixture();
    const music = t.tracks.find((x) => x.id === 'trk_a3') as Track;
    music.items = [clip('mu', 0, 400, 'm3')];
    const dialogue = t.tracks.find((x) => x.id === 'trk_a1') as Track;

    const all = rippleShifts(t, F(0), F(48));
    assert.ok(all.some((s) => s.trackId === 'trk_a3'));

    music.autoSelect = false;
    const held = rippleShifts(t, F(0), F(48));
    assert.ok(!held.some((s) => s.trackId === 'trk_a3'), 'music must not move');
    assert.ok(held.some((s) => s.trackId === 'trk_a1'), 'dialogue still ripples');

    dialogue.locked = true;
    assert.ok(!rippleShifts(t, F(0), F(48)).some((s) => s.trackId === 'trk_a1'));
  });

  test('only clips at or after the cut move, and never below zero', () => {
    const t = fixture();
    const shifts = rippleShifts(t, F(48), F(48));
    // c1 is [0,48) and ends before the cut. a1 is [12,108) and STRADDLES it,
    // a ripple moves whole clips, so a straddling clip holds its position and
    // the cut lands inside it rather than teleporting it backwards.
    assert.deepEqual(shifts.map((s) => s.clipId).sort(), ['c2']);
    const c2 = shifts.find((s) => s.clipId === 'c2');
    assert.deepEqual([c2?.from, c2?.to], [48, 0]);

    // a ripple bigger than the position cannot push a clip before the timeline
    const huge = rippleShifts(t, F(0), F(10_000));
    assert.ok(huge.every((s) => s.to >= 0));
  });

  test('a zero-length ripple moves nothing', () => {
    assert.deepEqual(rippleShifts(fixture(), F(0), F(0)), []);
  });

  test('the home track closes its own hole and is not rippled twice', () => {
    const t = fixture();
    const ops = rippleDeleteOps(t, placedOf(t, 'c1'));
    // the batch has to APPLY. A second op per shifted clip addresses ids the
    // ripple has already consumed, and takes the whole batch down with it
    assert.equal(laidOut(t, ops, 'trk_v1'), 'c2[0,72)');
    // and the hole closed on the listening audio track too
    assert.equal(rangeEnd(placeTrack(trackOf(applyEdits(t, ops).timeline, 'trk_a1'))[0].range), 60);
  });

  test('every clip in the shipped project can be deleted', () => {
    // the batch is built against the document as it stands, so a builder that
    // is position-dependent rather than id-addressed fails on most of a real
    // cut and on none of a two-clip fixture
    const t = demoProject();
    const clips = t.tracks.flatMap((track) => placeTrack(track)).filter((p) => p.item.kind === 'clip');
    assert.equal(clips.length, 18);
    const refused: string[] = [];
    for (const p of clips) {
      const ops = rippleDeleteOps(t, p);
      assert.ok(ops.length, `${p.item.id} produced no ops at all`);
      try {
        const after = applyEdits(t, ops).timeline;
        const left = after.tracks.flatMap((track) => placeTrack(track))
          .filter((q) => q.item.kind === 'clip');
        assert.ok(!left.some((q) => q.item.id === p.item.id), `${p.item.id} survived its own delete`);
      } catch (err) {
        refused.push(`${p.item.id}: ${(err as Error).message}`);
      }
    }
    assert.deepEqual(refused, [], `the core interaction of an editor:\n${refused.join('\n')}`);
  });

  test('a locked track refuses the delete outright', () => {
    const t = fixture();
    trackOf(t, 'trk_v1').locked = true;
    assert.deepEqual(rippleDeleteOps(t, placedOf(t, 'c1')), []);
  });

  test('with auto-select off on its own track the hole stays open', () => {
    const t = fixture();
    trackOf(t, 'trk_v1').autoSelect = false;
    const ops = rippleDeleteOps(t, placedOf(t, 'c1'));
    // the clip goes, the hole it left does not: that is what the A toggle
    // buys, and it has to mean the same thing on the clip's own track as it
    // does on every other one
    assert.equal(laidOut(t, ops, 'trk_v1'), 'gap[0,48) c2[48,120)');
    // while the tracks that ARE listening still close up
    assert.equal(rangeEnd(placeTrack(trackOf(applyEdits(t, ops).timeline, 'trk_a1'))[0].range), 60);
  });

  test('a ripple delete undoes back to the document it started from', () => {
    const t = fixture();
    const before = laidOut(t, [], 'trk_v1') + ' | ' + laidOut(t, [], 'trk_a1');
    const { timeline: after, inverse } = applyEdits(t, rippleDeleteOps(t, placedOf(t, 'c1')));
    const back = applyEdits(after, inverse).timeline;
    assert.equal(laidOut(back, [], 'trk_v1') + ' | ' + laidOut(back, [], 'trk_a1'), before);
  });

  test('a move that changes nothing emits nothing', () => {
    const t = fixture();
    const c1 = placedOf(t, 'c1');
    assert.deepEqual(moveOps(c1, c1.range.start, 'trk_v1'), []);
    assert.equal(moveOps(c1, F(96), 'trk_v1').length, 1);
    assert.equal(moveOps(c1, c1.range.start, 'trk_v2').length, 1); // same frame, other track
  });
});

// ── the visible window ──────────────────────────────────────────────────

describe('virtualisation by visible window', () => {
  test('the window covers the viewport plus overscan, in frames', () => {
    const win = visibleRange(1000, 800, 2, 200);
    assert.equal(win.start, 400);                    // (1000-200)/2
    assert.equal(rangeEnd(win), 1000);               // (1000+800+200)/2
  });

  test('the window never begins before zero', () => {
    const win = visibleRange(0, 800, 2, 200);
    assert.equal(win.start, 0);
    assert.ok(win.duration > 0);
  });

  test('an item touching the window edge is in; one ending on it is out', () => {
    const win = timeRange(F(100), F(100));           // [100,200)
    assert.ok(inWindow(timeRange(F(190), F(20)), win));
    assert.ok(inWindow(timeRange(F(0), F(101)), win));
    assert.ok(!inWindow(timeRange(F(0), F(100)), win), 'ends exactly at 100, so it is off screen');
    assert.ok(!inWindow(timeRange(F(200), F(50)), win), 'starts exactly at 200, so it is off screen');
    assert.ok(!inWindow(timeRange(F(150), F(0)), win), 'a zero-duration item covers no pixel');
  });

  test('content is at least as wide as the viewport, and wider than the edit', () => {
    const t = fixture();
    assert.ok(contentWidth(t, 1, 5000) >= 5000);
    assert.ok(contentWidth(t, 1, 0) > 120);          // the longest track is 120 frames
  });

  test('the scroll width is a whole number of pixels at every zoom', () => {
    const t = fixture();
    for (const ppf of [PPF_MIN, 0.6, 1, 2.5, 7.3, PPF_MAX]) {
      const w = contentWidth(t, ppf, 0);
      // a fractional width leaves a sub-pixel seam and puts every clip's left
      // edge off the device pixel grid
      assert.ok(Number.isInteger(w), `${w} at ${ppf} px/frame is not a whole pixel`);
    }
  });
});

// ── ruler ───────────────────────────────────────────────────────────────

describe('ruler ticks', () => {
  test('a label always has room, and the step only grows as you zoom out', () => {
    // every rate the project can be at, not just the one where a second is a
    // round 24 frames: at 29.97 ten seconds is 300 frames and thirty is 899,
    // and a minor step that is a rounded fraction of THAT walks away from the
    // labels it is supposed to sit between
    for (const [name, rate] of Object.entries(RATES) as [string, Rate][]) {
      let previous = 0;
      for (const ppf of [20, 10, 4, 2, 1, 0.5, 0.2, 0.08, 0.03, PPF_MIN]) {
        const { major, minor } = chooseTicks(ppf, rate);
        assert.ok(major * ppf >= 58 || major === chooseTicks(PPF_MIN, rate).major,
          `${name}: ${major} frames at ${ppf} px/frame is too narrow to label`);
        assert.ok(major >= previous, `${name}: zooming out must not produce finer ticks`);
        assert.ok(minor >= 1 && minor <= major, `${name} at ${ppf}`);
        assert.equal(major % minor, 0,
          `${name} at ${ppf} px/frame: ${minor} does not divide ${major}`);
        previous = major;
      }
    }
  });

  test('zoomed all the way in the ruler counts frames, not seconds', () => {
    assert.equal(chooseTicks(PPF_MAX, RATE).major, 5);
    assert.equal(chooseTicks(60, RATE).major, 1);
  });

  test('ticks sit on absolute time, not on the scroll position', () => {
    const ticks = ticksIn(timeRange(F(130), F(100)), F(48));
    assert.ok(ticks.every((t) => t % 48 === 0));
    assert.ok(ticks[0] <= 130, 'the tick before the window must be drawn: its label overhangs');
    assert.ok(ticks.some((t) => t >= 230), 'and the one after it, for the same reason');
    assert.throws(() => ticksIn(timeRange(F(0), F(10)), F(0)), /positive/);
  });

  test('a transition straddles its cut and is clamped at zero', () => {
    assert.deepEqual(transitionBox(F(100), F(12), F(12)), timeRange(F(88), F(24)));
    assert.deepEqual(transitionBox(F(4), F(12), F(12)), timeRange(F(0), F(16)));
  });
});

// ── lanes ───────────────────────────────────────────────────────────────

describe('lane geometry', () => {
  const t = fixture();
  const boxes = laneBoxes(t.tracks);

  test('lanes stack with no gap and no overlap', () => {
    for (let i = 1; i < boxes.length; i++) {
      assert.equal(boxes[i].top, boxes[i - 1].top + boxes[i - 1].height);
    }
    assert.equal(lanesHeight(boxes), boxes[boxes.length - 1].top + boxes[boxes.length - 1].height);
  });

  test('the boundary pixel belongs to the lane below', () => {
    const second = boxes[1];
    assert.equal(laneAtY(boxes, second.top)?.trackId, second.trackId);
    assert.equal(laneAtY(boxes, second.top - 1)?.trackId, boxes[0].trackId);
    assert.equal(laneAtY(boxes, second.top + second.height)?.trackId, boxes[2].trackId);
  });

  test('outside the stack there is no lane, rather than the nearest one', () => {
    assert.equal(laneAtY(boxes, -1), null);
    assert.equal(laneAtY(boxes, lanesHeight(boxes)), null);
  });

  test('audio lanes are shorter than video lanes', () => {
    const video = boxes.find((b) => b.kind === 'video');
    const audio = boxes.find((b) => b.kind === 'audio');
    assert.ok(video && audio && audio.height < video.height);
  });
});

// ── marquee ─────────────────────────────────────────────────────────────

/**
 * The standard template, so the lane tops are the ones the app really uses:
 * V2 [0,68), V1 [68,136), A1 [136,182), A2 [182,228), A3 [228,274).
 * V1 holds c1 [0,48) and c2 [48,120); A1 holds a gap of 12 then a1 [12,108).
 */
describe('marquee selection', () => {
  const t = fixture();
  const lanes = t.tracks.map((track) => ({ track, placed: placeTrack(track) }));
  const boxes = laneBoxes(t.tracks);
  const V1 = boxes.find((b) => b.trackId === 'trk_v1') as typeof boxes[number];
  const A1 = boxes.find((b) => b.trackId === 'trk_a1') as typeof boxes[number];

  // a band over nothing would pass every assertion below by accident
  test('the fixture has clips to catch', () => {
    assert.ok(V1 && A1);
    const ids = lanes.flatMap(({ placed }) => placed.filter((p) => p.item.kind === 'clip').map((p) => p.item.id));
    assert.deepEqual(ids.sort(), ['a1', 'c1', 'c2']);
  });

  test('a band drawn around a lane takes every clip on it', () => {
    const box = marqueeBox(0, V1.top + 4, 400, V1.top + V1.height - 4);
    assert.deepEqual(marqueeHits(lanes, boxes, box, 1).sort(), ['c1', 'c2']);
  });

  test('a band across two lanes takes the clips on both', () => {
    const box = marqueeBox(0, V1.top + 4, 400, A1.top + 4);
    assert.deepEqual(marqueeHits(lanes, boxes, box, 1).sort(), ['a1', 'c1', 'c2']);
  });

  test('dragged up-left is the same band as dragged down-right', () => {
    const down = marqueeBox(10, V1.top + 4, 400, A1.top + 4);
    const up = marqueeBox(400, A1.top + 4, 10, V1.top + 4);
    assert.deepEqual(up, down);
    assert.deepEqual(marqueeHits(lanes, boxes, up, 1), marqueeHits(lanes, boxes, down, 1));
  });

  test('a band inside one clip takes that clip and not its neighbour', () => {
    // wholly within c1 [0,48): touching is enough, containment is not required
    const box = marqueeBox(20, V1.top + 10, 30, V1.top + 20);
    assert.deepEqual(marqueeHits(lanes, boxes, box, 1), ['c1']);
  });

  test('a band in a gap takes nothing', () => {
    // A1 opens with a 12 frame gap, and a gap is not a clip
    const box = marqueeBox(0, A1.top + 4, 11, A1.top + 20);
    assert.deepEqual(marqueeHits(lanes, boxes, box, 1), []);
  });

  test('a band that stops on a lane top has not reached into that lane', () => {
    const above = marqueeBox(0, 0, 400, V1.top);
    assert.deepEqual(marqueeHits(lanes, boxes, above, 1), []);
    const into = marqueeBox(0, 0, 400, V1.top + 1);
    assert.deepEqual(marqueeHits(lanes, boxes, into, 1).sort(), ['c1', 'c2']);
  });

  test('a band past the last clip takes nothing', () => {
    const box = marqueeBox(200, V1.top + 4, 300, A1.top + 4);
    assert.deepEqual(marqueeHits(lanes, boxes, box, 1), []);
  });

  test('a few pixels at full zoom still catch the clip under them', () => {
    // 24 px per frame: 3px of travel is an eighth of a frame, and flooring
    // both edges gives a zero-length range sitting on c2's first frame
    const left = framesToPx(F(48), 24);
    const box = marqueeBox(left, V1.top + 10, left + 3, V1.top + 20);
    assert.equal(box.width, 3);
    assert.deepEqual(marqueeHits(lanes, boxes, box, 24), ['c2']);
  });

  test('the band selects by where it is, not by what was selected before', () => {
    // shrinking a band back off c2 has to give c2 up again, which is only
    // true because the hit set is recomputed rather than accumulated
    const wide = marqueeBox(0, V1.top + 4, 400, V1.top + 20);
    const narrow = marqueeBox(0, V1.top + 4, 20, V1.top + 20);
    assert.deepEqual(marqueeHits(lanes, boxes, wide, 1).sort(), ['c1', 'c2']);
    assert.deepEqual(marqueeHits(lanes, boxes, narrow, 1), ['c1']);
  });
});

// ── navigation ──────────────────────────────────────────────────────────

describe('walking the edit', () => {
  const t = fixture();
  const targets = snapTargets(t);

  test('the cut points are every edge on every track, plus zero', () => {
    assert.deepEqual(targets, [0, 12, 48, 108, 120].map(F));
  });

  test('up and down land on the next edge, never on the current one', () => {
    assert.equal(nextEdge(targets, F(0), 1), 12);
    assert.equal(nextEdge(targets, F(12), 1), 48);
    assert.equal(nextEdge(targets, F(48), -1), 12);
    assert.equal(nextEdge(targets, F(120), 1), null);   // the end of the edit
    assert.equal(nextEdge(targets, F(0), -1), null);
    assert.equal(nextEdge(targets, F(50), -1), 48);
  });

  test('a clip being dragged is excluded from its own snap targets', () => {
    // a1 is [12,108) and the only clip that reaches 108, dragging it takes
    // that target with it, or the clip would snap to where it already is
    const solo = snapTargets(t, 'a1');
    assert.ok(!solo.includes(F(108)));
    assert.ok(solo.includes(F(48)));
    // 48 survives dragging c1, because c2 starts on the same frame
    assert.ok(snapTargets(t, 'c1').includes(F(48)));
  });
});

// ── the playhead's range ────────────────────────────────────────────────

describe('how far the playhead may go', () => {
  test('the limit is the last frame of the edit, not its length', () => {
    const t = fixture();
    const duration = timelineDuration(t);
    assert.equal(duration, 120);
    const limit = playheadLimit(duration);
    assert.equal(limit, 119);
    // the test that matters is not the arithmetic: parking on the limit has
    // to leave something on screen, and `duration` is the first frame that is
    // in no clip, so playback would stop on a black program viewer
    assert.ok(clipAt(t, limit), 'the limit frame must be inside a clip');
    assert.equal(clipAt(t, duration), null, 'the duration frame is past the edit');
  });

  test('an empty edit holds the playhead at zero rather than at minus one', () => {
    assert.equal(playheadLimit(timelineDuration(emptyTimeline('t', 'T', RATE))), 0);
  });
});

// ── the load-bearing colours ────────────────────────────────────────────

describe('semantic colours', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'timeline');

  test('red and yellow are named through their token, never spelled out', () => {
    /**
     * AGENTS.md: "the semantic colours from Resolve are load-bearing, not
     * decorative: red playhead, amber dynamic trim". A literal copy of a
     * token's value neither follows a palette change nor switches with the
     * mode, and the house rule only catches hex, so the rgb() spelling of the
     * same colour slips through it.
     */
    const banned: [string, string][] = [['--red', '255,74,74'], ['--yellow', '224,168,46']];
    const offenders: string[] = [];
    for (const file of ['Playhead.tsx', 'Clip.tsx', 'Lane.tsx', 'Ruler.tsx', 'Timeline.tsx', 'TrackHeaders.tsx']) {
      const text = readFileSync(join(dir, file), 'utf8');
      text.split('\n').forEach((line, i) => {
        for (const [token, literal] of banned) {
          if (line.replace(/\s/g, '').includes(literal)) {
            offenders.push(`${file}:${i + 1} spells out var(${token})`);
          }
        }
      });
    }
    assert.deepEqual(offenders, [], offenders.join('\n'));
  });

  test('nothing in the timeline works out what a second is by itself', () => {
    /**
     * AGENTS.md: "lib/time/frames.ts is the only place seconds or
     * RationalTime appear". A rate taken apart into num and den anywhere else
     * is a seconds conversion written a second time, and the second copy is
     * the one that rounds differently.
     */
    const offenders: string[] = [];
    for (const file of ['Playhead.tsx', 'Clip.tsx', 'Lane.tsx', 'Ruler.tsx', 'Timeline.tsx', 'TrackHeaders.tsx', 'interactions.ts', 'useTimelineView.ts']) {
      readFileSync(join(dir, file), 'utf8').split('\n').forEach((line, i) => {
        if (/\brate\s*\.\s*(num|den)\b|\.rate\.(num|den)\b/.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
    }
    assert.deepEqual(offenders, [], `framesToSeconds and rateFps exist:\n${offenders.join('\n')}`);
  });
});

// ── captions on the timeline ────────────────────────────────────────────

/**
 * A subtitle track with three cues, gaps between them:
 *   one [24,48)   two [72,96)   three [120,144)
 *
 * The gaps are the room a cue can be dragged into; the cues either side are
 * the walls it stops at.
 */
function captionFixture(): Timeline {
  const t = emptyTimeline('tl_c', 'Captions', RATE);
  const track: Track = {
    id: 'trk_s1', kind: 'subtitle', name: 'Subtitles 1',
    locked: false, muted: false, solo: false, enabled: true, autoSelect: true,
    items: [
      { id: 'g0', kind: 'gap', duration: F(24) },
      { id: 'cap1', kind: 'caption', text: 'one', duration: F(24), enabled: true },
      { id: 'g1', kind: 'gap', duration: F(24) },
      { id: 'cap2', kind: 'caption', text: 'two', duration: F(24), enabled: true },
      { id: 'g2', kind: 'gap', duration: F(24) },
      { id: 'cap3', kind: 'caption', text: 'three', duration: F(24), enabled: true },
    ],
  };
  return { ...t, tracks: [...t.tracks, track] };
}

const capPlaced = (t: Timeline, id: string): PlacedItem => {
  const all = placeTrack(trackOf(t, 'trk_s1')).map((p) => ({ ...p, trackId: 'trk_s1' as const }));
  const found = all.find((p) => p.item.id === id);
  assert.ok(found, `fixture is missing caption ${id}`);
  return found;
};

const capAll = (t: Timeline): PlacedItem[] =>
  placeTrack(trackOf(t, 'trk_s1')).map((p) => ({ ...p, trackId: 'trk_s1' as const }));

const CAP_BASE = { ppf: 1, targets: [] as Frames[], tolerance: F(0), snapping: false };

describe('the room a cue has', () => {
  test('the fixture is three cues with gaps between them', () => {
    const t = captionFixture();
    assert.deepEqual(
      capAll(t).filter((p) => p.item.kind === 'caption').map((p) => p.range.start),
      [F(24), F(72), F(120)],
    );
  });

  test('a cue between two others is walled by both', () => {
    const t = captionFixture();
    assert.deepEqual(captionSpan(capPlaced(t, 'cap2'), capAll(t)), { lo: F(48), hi: F(120) });
  });

  test('the first cue can go back to zero, the last one runs on forever', () => {
    const t = captionFixture();
    assert.equal(captionSpan(capPlaced(t, 'cap1'), capAll(t)).lo, F(0));
    assert.equal(captionSpan(capPlaced(t, 'cap3'), capAll(t)).hi, Number.MAX_SAFE_INTEGER);
  });

  test('gaps are room, not walls', () => {
    // the whole point: a cue may be dragged through empty time freely
    const t = captionFixture();
    const span = captionSpan(capPlaced(t, 'cap2'), capAll(t));
    assert.ok(span.hi - span.lo > capPlaced(t, 'cap2').range.duration);
  });
});

describe('dragging a cue', () => {
  test('a drag moves it and never changes its length', () => {
    const t = captionFixture();
    const placed = capPlaced(t, 'cap2');
    const r = dragCaption({
      ...CAP_BASE, placed, span: captionSpan(placed, capAll(t)), deltaPx: -12,
    });
    assert.deepEqual({ start: r.start, duration: r.duration }, { start: F(60), duration: F(24) });
    assert.equal(r.clamped, false);
  });

  test('it stops at the cue before it rather than overwriting the words', () => {
    const t = captionFixture();
    const placed = capPlaced(t, 'cap2');
    const r = dragCaption({
      ...CAP_BASE, placed, span: captionSpan(placed, capAll(t)), deltaPx: -600,
    });
    assert.equal(r.start, F(48), 'flush against the end of cue one');
    assert.equal(r.duration, F(24));
    assert.equal(r.clamped, true, 'and says so, so the UI can paint it red');
  });

  test('it stops at the cue after it, measured from its own tail', () => {
    const t = captionFixture();
    const placed = capPlaced(t, 'cap2');
    const r = dragCaption({
      ...CAP_BASE, placed, span: captionSpan(placed, capAll(t)), deltaPx: 600,
    });
    assert.equal(r.start, F(96), 'its end lands exactly on cue three');
    assert.equal(r.clamped, true);
  });

  test('the first cue cannot be dragged before frame zero', () => {
    const t = captionFixture();
    const placed = capPlaced(t, 'cap1');
    const r = dragCaption({
      ...CAP_BASE, placed, span: captionSpan(placed, capAll(t)), deltaPx: -600,
    });
    assert.equal(r.start, F(0));
  });

  test('a snap is still bounded by the neighbour', () => {
    const t = captionFixture();
    const placed = capPlaced(t, 'cap2');
    const r = dragCaption({
      ...CAP_BASE, placed, span: captionSpan(placed, capAll(t)),
      deltaPx: -20, snapping: true, targets: [F(24)], tolerance: F(30),
    });
    assert.equal(r.start, F(48), 'the snap target sits inside cue one, so the wall wins');
    assert.equal(r.hit, null, 'and no snap line is drawn for a snap that did not happen');
  });
});

describe('trimming a cue', () => {
  test('the in-edge moves the start and leaves the end alone', () => {
    const t = captionFixture();
    const placed = capPlaced(t, 'cap2');
    const r = trimCaption({
      ...CAP_BASE, placed, span: captionSpan(placed, capAll(t)), edge: 'in', deltaPx: 12,
    });
    assert.deepEqual({ start: r.start, duration: r.duration }, { start: F(84), duration: F(12) });
    assert.equal(r.start + r.duration, 96);
  });

  test('the out-edge moves the end and leaves the start alone', () => {
    const t = captionFixture();
    const placed = capPlaced(t, 'cap2');
    const r = trimCaption({
      ...CAP_BASE, placed, span: captionSpan(placed, capAll(t)), edge: 'out', deltaPx: 12,
    });
    assert.deepEqual({ start: r.start, duration: r.duration }, { start: F(72), duration: F(36) });
  });

  test('neither edge can be pulled through the other', () => {
    const t = captionFixture();
    const placed = capPlaced(t, 'cap2');
    const span = captionSpan(placed, capAll(t));
    const inward = trimCaption({ ...CAP_BASE, placed, span, edge: 'in', deltaPx: 600 });
    assert.equal(inward.duration, F(1), 'a cue is at least one frame');
    const outward = trimCaption({ ...CAP_BASE, placed, span, edge: 'out', deltaPx: -600 });
    assert.equal(outward.duration, F(1));
    assert.equal(outward.start, F(72), 'and the out-trim did not move it');
  });

  test('an edge stops at the neighbouring cue', () => {
    const t = captionFixture();
    const placed = capPlaced(t, 'cap2');
    const span = captionSpan(placed, capAll(t));
    assert.equal(trimCaption({ ...CAP_BASE, placed, span, edge: 'in', deltaPx: -600 }).start, F(48));
    const out = trimCaption({ ...CAP_BASE, placed, span, edge: 'out', deltaPx: 600 });
    assert.equal(out.start + out.duration, 120, 'flush against cue three');
    assert.equal(out.clamped, true);
  });
});

describe('what a finished caption drag changes', () => {
  test('a drag that landed where it started is not an edit', () => {
    const t = captionFixture();
    const placed = capPlaced(t, 'cap2');
    assert.deepEqual(
      captionOps(placed, { start: F(72), duration: F(24), hit: null, clamped: false }, 'trk_s1'),
      [],
    );
  });

  test('the ops applied give the document the drag promised', () => {
    const t = captionFixture();
    const placed = capPlaced(t, 'cap2');
    const ops = captionOps(placed, { start: F(60), duration: F(30), hit: null, clamped: false }, 'trk_s1');
    assert.equal(
      laidOut(t, ops, 'trk_s1'),
      'gap[0,24) caption[24,48) gap[48,60) caption[60,90) gap[90,120) caption[120,144)',
      'cue two moved and resized, cues one and three did not budge',
    );
  });

  test('a clip is not a caption and gets no caption ops', () => {
    const t = fixture();
    assert.deepEqual(
      captionOps(placedOf(t, 'c1'), { start: F(0), duration: F(48), hit: null, clamped: false }, 'trk_v1'),
      [],
    );
  });

  test('editing the words is a patch, and blank or unchanged text is not an edit', () => {
    const t = captionFixture();
    const placed = capPlaced(t, 'cap2');
    assert.deepEqual(captionTextOps(placed, '  तीन  '), [
      { op: 'patch_caption', captionId: 'cap2', set: { text: 'तीन' } },
    ]);
    assert.deepEqual(captionTextOps(placed, 'two'), []);
    assert.deepEqual(captionTextOps(placed, '   '), []);
  });

  test('the edited words reach the document and the timing does not move', () => {
    const t = captionFixture();
    const placed = capPlaced(t, 'cap2');
    const after = applyEdits(t, captionTextOps(placed, 'edited')).timeline;
    const cue = placeTrack(trackOf(after, 'trk_s1')).find((p) => p.item.id === 'cap2');
    assert.equal(cue?.item.kind === 'caption' ? cue.item.text : null, 'edited');
    assert.equal(cue?.range.start, F(72));
    assert.equal(cue?.range.duration, F(24));
  });
});
