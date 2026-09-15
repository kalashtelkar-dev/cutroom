import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  place, placeTrack, itemAt, clipAt, itemDuration, trackDuration, timelineDuration,
  snapTargets, snap, trimBounds, findClip, emptyTimeline, isClip,
} from '../lib/timeline/document.ts';
import { demoProject, DEMO_MEDIA } from '../lib/fixtures/project.ts';
import { RATES, frames, rangeEnd, toTimecode } from '../lib/time/frames.ts';

const F = (sec: number) => frames(Math.round(sec * 24));

describe('positions are derived, never stored', () => {
  const t = demoProject();

  test('a clip sits at the sum of what precedes it', () => {
    const v1 = t.tracks.find((x) => x.id === 'trk_v1')!;
    const placed = placeTrack(v1);
    assert.equal(placed[0].range.start, 0);
    // every clip starts exactly where the last one ended, with no drift
    for (let i = 1; i < placed.length; i++) {
      assert.equal(placed[i].range.start, rangeEnd(placed[i - 1].range));
    }
  });

  test('a position is the sum of integer durations, NOT the converted sum of seconds', () => {
    // 3.4s and 6.2s are 82 and 149 frames, so the third clip starts at 231.
    // round(9.6 * 24) is 230. Checking a derived position by converting
    // seconds is off by a frame, and this is why nothing in the app does it.
    const placed = placeTrack(t.tracks.find((x) => x.id === 'trk_v1')!);
    assert.equal(placed[2].range.start, 231);
    assert.notEqual(placed[2].range.start, F(9.6));
  });

  test('gaps occupy time, transitions occupy none', () => {
    assert.equal(itemDuration({ id: 'g', kind: 'gap', duration: F(2) }), F(2));
    assert.equal(
      itemDuration({ id: 'x', kind: 'transition', transitionType: 'dissolve', inOffset: F(1), outOffset: F(1) }),
      0,
      'a transition overlaps its neighbours rather than pushing them apart',
    );
  });

  test('the timeline is as long as its longest track', () => {
    assert.equal(timelineDuration(t), Math.max(...t.tracks.map((x) => trackDuration(x))));
    assert.equal(toTimecode(timelineDuration(t), RATES.film), '00:00:37:17');
  });

  test('an empty document is zero, not undefined', () => {
    assert.equal(timelineDuration(emptyTimeline('x', 'x', RATES.film)), 0);
  });
});

describe('what is under the playhead', () => {
  const t = demoProject();
  const v1 = t.tracks.find((x) => x.id === 'trk_v1')!;

  test('the boundary frame belongs to the NEXT clip, not this one', () => {
    const placed = placeTrack(v1);
    const first = placed[0];
    const lastFrameOfFirst = frames(rangeEnd(first.range) - 1);
    assert.equal(itemAt(v1, lastFrameOfFirst)?.index, 0);
    assert.equal(itemAt(v1, rangeEnd(first.range))?.index, 1, 'clicking the cut selects the incoming clip');
  });

  test('the topmost enabled video track wins', () => {
    // at 9.0s V2 is holding a cutaway and V1 has A-roll under it
    const at = F(9.0);
    assert.equal(clipAt(t, at)?.trackId, 'trk_v2');
    // disable V2 and the A-roll shows through
    const hidden = { ...t, tracks: t.tracks.map((x) => (x.id === 'trk_v2' ? { ...x, enabled: false } : x)) };
    assert.equal(clipAt(hidden, at)?.trackId, 'trk_v1');
  });

  test('a gap resolves to nothing rather than to the neighbouring clip', () => {
    const v2 = t.tracks.find((x) => x.id === 'trk_v2')!;
    const hit = itemAt(v2, F(1));
    assert.ok(hit && !isClip(hit.item), 'V2 opens on a gap');
    assert.equal(clipAt(t, F(1))?.trackId, 'trk_v1', 'so the viewer shows V1');
  });

  test('past the end is nothing at all', () => {
    assert.equal(clipAt(t, F(500)), null);
  });
});

describe('snapping', () => {
  const t = demoProject();

  test('every cut, marker and zero is a target, and they are unique and sorted', () => {
    const targets = snapTargets(t);
    assert.equal(targets[0], 0);
    assert.deepEqual(targets, [...targets].sort((a, b) => a - b));
    assert.equal(new Set(targets).size, targets.length);
    assert.ok(targets.includes(frames(231)), 'a cut on V1');
    assert.ok(t.markers.every((m) => targets.includes(m.at)), 'every marker');
  });

  test('excluding a dragged clip drops the edges only it contributed', () => {
    // The last cutaway on V2 ends at a frame nothing else cuts on, so it is
    // the one case where excluding the clip actually changes the targets.
    const id = 'clp_thick_forest_aerial';
    const target = findClip(t, id)!;
    const removed = snapTargets(t).filter((x) => !snapTargets(t, id).includes(x));
    assert.deepEqual(removed, [rangeEnd(target.range)]);
  });

  test('but a clip abutting a neighbour keeps sharing that frame with it', () => {
    // Its start is also the preceding gap's end, so the edge survives, and
    // it should: the hole a lifted clip leaves is still somewhere to snap to.
    const id = 'clp_mountains_alone';
    const target = findClip(t, id)!;
    assert.ok(snapTargets(t, id).includes(target.range.start));
  });

  test('snaps to the nearest target inside tolerance and leaves the value alone outside it', () => {
    const targets = [frames(0), frames(100), frames(240)];
    assert.equal(snap(frames(103), targets, frames(5)), 100);
    assert.equal(snap(frames(97), targets, frames(5)), 100);
    assert.equal(snap(frames(110), targets, frames(5)), null, 'out of reach, so do not move it');
    assert.equal(snap(frames(120), targets, frames(200)), 100, 'nearest wins when several are in reach');
  });
});

describe('trim bounds come from the media, not from the clip', () => {
  const t = demoProject();

  test('a clip can only be pulled as far as source exists', () => {
    // amalfi_coast_aerial_8: 11.4s available, used from 0.6s for 8.3s
    const placed = findClip(t, 'clp_amalfi_coast_aerial_8')!;
    const media = DEMO_MEDIA[(placed.item as { mediaKey: string }).mediaKey];
    const b = trimBounds(placed, media)!;
    assert.equal(placed.range.start - b.minStart, F(0.6), '0.6s of head handle');
    const tail = media.available.duration - (placed.item as { sourceRange: { duration: number } }).sourceRange.duration - F(0.6);
    assert.equal(b.maxEnd - rangeEnd(placed.range), tail, 'and the rest as tail');
  });

  test('a clip using all of its source has no handle either side', () => {
    const placed = findClip(t, 'clp_redrock_talent_3')!;   // 0 → 3.4 of 6.5 available
    const b = trimBounds(placed, DEMO_MEDIA['gen/redrock_talent_3'])!;
    assert.equal(b.minStart, placed.range.start, 'nothing before frame zero of the source');
  });

  test('no media means no bounds, rather than a guess', () => {
    assert.equal(trimBounds(findClip(t, 'clp_redrock_talent_3')!, undefined), null);
  });
});

describe('the demo project is a real cut', () => {
  const t = demoProject();

  test('building it twice gives the same document', () => {
    assert.deepEqual(demoProject(), demoProject());
  });
  test('7 on V1, 4 on V2, three audio tracks, 27 items in all', () => {
    assert.equal(place(t).length, 27);
    const clips = (id: string) => t.tracks.find((x) => x.id === id)!.items.filter(isClip).length;
    assert.equal(clips('trk_v1'), 7);
    assert.equal(clips('trk_v2'), 4);
    assert.equal(t.tracks.filter((x) => x.kind === 'audio').length, 3);
  });

  test('every clip references media that exists, and fits inside it', () => {
    for (const p of place(t)) {
      if (!isClip(p.item)) continue;
      const media = t.media[p.item.mediaKey];
      assert.ok(media, `${p.item.name} references missing media`);
      assert.ok(
        rangeEnd(p.item.sourceRange) <= rangeEnd(media.available),
        `${p.item.name} is trimmed past the end of its source`,
      );
    }
  });
});
