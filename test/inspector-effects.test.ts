/**
 * Inspector values, all the way to a rendered graph.
 *
 * Asserting the shape of an effect proves nothing: the question is whether
 * the compiler emits an operation for it, with the right numbers. So these
 * run the real compiler over the result and look at the graph.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { paramsToEffects, effectsToParams, unrenderable } from '../lib/inspector/effects.ts';
import { DEFAULT_CLIP_PARAMS, type ClipParams } from '../components/inspector/types.ts';
import { compile } from '../lib/compiler/compile.ts';
import { emptyTimeline } from '../lib/timeline/document.ts';
import { createHistory } from '../lib/timeline/history.ts';
import { RATES, frames, timeRange, type Frames } from '../lib/time/frames.ts';
import type { Clip, MediaRef, Timeline } from '../lib/timeline/types.ts';
import { preflight } from '../lib/editor-api/graph.ts';
import type { Graph } from '../lib/editor-api/graph.ts';
import type { DeliverySpec } from '../lib/compiler/types.ts';

const F = (n: number): Frames => frames(n);
const HD: DeliverySpec = { width: 1920, height: 1080, container: 'mp4', reencode: true };
const MEDIA: MediaRef = {
  key: 'obj/a.mp4', name: 'a.mp4', kind: 'video',
  available: timeRange(F(0), F(900)), width: 1920, height: 1080,
};

const params = (over: Partial<ClipParams> = {}): ClipParams => ({ ...DEFAULT_CLIP_PARAMS, ...over });

const clipWith = (effects: Clip['effects']): Clip => ({
  id: 'c1', kind: 'clip', name: 'c1', mediaKey: 'a',
  sourceRange: timeRange(F(0), F(120)), enabled: true, effects,
});

function graphFor(effects: Clip['effects']): Graph {
  const t: Timeline = emptyTimeline('tl', 'T', RATES.web);
  t.media.a = MEDIA;
  const v1 = t.tracks.find((x) => x.kind === 'video' && x.name === 'Video 1');
  assert.ok(v1);
  v1.items.push(clipWith(effects));
  return compile(t, { delivery: HD }).graph;
}

const ops = (g: Graph) =>
  g.nodes.filter((n) => n.kind === 'engine').map((n) => `${n.engine}/${n.operation}`);

const paramsOf = (g: Graph, op: string) => {
  const [engine, operation] = op.split('/');
  const n = g.nodes.find((x) => x.kind === 'engine' && x.engine === engine && x.operation === operation);
  return (n as { params?: Record<string, unknown> } | undefined)?.params ?? {};
};

describe('inspector values become effects the compiler can render', () => {
  test('a crop becomes pixels, and the compiler emits ffmpeg/crop with them', () => {
    // 10% off the left and 20% off the right of 1920 leaves 1344 from x=192
    const { effects, skipped } = paramsToEffects(params({ cropL: 10, cropR: 20 }), [], MEDIA);
    assert.deepEqual(skipped, []);

    const g = graphFor(effects);
    assert.ok(ops(g).includes('ffmpeg/crop'), `no crop in ${ops(g).join(', ')}`);
    const p = paramsOf(g, 'ffmpeg/crop');
    assert.equal(p.x, 192);
    assert.equal(p.width, 1344);
    assert.equal(p.y, 0);
    assert.equal(p.height, 1080);
  });

  test('crop dimensions are even, because yuv420p cannot hold an odd one', () => {
    const odd: MediaRef = { ...MEDIA, width: 1921, height: 1081 };
    const { effects } = paramsToEffects(params({ cropR: 33.3, cropB: 33.3 }), [], odd);
    const crop = effects.find((e) => e.kind === 'ffmpeg/crop');
    assert.ok(crop);
    assert.equal((crop.params.width as number) % 2, 0);
    assert.equal((crop.params.height as number) % 2, 0);
  });

  test('crop without a probed size is skipped and SAID, not guessed at', () => {
    const noSize: MediaRef = { ...MEDIA, width: undefined, height: undefined };
    const { effects, skipped } = paramsToEffects(params({ cropL: 10 }), [], noSize);
    assert.deepEqual(effects, []);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /source size/);
  });

  test('speed is a factor, not a percentage', () => {
    const { effects } = paramsToEffects(params({ speed: 200 }), [], MEDIA);
    const g = graphFor(effects);
    assert.equal(paramsOf(g, 'ffmpeg/speed').factor, 2);
  });

  test('rotation reaches the node as a string, which is what it takes', () => {
    const { effects } = paramsToEffects(params({ rotation: 90 }), [], MEDIA);
    const g = graphFor(effects);
    assert.equal(paramsOf(g, 'ffmpeg/rotate').degrees, '90');
  });

  test('gain becomes ffmpeg/volume', () => {
    const { effects } = paramsToEffects(params({ gainDb: -6 }), [], MEDIA);
    const volume = effects.find((e) => e.kind === 'ffmpeg/volume');
    assert.ok(volume);
    assert.equal(volume.params.gainDb, -6);
  });

  test('defaults emit nothing at all, so an untouched clip costs no re-encode', () => {
    const { effects } = paramsToEffects(params(), [], MEDIA);
    assert.deepEqual(effects, []);
    const g = graphFor(effects);
    for (const op of ['ffmpeg/crop', 'ffmpeg/speed', 'ffmpeg/rotate', 'ffmpeg/volume']) {
      assert.ok(!ops(g).includes(op), `${op} was emitted for an untouched clip`);
    }
  });

  test('a group switched off removes its effect rather than leaving it behind', () => {
    const on = paramsToEffects(params({ speed: 150 }), [], MEDIA).effects;
    assert.equal(on.length, 1);
    const off = paramsToEffects(params({ speed: 150, speedOn: false }), on, MEDIA).effects;
    assert.deepEqual(off, []);
  });

  test('effects this module does not own survive a slider drag', () => {
    const theirs = [{ kind: 'ffmpeg/denoise', params: { strength: 3 }, enabled: true }];
    const { effects } = paramsToEffects(params({ gainDb: 3 }), theirs, MEDIA);
    assert.ok(effects.some((e) => e.kind === 'ffmpeg/denoise'), 'it dropped an effect it did not own');
    assert.ok(effects.some((e) => e.kind === 'ffmpeg/volume'));
  });
});

describe('values survive a round trip through the document', () => {
  test('what goes in comes back out', () => {
    const original = params({ cropL: 10, cropT: 5, speed: 150, rotation: -45, gainDb: -3 });
    const { effects } = paramsToEffects(original, [], MEDIA);
    const back = effectsToParams(clipWith(effects), MEDIA);

    assert.equal(Math.round(back.cropL), 10);
    assert.equal(Math.round(back.cropT), 5);
    assert.equal(back.speed, 150);
    assert.equal(back.rotation, -45);
    assert.equal(back.gainDb, -3);
  });

  test('a clip with no effects reads as the defaults, not as zeroes', () => {
    assert.deepEqual(effectsToParams(clipWith([]), MEDIA), DEFAULT_CLIP_PARAMS);
  });
});

describe('what cannot be rendered is named', () => {
  test('pan is reported, because nothing places a sound in the stereo field', () => {
    assert.deepEqual(unrenderable(params({ pan: -1 })), ['Pan']);
  });

  test('opacity and blend are NOT on that list, because they render now', () => {
    assert.deepEqual(unrenderable(params({ opacity: 50 })), []);
    assert.deepEqual(unrenderable(params({ blend: 2 })), []);
  });

  test('zoom and position are NOT on it either, for the same reason', () => {
    // the compiler scales the layer and overlays it where the viewer draws it,
    // which is asserted on the graph in test/compiler.test.ts
    assert.deepEqual(unrenderable(params({ zoom: 1.5 })), []);
    assert.deepEqual(unrenderable(params({ posX: 20, posY: -8 })), []);
  });

  test('an untouched clip reports nothing, so the warning stays worth reading', () => {
    assert.deepEqual(unrenderable(params()), []);
  });

  test('a group switched off reports nothing, because it applies nothing', () => {
    assert.deepEqual(unrenderable(params({ pan: 1, audioOn: false })), []);
  });
});

describe('a slider drag is one undo, not three hundred', () => {
  test('coalesced pushes collapse, and undo returns to before the drag', () => {
    const h = createHistory();
    // three "pixels" of one drag, each inverse returning to the step before it
    h.push('Adjust c1', [{ op: 'patch_clip', clipId: 'c1', set: { name: 'start' } }]);
    h.push('Adjust c1', [{ op: 'patch_clip', clipId: 'c1', set: { name: 'middle' } }], true);
    h.push('Adjust c1', [{ op: 'patch_clip', clipId: 'c1', set: { name: 'nearly' } }], true);

    assert.deepEqual(h.labels.undo, ['Adjust c1']);

    let got: unknown = null;
    h.undo((ops) => { got = (ops[0] as { set: { name: string } }).set.name; return []; });
    // the FIRST inverse, the one that returns to before the drag began
    assert.equal(got, 'start');
  });

  test('a different label does not coalesce even when asked', () => {
    const h = createHistory();
    h.push('Adjust c1', [{ op: 'patch_clip', clipId: 'c1', set: { name: 'a' } }]);
    h.push('Adjust c2', [{ op: 'patch_clip', clipId: 'c2', set: { name: 'b' } }], true);
    assert.deepEqual(h.labels.undo, ['Adjust c2', 'Adjust c1']);
  });

  test('without the flag every push is its own entry, as before', () => {
    const h = createHistory();
    h.push('Adjust c1', []);
    h.push('Adjust c1', []);
    assert.equal(h.labels.undo.length, 2);
  });
});

/**
 * Blend modes and opacity, all the way to the graph.
 *
 * These were called unrenderable for two turns on the strength of checking
 * one operation. `ffmpeg/compose` genuinely cannot blend, but `ffmpeg/custom`
 * takes two wired inputs and ffmpeg's `blend` filter does every mode the
 * picker offers, which was confirmed by running it rather than by reading a
 * schema. So these assert on the emitted graph, and preflight has to accept it.
 */
describe('compositing two picture tracks', () => {
  const twoTracks = (upperEffects: Clip['effects']): Timeline => {
    const t = emptyTimeline('tl', 'T', RATES.web);
    t.media.a = MEDIA;
    t.media.b = { ...MEDIA, key: 'obj/b.mp4', name: 'b.mp4' };
    const v2 = t.tracks.find((x) => x.kind === 'video' && x.name === 'Video 2');
    const v1 = t.tracks.find((x) => x.kind === 'video' && x.name === 'Video 1');
    assert.ok(v2 && v1);
    v1.items.push({ ...clipWith([]), id: 'lower', mediaKey: 'a' });
    v2.items.push({ ...clipWith(upperEffects), id: 'upper', mediaKey: 'b' });
    return t;
  };

  const compileOf = (t: Timeline) => compile(t, { delivery: HD });

  const customArgs = (g: Graph): string[][] =>
    g.nodes
      .filter((n) => n.kind === 'engine' && n.engine === 'ffmpeg' && n.operation === 'custom')
      .map((n) => ((n as { params?: { args?: string[] } }).params?.args ?? []));

  test('an ordinary stack still uses one compose node, not a blend pass', () => {
    const g = compileOf(twoTracks([])).graph;
    assert.ok(ops(g).includes('ffmpeg/compose'), 'the cheap path was not taken');
    assert.equal(customArgs(g).filter((a) => a.join(' ').includes('blend=')).length, 0);
  });

  test('opacity emits a blend pass with that opacity', () => {
    const { effects } = paramsToEffects(params({ opacity: 40 }), [], MEDIA);
    const g = compileOf(twoTracks(effects)).graph;
    const blended = customArgs(g).map((a) => a.join(' ')).filter((a) => a.includes('blend='));
    assert.equal(blended.length, 1, `expected one blend pass, got ${blended.length}`);
    assert.match(blended[0], /all_opacity=0\.4\b/);
    assert.match(blended[0], /all_mode=normal/);
  });

  test('each blend mode reaches ffmpeg under the name ffmpeg uses', () => {
    // the picker reads Normal, Add, Overlay, Screen, Multiply
    for (const [index, filter] of [[1, 'addition'], [2, 'overlay'], [3, 'screen'], [4, 'multiply']] as const) {
      const { effects } = paramsToEffects(params({ blend: index }), [], MEDIA);
      const g = compileOf(twoTracks(effects)).graph;
      const blended = customArgs(g).map((a) => a.join(' ')).filter((a) => a.includes('blend='));
      assert.equal(blended.length, 1, `mode ${index} emitted ${blended.length} blend passes`);
      assert.match(blended[0], new RegExp(`all_mode=${filter}\\b`), `mode ${index} is not ${filter}`);
    }
  });

  test('the blend pass wires exactly two inputs, which is all custom takes', () => {
    const { effects } = paramsToEffects(params({ blend: 3 }), [], MEDIA);
    const g = compileOf(twoTracks(effects)).graph;
    const node = g.nodes.find((n) => n.kind === 'engine' && n.operation === 'custom');
    assert.ok(node);
    const wires = g.edges.filter((e) => e.to.node === node.id);
    assert.equal(wires.length, 2, `${wires.length} wires into ffmpeg/custom`);
  });

  test('both layers are sized and rated alike, because blend refuses otherwise', () => {
    const { effects } = paramsToEffects(params({ blend: 3 }), [], MEDIA);
    const g = compileOf(twoTracks(effects)).graph;
    const args = customArgs(g).map((a) => a.join(' ')).find((a) => a.includes('blend='));
    assert.ok(args);
    // one scale/pad/fps preparation per input, before the blend
    assert.equal((args.match(/force_original_aspect_ratio=decrease/g) ?? []).length, 2);
    assert.equal((args.match(/fps=30/g) ?? []).length, 2);
  });

  test('the graph it emits is one preflight accepts', () => {
    const { effects } = paramsToEffects(params({ opacity: 60, blend: 4 }), [], MEDIA);
    const { graph } = compileOf(twoTracks(effects));
    assert.deepEqual(preflight(graph), [], 'the blend graph does not pass preflight');
  });

  test('clips on one track asking for different blends is said out loud', () => {
    const a = paramsToEffects(params({ blend: 3 }), [], MEDIA).effects;
    const b = paramsToEffects(params({ blend: 4 }), [], MEDIA).effects;
    const t = twoTracks(a);
    const v2 = t.tracks.find((x) => x.name === 'Video 2');
    assert.ok(v2);
    v2.items.push({ ...clipWith(b), id: 'upper2', mediaKey: 'b' });
    const r = compileOf(t);
    assert.ok(
      r.warnings.some((w) => /different blends/.test(w.message)),
      `no warning in ${JSON.stringify(r.warnings.map((w) => w.message))}`,
    );
  });

  test('a round trip keeps the blend and the opacity', () => {
    const { effects } = paramsToEffects(params({ opacity: 35, blend: 2 }), [], MEDIA);
    const back = effectsToParams(clipWith(effects), MEDIA);
    assert.equal(Math.round(back.opacity), 35);
    assert.equal(back.blend, 2);
  });
});
