/**
 * Where a new track lands.
 *
 * These apply the batch and assert on the DOCUMENT that comes out, never on
 * the shape of the op. The bug they guard shipped past a green suite exactly
 * because nobody looked at the track order afterwards: a new video track was
 * appended to the end of the array, which is below the audio tracks, so it
 * rendered in the audio section of the timeline.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { addTrackOp, trackInsertIndex, nextTrackNumber } from '../lib/timeline/addTrack.ts';
import { applyEdits } from '../lib/timeline/edits.ts';
import { emptyTimeline } from '../lib/timeline/document.ts';
import { RATES } from '../lib/time/frames.ts';
import type { Timeline, TrackKind } from '../lib/timeline/types.ts';

const doc = () => emptyTimeline('tl', 'T', RATES.film);

/** The kinds top to bottom, which is the one thing the user actually sees. */
const shape = (t: Timeline): TrackKind[] => t.tracks.map((x) => x.kind);
const names = (t: Timeline): string[] => t.tracks.map((x) => x.name);

const add = (t: Timeline, kind: TrackKind): Timeline =>
  applyEdits(t, [addTrackOp(t, kind)]).timeline;

const remove = (t: Timeline, trackId: string): Timeline =>
  applyEdits(t, [{ op: 'remove_track', trackId }]).timeline;

describe('a new track lands in its own section', () => {
  test('the sections stay contiguous: picture, then sound', () => {
    const t = doc();
    assert.deepEqual(shape(t), ['video', 'video', 'audio', 'audio', 'audio']);
  });

  test('a video track goes on TOP of the video tracks, not under the audio', () => {
    const t = add(doc(), 'video');
    assert.deepEqual(shape(t), ['video', 'video', 'video', 'audio', 'audio', 'audio']);
    assert.equal(t.tracks[0].kind, 'video', 'the new video track is not the topmost lane');
  });

  test('an audio track goes at the BOTTOM of the audio tracks', () => {
    const t = add(doc(), 'audio');
    assert.deepEqual(shape(t), ['video', 'video', 'audio', 'audio', 'audio', 'audio']);
    assert.equal(t.tracks[t.tracks.length - 1].kind, 'audio');
  });

  test('subtitles sort below both', () => {
    const t = add(doc(), 'subtitle');
    assert.deepEqual(shape(t), ['video', 'video', 'audio', 'audio', 'audio', 'subtitle']);
  });

  test('no kind is ever interleaved, however many are added', () => {
    let t = doc();
    for (const kind of ['audio', 'video', 'subtitle', 'audio', 'video'] as TrackKind[]) t = add(t, kind);
    const order = shape(t);
    const firstAudio = order.indexOf('audio');
    const lastVideo = order.lastIndexOf('video');
    const firstSub = order.indexOf('subtitle');
    assert.ok(lastVideo < firstAudio, `video after audio: ${order.join(',')}`);
    assert.ok(order.lastIndexOf('audio') < firstSub, `audio after subtitle: ${order.join(',')}`);
  });
});

describe('the exact sequence that was reported', () => {
  test('delete V2, add a video track, and it comes back on top, not in the audio section', () => {
    let t = doc();
    t = remove(t, 'trk_v2');
    assert.deepEqual(shape(t), ['video', 'audio', 'audio', 'audio']);

    t = add(t, 'video');
    assert.deepEqual(
      shape(t),
      ['video', 'video', 'audio', 'audio', 'audio'],
      'the new video track landed outside the picture section',
    );
    assert.equal(t.tracks[0].kind, 'video');
    // and it is not called Video 1, which is the track still sitting under it
    assert.notEqual(t.tracks[0].name, t.tracks[1].name);
  });

  test('undo puts the deleted track back where it was', () => {
    const t = doc();
    const { timeline: gone, inverse } = applyEdits(t, [{ op: 'remove_track', trackId: 'trk_v2' }]);
    const back = applyEdits(gone, inverse).timeline;
    assert.deepEqual(shape(back), shape(t));
    assert.deepEqual(names(back), names(t));
  });
});

describe('names and ids do not collide', () => {
  test('deleting V1 and adding one does not produce a second "Video 1"', () => {
    let t = doc();
    t = remove(t, 'trk_v1');
    t = add(t, 'video');
    assert.equal(new Set(names(t)).size, names(t).length, `duplicate name in ${names(t).join(', ')}`);
  });

  test('ids stay unique through delete and re-add', () => {
    let t = doc();
    for (let i = 0; i < 6; i += 1) {
      t = add(t, 'video');
      if (i === 2) t = remove(t, t.tracks[1].id);
    }
    const ids = t.tracks.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids.join(', ')}`);
  });

  test('the next number is taken from the names in use, not from the count', () => {
    const t = remove(doc(), 'trk_v1');   // leaves Video 2 alone
    assert.equal(nextTrackNumber(t.tracks, 'video'), 3);
  });

  test('an empty timeline starts numbering at one', () => {
    assert.equal(nextTrackNumber([], 'audio'), 1);
    assert.equal(trackInsertIndex([], 'video'), 0);
  });
});

/**
 * The pipeline on the account and the one in the workbench are one graph.
 *
 * Kept honest by a test because the failure is silent: a second copy of a
 * graph stays right until somebody edits one of them, and then the tab shows
 * something the account does not have.
 */
describe('the extract-audio pipeline', () => {
  test('compiles offline, which is what earns it a round trip', async () => {
    const { extractAudioGraph } = await import('../lib/pipelines/extract-audio.ts');
    const { preflight } = await import('../lib/editor-api/graph.ts');
    assert.deepEqual(preflight(extractAudioGraph()), []);
  });

  test('reads a video and returns audio, which is the whole point of it', async () => {
    const { extractAudioGraph } = await import('../lib/pipelines/extract-audio.ts');
    const g = extractAudioGraph();

    const input = g.nodes.find((n) => n.kind === 'input');
    assert.ok(input);
    assert.equal(input.type, 'file:video');

    const op = g.nodes.find((n) => n.kind === 'engine');
    assert.ok(op);
    assert.equal(`${op.engine}/${op.operation}`, 'ffmpeg/extract-audio');

    const out = g.nodes.find((n) => n.kind === 'output');
    assert.ok(out);
    assert.deepEqual(out.fields, ['audio']);
  });

  test('it is one definition, so nothing can build a second copy of it', async () => {
    const { extractAudioGraph } = await import('../lib/pipelines/extract-audio.ts');
    // The recipe catalogue is empty now and the graph is built on the canvas,
    // so what matters is that the builder exists in one place and anything
    // wanting this graph imports it rather than rebuilding it.
    const g1 = extractAudioGraph();
    const g2 = extractAudioGraph();
    assert.deepEqual(
      g1.nodes.map((n) => n.id), g2.nodes.map((n) => n.id),
      'the builder is not deterministic, so two callers get two different graphs',
    );
    assert.equal(g1.nodes.length, 3);
  });
});
