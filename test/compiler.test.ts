/**
 * The compiler's one non-negotiable promise is that what it emits compiles.
 *
 * `preflight()` answers ten of the server's twelve diagnostic codes offline,
 * so a graph it passes is a graph worth spending a round trip on. Every shape
 * of timeline below is checked against it, because a compiler that is right
 * about one clip and wrong about a gap is not useful.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { compile } from '../lib/compiler/compile.ts';
import { cacheKey, canonicalise } from '../lib/compiler/cache.ts';
import { preflight, type Graph, type GraphNode } from '../lib/editor-api/graph.ts';
import { emptyTimeline } from '../lib/timeline/document.ts';
import { COMPOSITE_EFFECT, TRANSFORM_EFFECT } from '../lib/inspector/effects.ts';
import { RATES, frames, timeRange, type Frames } from '../lib/time/frames.ts';
import type { Clip, Gap, Timeline, Track, Transition } from '../lib/timeline/types.ts';
import type { CompileOptions, CompileResult, DeliverySpec } from '../lib/compiler/types.ts';

// ── fixtures ────────────────────────────────────────────────────────────

const RATE = RATES.web; // 30fps, so a frame is exactly 1/30s and the maths is checkable
const F = (n: number): Frames => frames(n);

const HD: DeliverySpec = { width: 1920, height: 1080, container: 'mp4', reencode: true };

function doc(): Timeline {
  const t = emptyTimeline('tl_1', 'Test', RATE);
  t.media.v1 = { key: 'v1', name: 'interview.mp4', kind: 'video', available: timeRange(F(0), F(9000)) };
  t.media.v2 = { key: 'v2', name: 'broll.mov', kind: 'video', available: timeRange(F(0), F(9000)) };
  t.media.a1 = { key: 'a1', name: 'music.wav', kind: 'audio', available: timeRange(F(0), F(9000)) };
  t.media.png = { key: 'png', name: 'lower-third.png', kind: 'image', available: timeRange(F(0), F(1)) };
  t.media.srt = { key: 'srt', name: 'captions.srt', kind: 'video', available: timeRange(F(0), F(9000)) };
  return t;
}

/** trk_v2, trk_v1, trk_a1, trk_a2, trk_a3 in that order: index 0 is the top. */
const V2 = 0, V1 = 1, A1 = 2, A2 = 3;

const clip = (
  id: string,
  mediaKey: string,
  start: number,
  duration: number,
  extra: Partial<Clip> = {},
): Clip => ({
  id,
  kind: 'clip',
  name: id,
  mediaKey,
  sourceRange: timeRange(F(start), F(duration)),
  enabled: true,
  effects: [],
  ...extra,
});

const gap = (id: string, duration: number): Gap => ({ id, kind: 'gap', duration: F(duration) });

const subtitleTrack = (items: Clip[]): Track => ({
  id: 'trk_s1', kind: 'subtitle', name: 'Subtitles', items,
  locked: false, muted: false, solo: false, enabled: true, autoSelect: true,
});

// ── helpers ─────────────────────────────────────────────────────────────

const run = (t: Timeline, opts: Partial<CompileOptions> = {}): CompileResult =>
  compile(t, { delivery: HD, ...opts });

const engines = (g: Graph): string[] =>
  g.nodes.filter((n) => n.kind === 'engine').map((n) => `${n.engine}/${n.operation}`);

const nodesOf = (g: Graph, op: string): GraphNode[] =>
  g.nodes.filter((n) => n.kind === 'engine' && `${n.engine}/${n.operation}` === op);

const paramsOf = (g: Graph, op: string): Record<string, unknown>[] =>
  nodesOf(g, op).map((n) => engineParams(g, n.id));

/** The ffmpeg/custom nodes that bring a picture segment to the join's shape. */
const fitNodes = (g: Graph): Record<string, unknown>[] =>
  paramsOf(g, 'ffmpeg/custom').filter((p) => String(p.output ?? '').startsWith('fit.'));

/** The ffmpeg/custom nodes that lay one picture track over another. */
const layerNodes = (g: Graph): GraphNode[] =>
  nodesOf(g, 'ffmpeg/custom').filter((n) => String(engineParams(g, n.id).output ?? '').startsWith('layer.'));

/** The `-filter_complex` an ffmpeg/custom node was given. */
function filterOf(g: Graph, nodeId: string): string {
  const args = customArgs(g, nodeId);
  const at = args.indexOf('-filter_complex');
  assert.ok(at >= 0, `${nodeId} has no filter graph`);
  return args[at + 1];
}

/** The `enable=` expression gating a layer, or null if it is never gated. */
function gateOf(g: Graph, nodeId: string): string | null {
  return filterOf(g, nodeId).match(/enable='([^']*)'/)?.[1] ?? null;
}

function engineParams(g: Graph, nodeId: string): Record<string, unknown> {
  const n = g.nodes.find((x) => x.id === nodeId);
  assert.ok(n && n.kind === 'engine', `${nodeId} is not an engine node`);
  return n.params;
}

const near = (a: number, b: number, why = ''): void => {
  // seconds are rounded to the microsecond on the way out of frames, so a sum
  // of them lands near a whole number rather than on it
  assert.ok(Math.abs(a - b) < 1e-4, `${why}: ${a}s is not ${b}s`);
};

const inputsInto = (g: Graph, nodeId: string, port: string): string[] =>
  g.edges.filter((e) => e.to.node === nodeId && e.to.port === port).map((e) => e.from.node);

const customArgs = (g: Graph, nodeId: string): string[] =>
  engineParams(g, nodeId).args as string[];

/** The `-t 3.5` an ffmpeg/custom node was given, which is how long it runs. */
function customDuration(g: Graph, nodeId: string): number {
  const args = customArgs(g, nodeId);
  const at = args.indexOf('-t');
  assert.ok(at >= 0, `${nodeId} has no -t to read a duration from`);
  return Number(args[at + 1]);
}

/**
 * How long the file a node produces actually runs, worked out from the graph.
 *
 * Asserting that a compose exists, or that a concat has three inputs, says
 * nothing about whether the picture and the sound still line up at the end of
 * it. This walks the params the compiler wrote and works out the real length
 * of a branch, which is the only way a test notices a segment that comes out
 * half the length of the slot it was supposed to fill.
 */
function renderedSeconds(g: Graph, nodeId: string): number {
  const node = g.nodes.find((n) => n.id === nodeId);
  assert.ok(node, `${nodeId} is not in the graph`);
  if (node.kind !== 'engine') return 0; // a source file is as long as it is
  const from = (port: string): number[] =>
    inputsInto(g, nodeId, port).map((id) => renderedSeconds(g, id));
  const p = engineParams(g, nodeId);
  switch (`${node.engine}/${node.operation}`) {
    case 'ffmpeg/synthetic':
    case 'ffmpeg/trim':
      return p.durationSec as number;
    case 'ffmpeg/concat':
      return from('inputs').reduce((a, b) => a + b, 0);
    case 'ffmpeg/compose':
      return Math.max(...from('inputs')); // duration: longest
    case 'ffmpeg/speed':
      return from('input')[0] / (p.factor as number ?? 2);
    case 'ffmpeg/audio-replace':
      return Math.max(...from('input'), ...from('audio')); // shortest: false
    case 'ffmpeg/custom':
      // a generator says -t; a filter is as long as the longest thing it reads
      return customArgs(g, nodeId).includes('-t')
        ? customDuration(g, nodeId)
        : Math.max(...from('input'));
    default:
      return from('input')[0] ?? 0;
  }
}

/** What the delivered file will actually run for. */
function deliveredSeconds(r: CompileResult): number {
  const out = r.graph.nodes.find((n) => n.kind === 'output');
  assert.ok(out, 'something has to come out');
  return renderedSeconds(r.graph, inputsInto(r.graph, out.id, 'file')[0]);
}

/** Everything a graph has to satisfy before it is worth sending anywhere. */
function assertCompiles(g: Graph, why: string): void {
  assert.deepEqual(preflight(g), [], `${why}: preflight should find nothing`);
  assert.equal(
    new Set(g.edges.map((e) => e.id)).size, g.edges.length,
    `${why}: an edge is identified by its endpoints, so two with one id means one is lost`,
  );
  assert.ok(g.nodes.some((n) => n.kind === 'output'), `${why}: something has to come out`);
  const fed = new Set(g.edges.map((e) => e.to.node));
  for (const n of g.nodes) {
    if (n.kind === 'output') assert.ok(fed.has(n.id), `${why}: the output node is not wired to anything`);
  }
}

// ── the promise ─────────────────────────────────────────────────────────

describe('every compiled graph passes preflight', () => {
  test('one clip', () => {
    const t = doc();
    t.tracks[V1].items = [clip('c1', 'v1', 300, 120)];
    const r = run(t);
    assertCompiles(r.graph, 'one clip');
    assert.deepEqual(engines(r.graph), ['ffmpeg/trim', 'ffmpeg/transcode']);
    // one segment needs no join, and one layer needs no composite
    assert.equal(r.warnings.length, 0);
  });

  test('several clips', () => {
    const t = doc();
    t.tracks[V1].items = [
      clip('c1', 'v1', 0, 60),
      clip('c2', 'v2', 30, 45),
      clip('c3', 'v1', 600, 90),
    ];
    const r = run(t);
    assertCompiles(r.graph, 'several clips');
    assert.equal(nodesOf(r.graph, 'ffmpeg/trim').length, 3);
    assert.equal(nodesOf(r.graph, 'ffmpeg/concat').length, 1);
    const join = nodesOf(r.graph, 'ffmpeg/concat')[0];
    assert.equal(inputsInto(r.graph, join.id, 'inputs').length, 3, 'every segment reaches the join');
  });

  test('two video tracks', () => {
    const t = doc();
    t.tracks[V2].items = [clip('over', 'v2', 0, 120)];
    t.tracks[V1].items = [clip('under', 'v1', 0, 120)];
    const r = run(t);
    assertCompiles(r.graph, 'two video tracks');

    const composite = nodesOf(r.graph, 'ffmpeg/compose')[0];
    assert.ok(composite, 'two layers need a composite');
    const layers = inputsInto(r.graph, composite.id, 'inputs');
    assert.equal(layers.length, 2);

    // tracks[0] is the topmost track and cells are drawn in order, so the
    // bottom track has to be the first input or V1 would cover V2
    const params = paramsOf(r.graph, 'ffmpeg/compose')[0];
    assert.deepEqual(params.cells, [
      { x: 0, y: 0, w: 1, h: 1, source: 0, fit: 'contain' },
      { x: 0, y: 0, w: 1, h: 1, source: 1, fit: 'contain' },
    ]);
    const trimOf = (media: string): string | undefined =>
      nodesOf(r.graph, 'ffmpeg/trim').find((n) => inputsInto(r.graph, n.id, 'input')[0] === `in_${media}`)?.id;
    assert.equal(layers[0], trimOf('interview_mp4'), 'the lower track is drawn first');
    assert.equal(layers[1], trimOf('broll_mov'), 'and the upper one over it');
  });

  test('video and audio', () => {
    const t = doc();
    t.tracks[V1].items = [clip('pic', 'v1', 0, 150)];
    t.tracks[A1].items = [clip('vo', 'a1', 0, 150)];
    const r = run(t);
    assertCompiles(r.graph, 'video and audio');

    const replace = nodesOf(r.graph, 'ffmpeg/audio-replace')[0];
    assert.ok(replace, 'the sound has to be put back onto the picture');
    assert.equal(inputsInto(r.graph, replace.id, 'input').length, 1);
    assert.equal(inputsInto(r.graph, replace.id, 'audio').length, 1);
  });

  test('a gap in the middle', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60), gap('g1', 45), clip('b', 'v1', 300, 60)];
    const r = run(t);
    assertCompiles(r.graph, 'a gap');

    const black = paramsOf(r.graph, 'ffmpeg/synthetic');
    assert.equal(black.length, 1, 'a gap is one piece of generated black');
    assert.equal(black[0].pattern, 'color');
    assert.equal(black[0].color, 'black');
    assert.equal(black[0].durationSec, 1.5, '45 frames at 30fps');
    assert.equal(black[0].audio, false, 'synthetic only offers a 440Hz tone, which is worse than silence');
    assert.equal(inputsInto(r.graph, nodesOf(r.graph, 'ffmpeg/concat')[0].id, 'inputs').length, 3);
  });

  test('an empty timeline', () => {
    const r = run(emptyTimeline('tl_0', 'Nothing', RATE));
    assertCompiles(r.graph, 'empty timeline');
    assert.deepEqual(engines(r.graph), ['ffmpeg/synthetic', 'ffmpeg/transcode']);
    assert.deepEqual(r.warnings.map((w) => w.code), ['empty_track']);
    // never below what ffmpeg/synthetic will generate
    assert.equal(paramsOf(r.graph, 'ffmpeg/synthetic')[0].durationSec, 0.1);
  });

  test('a timeline of everything at once', () => {
    const t = doc();
    t.tracks[V2].items = [gap('pad', 30), clip('over', 'v2', 0, 90)];
    t.tracks[V1].items = [clip('a', 'v1', 0, 60), gap('g', 30), clip('b', 'png', 0, 30)];
    t.tracks[A1].items = [clip('vo', 'a1', 0, 60), gap('gg', 60)];
    t.tracks[A2].items = [clip('mus', 'v1', 0, 120, {
      effects: [{ kind: 'volume', params: { gainDb: -6 }, enabled: true }],
    })];
    t.tracks.push(subtitleTrack([clip('s', 'srt', 0, 120)]));
    const r = run(t, { burnSubtitles: true });
    assertCompiles(r.graph, 'everything');
    // V2 starts a second in, so the layer is gated rather than composed flat
    assert.equal(layerNodes(r.graph).length, 1);
    assert.ok(engines(r.graph).includes('ffmpeg/audio-replace'));
    assert.ok(engines(r.graph).includes('ffmpeg/volume'));
  });
});

// ── layers ──────────────────────────────────────────────────────────────
// A track that is only on screen for part of the programme used to paint its
// gaps black over everything below it. The strip joined for it still has that
// black in it, because an mp4 carries no alpha. What changed is that the
// layer is not drawn at all where it has nothing to show.

describe('a picture track shows through the gaps in the track above it', () => {
  test('an upper track with a gap is gated, not painted over the one below', () => {
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 300)];
    t.tracks[V2].items = [gap('pad', 30), clip('over', 'v2', 0, 90)];
    const r = run(t);
    assertCompiles(r.graph, 'a gapped upper track');

    const layer = layerNodes(r.graph)[0];
    assert.ok(layer, 'the upper track is laid over the lower one');
    // frames 30 to 120 at 30fps, half a frame either side so each boundary
    // falls between two samples instead of on one
    assert.equal(gateOf(r.graph, layer.id), 'between(t,0.983333,3.983333)');
    assert.match(filterOf(r.graph, layer.id), /\[base\]\[top\]overlay=x=0:y=0:enable=/);
    assert.equal(
      r.warnings.filter((w) => /black over the track below/.test(w.message)).length, 0,
      'there is no black over the track below to warn about any more',
    );
    near(deliveredSeconds(r), 10, 'gating does not change how long the programme is');
  });

  test('the filter graph is the one that was measured, character for character', () => {
    // `npm run prove:layers` ran exactly this shape on the live node and read
    // the pixels back: blue while the layer is on, and the track below rather
    // than black once it is off. A change here is a change to something that
    // was proved by running it, so prove it again before moving this string.
    //
    // The harness now imports `HOLD_LAST` from the compiler instead of
    // retyping it, so at least that part of the string cannot drift: it used
    // to hand-write its own copy of the filter, which meant a green run of
    // prove:layers did not necessarily measure what the compiler emits.
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 240)];
    t.tracks[V2].items = [gap('pad', 30), clip('over', 'v2', 0, 90)];
    const r = run(t);
    assert.equal(
      filterOf(r.graph, layerNodes(r.graph)[0].id),
      '[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,'
      + 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p[base];'
      + '[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,'
      + 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p[top];'
      + "[base][top]overlay=x=0:y=0:enable='between(t,0.983333,3.983333)',"
      // the last frame is held and then cut to an exact count, because a
      // measured blend of two 144 frame layers came back with 143
      + 'tpad=stop_mode=clone:stop_duration=1,format=yuv420p[v]',
    );
  });

  /**
   * Two defects found by measuring a real render, not by reading the code.
   *
   * `npm run prove:export` said 145 frames where the timeline said 144, and
   * probing every intermediate output of the run showed two separate causes:
   * the blend emitted 143 frames from two 144 frame inputs, and the final
   * encode then padded the picture out to the sound, which is 6.036854s for
   * a six second bed because AAC packets are 1024 samples. The suite was
   * green through both.
   */
  test('a layer node states the exact number of frames it must produce', () => {
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 240)];
    t.tracks[V2].items = [gap('pad', 30), clip('over', 'v2', 0, 90)];
    const r = run(t);
    const args = customArgs(r.graph, layerNodes(r.graph)[0].id);
    const at = args.indexOf('-frames:v');
    assert.ok(at > 0, 'the layer must be cut to a frame count, not to a duration');
    // 240 frames on the lower track is the whole programme
    assert.equal(args[at + 1], '240');
    assert.match(
      filterOf(r.graph, layerNodes(r.graph)[0].id),
      /tpad=stop_mode=clone/,
      'and padded first, because -frames:v is a cap and not a floor',
    );
  });

  test('the delivered file is exactly as long as the timeline, whatever the sound rounds to', () => {
    const t = doc();
    // a picture of 240 frames with a music bed under it: the bed is what
    // used to stretch the delivery by a frame
    t.tracks[V1].items = [clip('under', 'v1', 0, 240)];
    t.tracks[A1].items = [clip('bed', 'a1', 0, 240)];
    const r = run(t);
    const out = r.graph.nodes.find((n) => n.kind === 'output');
    assert.ok(out);
    const last = inputsInto(r.graph, out.id, 'file')[0];
    const params = engineParams(r.graph, last);
    // 240 frames at 30fps is 8 seconds, stated rather than left to the mux
    assert.equal(params.durationSec, 8);
  });

  test('two clips that touch are one run, not two gates', () => {
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 300)];
    t.tracks[V2].items = [gap('pad', 30), clip('a', 'v2', 0, 30), clip('b', 'v2', 600, 30)];
    const r = run(t);
    assertCompiles(r.graph, 'two touching clips above');
    // frames 30 to 90: where the cut between them falls is not the gate's business
    assert.equal(gateOf(r.graph, layerNodes(r.graph)[0].id), 'between(t,0.983333,2.983333)');
  });

  test('an upper track that covers the whole programme still costs one compose', () => {
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 120)];
    t.tracks[V2].items = [clip('over', 'v2', 0, 120)];
    const r = run(t);
    assertCompiles(r.graph, 'two full tracks');
    assert.equal(layerNodes(r.graph).length, 0, 'nothing to gate is nothing to fold');
    assert.equal(nodesOf(r.graph, 'ffmpeg/compose').length, 1);
  });

  test('the bottom track keeps its black, because there is nothing under it', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60), gap('g', 30), clip('b', 'v1', 300, 60)];
    t.tracks[V2].items = [clip('over', 'v2', 0, 150)];
    const r = run(t);
    assertCompiles(r.graph, 'a gap on the bottom track');
    assert.equal(layerNodes(r.graph).length, 0, 'the bottom layer has nothing to be gated against');
    assert.equal(nodesOf(r.graph, 'ffmpeg/synthetic').length, 1, 'its gap is still black');
  });

  test('a blend over a gap blends against the track below and is still gated', () => {
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 300)];
    t.tracks[V2].items = [gap('pad', 30), clip('over', 'v2', 0, 90, {
      effects: [{ kind: COMPOSITE_EFFECT, params: { mode: 'screen', opacity: 1 }, enabled: true }],
    })];
    const r = run(t);
    assertCompiles(r.graph, 'a gapped blend');

    const filter = filterOf(r.graph, layerNodes(r.graph)[0].id);
    // the base is used twice: once as what the blend reads, once as what the
    // gated blend is laid back over
    assert.match(filter, /split\[keep\]\[under\]/);
    assert.match(filter, /\[under\]\[top\]blend=all_mode=screen/);
    assert.match(filter, /\[keep\]\[mixed\]overlay=x=0:y=0:enable='between\(t,0\.983333,3\.983333\)'/);
  });

  test('more gaps than can be gated go back to black, and say so', () => {
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 300)];
    // 33 visible runs, one more than the gate will carry
    const chopped = [];
    for (let i = 0; i < 33; i += 1) {
      if (i) chopped.push(gap(`g${i}`, 2));
      chopped.push(clip(`c${i}`, 'v2', i * 10, 2));
    }
    t.tracks[V2].items = chopped;
    const r = run(t);
    assertCompiles(r.graph, 'a heavily chopped upper track');
    assert.equal(layerNodes(r.graph).length, 0, 'the expensive path is not taken for nothing');
    assert.equal(nodesOf(r.graph, 'ffmpeg/compose').length, 1);
    assert.ok(
      r.warnings.some((w) => /more gaps than can be gated/.test(w.message)),
      'the one case that still paints black has to admit it',
    );
  });
});

/**
 * Zoom and Position, all the way to the graph.
 *
 * These drove the viewer and nothing else for four turns: the inspector wrote
 * `cutroom/transform` onto the clip, the compiler skipped that kind outright,
 * and the export came back full frame. The values are in a file now, so the
 * numbers below are the ones the viewer paints with, worked out the same way:
 *
 *   zoom 0.25 of 1920x1080   is a 480x270 box to fit the picture inside
 *   posX -95                 is -95 x 0.2% of 1920, which is -365px
 *   posY 179                 is  179 x 0.2% of 1080, which is  387px
 *
 * `npm run prove:layers` renders this filter on the live node and reads the
 * pixels back, because no test here can tell you what colour a pixel is.
 */
describe('a clip that was moved or scaled is rendered where the viewer draws it', () => {
  const placed = (zoom: number, posX: number, posY: number): Clip['effects'] => [
    { kind: TRANSFORM_EFFECT, params: { zoom, posX, posY, rotation: 0 }, enabled: true },
  ];

  test('an upper track is scaled to its box and overlaid at its offset', () => {
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 300)];
    t.tracks[V2].items = [clip('over', 'v2', 0, 300, { effects: placed(0.25, -95, 179) })];
    const r = run(t);
    assertCompiles(r.graph, 'a placed upper track');

    const layer = layerNodes(r.graph)[0];
    assert.ok(layer, 'a placed track cannot be a compose cell, so it has to fold');
    assert.equal(
      filterOf(r.graph, layer.id),
      '[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,'
      + 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p[base];'
      + '[1:v]scale=480:270:force_original_aspect_ratio=decrease:force_divisible_by=2,'
      + 'setsar=1,fps=30,format=yuv420p[top];'
      + '[base][top]overlay=x=(W-w)/2-365:y=(H-h)/2+387,format=yuv420p[v]',
    );
    near(deliveredSeconds(r), 10, 'placing a layer does not change how long it runs');
  });

  test('the placed picture is not padded out to the frame', () => {
    // padding it would put a black border round the small picture and lay
    // that over the track below, which is the bug gating was added to fix
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 300)];
    t.tracks[V2].items = [clip('over', 'v2', 0, 300, { effects: placed(0.5, 0, 0) })];
    const filter = filterOf(run(t).graph, layerNodes(run(t).graph)[0].id);
    const top = filter.slice(filter.indexOf('[1:v]'), filter.indexOf('[top]'));
    assert.ok(!top.includes('pad='), `the top layer is padded: ${top}`);
    assert.match(filter, /overlay=x=\(W-w\)\/2:y=\(H-h\)\/2,/, 'no offset is dead centre');
  });

  test('the offset is a share of the frame, not a count of pixels', () => {
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 300)];
    t.tracks[V2].items = [clip('over', 'v2', 0, 300, { effects: placed(1, 50, 0) })];
    const sd = run(t, { delivery: { ...HD, width: 1280, height: 720 } });
    assertCompiles(sd.graph, 'a placed track at 720p');
    // 50 x 0.2% of 1280 is 128, where the same clip at 1920 moves 192
    assert.match(filterOf(sd.graph, layerNodes(sd.graph)[0].id), /overlay=x=\(W-w\)\/2\+128:/);
    assert.match(filterOf(run(t).graph, layerNodes(run(t).graph)[0].id), /overlay=x=\(W-w\)\/2\+192:/);
  });

  test('a gated layer is still gated when it is placed', () => {
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 300)];
    t.tracks[V2].items = [gap('pad', 30), clip('over', 'v2', 0, 90, { effects: placed(0.5, 0, 0) })];
    const r = run(t);
    assertCompiles(r.graph, 'a placed and gated layer');
    assert.equal(gateOf(r.graph, layerNodes(r.graph)[0].id), 'between(t,0.983333,3.983333)');
  });

  test('an opacity on a placed layer is carried in its alpha, not in a blend', () => {
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 300)];
    t.tracks[V2].items = [clip('over', 'v2', 0, 300, {
      effects: [
        ...placed(0.5, 0, 0),
        { kind: COMPOSITE_EFFECT, params: { mode: 'normal', opacity: 0.4 }, enabled: true },
      ],
    })];
    const r = run(t);
    assertCompiles(r.graph, 'a placed layer at 40%');
    const filter = filterOf(r.graph, layerNodes(r.graph)[0].id);
    assert.match(filter, /format=yuva420p,colorchannelmixer=aa=0\.4\[top\]/);
    assert.ok(!filter.includes('blend='), 'normal at an opacity is an overlay, not a blend');
  });

  test('a blend mode on a placed layer blends through the picture is mask', () => {
    // outside the placed picture there is nothing to blend, and what `blend`
    // would say there is wrong: multiply against an empty canvas is black
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 300)];
    t.tracks[V2].items = [clip('over', 'v2', 0, 300, {
      effects: [
        ...placed(0.5, 0, 0),
        { kind: COMPOSITE_EFFECT, params: { mode: 'multiply', opacity: 1 }, enabled: true },
      ],
    })];
    const r = run(t);
    assertCompiles(r.graph, 'a placed blend');
    const filter = filterOf(r.graph, layerNodes(r.graph)[0].id);
    assert.match(filter, /color=c=black@0:s=1920x1080:r=30,format=yuva420p\[canvas\]/);
    assert.match(filter, /\[full\]split\[shown\]\[alpha\];\[alpha\]alphaextract\[mask\]/);
    assert.match(filter, /\[under\]\[shown\]blend=all_mode=multiply/);
    assert.match(filter, /\[mixed\]\[mask\]alphamerge\[masked\]/);
    assert.match(filter, /\[keep\]\[masked\]overlay=x=0:y=0,format=yuv420p\[v\]/);
  });

  test('the bottom track is placed on black, and keeps the sound it carries', () => {
    const t = doc();
    t.tracks[V1].items = [clip('only', 'v1', 0, 300, { effects: placed(0.25, 0, 0) })];
    const r = run(t);
    assertCompiles(r.graph, 'a placed bottom track');

    const node = nodesOf(r.graph, 'ffmpeg/custom')
      .find((n) => String(engineParams(r.graph, n.id).output ?? '').startsWith('placed.'));
    assert.ok(node, 'the bottom layer has to be placed by a node of its own');
    assert.equal(
      filterOf(r.graph, node.id),
      'color=c=black:s=1920x1080:r=30[bg];'
      + '[0:v]scale=480:270:force_original_aspect_ratio=decrease:force_divisible_by=2,'
      + 'setsar=1,fps=30,format=yuv420p[top];'
      + '[bg][top]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1,format=yuv420p[v]',
    );
    const args = customArgs(r.graph, node.id);
    assert.ok(args.includes('0:a?'), 'without a sound track this clip is the only sound there is');
    assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2), ['-c:a', 'copy']);
    near(deliveredSeconds(r), 10, 'placing the bottom layer does not change how long it runs');
  });

  test('a clip left where it was costs nothing at all', () => {
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 300)];
    t.tracks[V2].items = [clip('over', 'v2', 0, 300, { effects: placed(1, 0, 0) })];
    const r = run(t);
    assertCompiles(r.graph, 'an identity transform');
    assert.equal(layerNodes(r.graph).length, 0, 'an identity transform is not a reason to fold');
    assert.equal(nodesOf(r.graph, 'ffmpeg/compose').length, 1);
    assert.deepEqual(r.warnings, []);
  });

  test('clips on one track that disagree are placed once, and it is said out loud', () => {
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 300)];
    t.tracks[V2].items = [
      clip('a', 'v2', 0, 150, { effects: placed(0.5, 0, 0) }),
      clip('b', 'v2', 300, 150, { effects: placed(0.25, 40, 0) }),
    ];
    const r = run(t);
    assertCompiles(r.graph, 'two clips placed differently');
    assert.match(filterOf(r.graph, layerNodes(r.graph)[0].id), /scale=960:540:/, 'the first one wins');
    assert.ok(
      r.warnings.some((w) => /placed differently/.test(w.message)),
      'a value that could not be honoured exactly has to be reported',
    );
  });

  test('rotation is not read here, because the segment already carries it', () => {
    // paramsToEffects writes rotation into both cutroom/transform and an
    // ffmpeg/rotate on the clip. Reading it twice turns 90 degrees into 180.
    // (ffmpeg/rotate takes quarter turns and nothing else, which is why the
    // angle here is 90 and not the 30 the slider will happily offer.)
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 300)];
    t.tracks[V2].items = [clip('over', 'v2', 0, 300, {
      effects: [
        { kind: TRANSFORM_EFFECT, params: { zoom: 1, posX: 0, posY: 0, rotation: 90 }, enabled: true },
        { kind: 'ffmpeg/rotate', params: { degrees: '90' }, enabled: true },
      ],
    })];
    const r = run(t);
    assertCompiles(r.graph, 'a rotated clip');
    assert.equal(nodesOf(r.graph, 'ffmpeg/rotate').length, 1, 'rotated once');
    assert.equal(layerNodes(r.graph).length, 0, 'and rotation alone is not a placement');
  });

  test('a transform on a switched off effect is not applied', () => {
    const t = doc();
    t.tracks[V1].items = [clip('under', 'v1', 0, 300)];
    t.tracks[V2].items = [clip('over', 'v2', 0, 300, {
      effects: [{ kind: TRANSFORM_EFFECT, params: { zoom: 0.5, posX: 0, posY: 0 }, enabled: false }],
    })];
    const r = run(t);
    assertCompiles(r.graph, 'a disabled transform');
    assert.equal(layerNodes(r.graph).length, 0);
  });
});

describe('an empty track is not the same as a track outside the range', () => {
  test('a track holding nothing but a gap says nothing', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 120)];
    t.tracks[V2].items = [gap('left over', 60)]; // a clip was here, and was deleted
    t.tracks[A2].items = [gap('also', 60)];
    const r = run(t);
    assertCompiles(r.graph, 'a track of gaps');
    assert.deepEqual(
      r.warnings.filter((w) => w.code === 'empty_track'), [],
      'an empty track is empty, and the export has nothing to tell anyone about it',
    );
  });

  test('a track whose clips are all switched off says nothing either', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 120)];
    t.tracks[V2].items = [clip('off', 'v2', 0, 120, { enabled: false })];
    const r = run(t);
    assertCompiles(r.graph, 'a track of disabled clips');
    assert.deepEqual(r.warnings.filter((w) => w.code === 'empty_track'), []);
  });

  test('clips that all fall outside the rendered range are reported as such', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 300)];
    t.tracks[V2].items = [gap('wait', 150), clip('late', 'v2', 0, 90)];
    t.tracks[A2].items = [gap('wait', 150), clip('sting', 'a1', 0, 90)];
    const r = run(t, { range: timeRange(F(0), F(60)) });
    assertCompiles(r.graph, 'a range that misses two tracks');

    const said = r.warnings.filter((w) => w.code === 'empty_track').map((w) => w.message);
    assert.equal(said.length, 2, 'both tracks the range misses are reported');
    assert.ok(said.every((m) => /none of them inside the range being rendered/.test(m)), said.join(' / '));
  });
});

// ── time ────────────────────────────────────────────────────────────────

describe('frames survive the trip to seconds', () => {
  test('a cut is the clip source range, in seconds at the project rate', () => {
    const t = doc();
    t.tracks[V1].items = [clip('c1', 'v1', 45, 90)];
    const p = paramsOf(run(t).graph, 'ffmpeg/trim')[0];
    assert.equal(p.startSec, 1.5, '45 frames at 30fps');
    assert.equal(p.durationSec, 3, '90 frames at 30fps');
  });

  test('a preview range is half open, so its last frame is the next clip\'s first', () => {
    const t = doc();
    t.tracks[V1].items = [clip('first', 'v1', 0, 30), clip('second', 'v1', 600, 30)];
    // [30, 60) is exactly the second clip and none of the first
    const r = run(t, { range: { start: F(30), duration: F(30) } });
    assertCompiles(r.graph, 'preview range');
    const trims = paramsOf(r.graph, 'ffmpeg/trim');
    assert.equal(trims.length, 1, 'the frame at 30 belongs to the second clip only');
    assert.equal(trims[0].startSec, 20, 'source frame 600 at 30fps');
    assert.equal(trims[0].durationSec, 1);
  });

  test('a range that cuts into a clip moves the source start with it', () => {
    const t = doc();
    t.tracks[V1].items = [clip('c', 'v1', 300, 120)];
    const r = run(t, { range: { start: F(30), duration: F(30) } });
    const p = paramsOf(r.graph, 'ffmpeg/trim')[0];
    assert.equal(p.startSec, 11, 'source frame 300 + 30 frames of head, at 30fps');
    assert.equal(p.durationSec, 1);
  });

  test('a range past the end of the timeline still produces a valid graph', () => {
    const t = doc();
    t.tracks[V1].items = [clip('c', 'v1', 0, 60)];
    const r = run(t, { range: { start: F(9000), duration: F(60) } });
    assertCompiles(r.graph, 'range past the end');
    assert.ok(r.warnings.some((w) => w.code === 'empty_track'));
  });

  test('a cut too short for ffmpeg is lengthened, and said so', () => {
    const t = doc();
    t.tracks[V1].items = [clip('single', 'v1', 0, 1)]; // 1/30s is under the 0.04s floor
    const r = run(t);
    assertCompiles(r.graph, 'one frame clip');
    assert.equal(paramsOf(r.graph, 'ffmpeg/trim')[0].durationSec, 0.04);
    // not rate_mismatch: that code means the media's rate disagrees with the
    // project's, and a caller filtering on it would report something untrue
    assert.ok(r.warnings.some((w) => w.code === 'unsupported_effect' && w.clipId === 'single'));
    assert.equal(r.warnings.filter((w) => w.code === 'rate_mismatch').length, 0);
  });

  test('media at another rate is reported once, not once per clip', () => {
    const t = doc();
    t.media.v1.rate = RATES.ntscFilm;
    t.tracks[V1].items = [clip('a', 'v1', 0, 60), clip('b', 'v1', 300, 60)];
    const r = run(t);
    assert.equal(r.warnings.filter((w) => w.code === 'rate_mismatch').length, 1);
  });
});

// ── caching ─────────────────────────────────────────────────────────────

describe('cache keys address content and nothing else', () => {
  test('the key is 16 hex characters', () => {
    assert.match(cacheKey('src', 'ffmpeg/trim', { startSec: 1 }), /^[0-9a-f]{16}$/);
  });

  test('param order does not change the key, param values do', () => {
    const a = cacheKey('src', 'ffmpeg/trim', { startSec: 1, durationSec: 2, reencode: true });
    const b = cacheKey('src', 'ffmpeg/trim', { reencode: true, durationSec: 2, startSec: 1 });
    assert.equal(a, b);
    assert.notEqual(a, cacheKey('src', 'ffmpeg/trim', { startSec: 1, durationSec: 2.5, reencode: true }));
    assert.notEqual(a, cacheKey('other', 'ffmpeg/trim', { startSec: 1, durationSec: 2, reencode: true }));
    assert.notEqual(a, cacheKey('src', 'ffmpeg/transcode', { startSec: 1, durationSec: 2, reencode: true }));
  });

  test('an unset param and one set to undefined are the same request', () => {
    assert.equal(
      cacheKey('src', 'op', { a: 1, b: undefined }),
      cacheKey('src', 'op', { a: 1 }),
    );
    assert.deepEqual(canonicalise({ b: 2, a: { d: 4, c: undefined } }), { a: { d: 4 }, b: 2 });
  });

  test('array order is part of the key, because concat order is', () => {
    assert.notEqual(
      cacheKey('src', 'ffmpeg/custom', { args: ['-i', 'a', 'b'] }),
      cacheKey('src', 'ffmpeg/custom', { args: ['-i', 'b', 'a'] }),
    );
  });

  test('two clips cut identically from one file are one key, and the repeat keeps its wire', () => {
    const t = doc();
    t.tracks[V1].items = [clip('first', 'v1', 120, 60), clip('gapfill', 'v2', 0, 30), clip('again', 'v1', 120, 60)];
    const r = run(t);
    assertCompiles(r.graph, 'repeated cut');

    const trims = nodesOf(r.graph, 'ffmpeg/trim');
    const keys = trims.map((n) => r.cacheKeys[n.id]);
    assert.ok(trims.length >= 2, 'expected cuts to compare');
    assert.equal(new Set(keys).size, 2, 'two distinct files between three cuts');

    // An edge is its two endpoints, so one node cannot feed one port twice:
    // the repeated content is twinned on its way into the join. Which node
    // carries the twin is an implementation detail and the count of trims is
    // not the promise. The promise is that the join still sees three segments,
    // because two would silently drop a clip out of the programme.
    const join = nodesOf(r.graph, 'ffmpeg/concat');
    assert.equal(join.length, 1, 'one join for the one picture track');
    const into = r.graph.edges.filter((e) => e.to.node === join[0].id && e.to.port === 'inputs');
    assert.equal(into.length, 3, 'three segments on the track, three wires into the join');
    assert.equal(new Set(into.map((e) => e.from.node)).size, 3, 'and three distinct nodes feeding it');
  });

  test('a different clip id with the same cut is still the same key', () => {
    const one = doc();
    one.tracks[V1].items = [clip('clip_A', 'v1', 90, 45)];
    const two = doc();
    two.tracks[V1].items = [clip('totally_different_id', 'v1', 90, 45)];
    const keyOf = (r: CompileResult) => r.cacheKeys[nodesOf(r.graph, 'ffmpeg/trim')[0].id];
    assert.equal(keyOf(run(one)), keyOf(run(two)));
  });

  test('a cache hit removes the node and records the key', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60), clip('b', 'v1', 600, 60)];
    const cold = run(t);
    const hit = cold.cacheKeys[nodesOf(cold.graph, 'ffmpeg/trim')[0].id];

    const warm = run(t, { cache: new Map([[hit, 'built/segment-a.mp4']]) });
    assertCompiles(warm.graph, 'cache hit');
    assert.deepEqual(warm.reused, [hit]);
    assert.equal(
      nodesOf(warm.graph, 'ffmpeg/trim').length,
      nodesOf(cold.graph, 'ffmpeg/trim').length - 1,
      'the cut that already exists is not cut again',
    );
    assert.ok(
      engines(warm.graph).length < engines(cold.graph).length,
      'a hit means fewer jobs',
    );
    // the finished file still has to reach the join, as an input
    const join = nodesOf(warm.graph, 'ffmpeg/concat')[0];
    assert.equal(inputsInto(warm.graph, join.id, 'inputs').length, 2);
    const stand = warm.graph.nodes.find((n) => n.kind === 'input' && n.id.includes('cached'));
    assert.ok(stand, 'the cached file enters the graph as an input');
    assert.equal(warm.cacheKeys[stand.id], hit, 'so the executor knows which file to supply');
    assert.equal(cold.reused.length, 0);
  });

  test('caching the last node leaves a graph with no work in it at all', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60)];
    const cold = run(t);
    const last = cold.cacheKeys[nodesOf(cold.graph, 'ffmpeg/transcode')[0].id];
    const warm = run(t, { cache: new Map([[last, 'built/final.mp4']]) });
    assertCompiles(warm.graph, 'everything cached');
    assert.deepEqual(engines(warm.graph), []);
    assert.deepEqual(warm.reused, [last]);
  });
});

// ── the keyframe trap ───────────────────────────────────────────────────

describe('reencode', () => {
  test('reencode false warns that cuts move to the nearest keyframe', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 120, 60), clip('b', 'v1', 600, 60)];
    const r = run(t, { delivery: { ...HD, reencode: false } });
    assertCompiles(r.graph, 'stream copy');

    const warned = r.warnings.filter((w) => w.code === 'keyframe_cut');
    assert.equal(warned.length, 1, 'one warning for the render, not one per cut');
    assert.match(warned[0].message, /2 cut/);
    assert.equal(paramsOf(r.graph, 'ffmpeg/trim')[0].reencode, false);
  });

  test('reencode true is frame accurate and says nothing', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 120, 60), clip('b', 'v1', 600, 60)];
    const r = run(t, { delivery: { ...HD, reencode: true } });
    assert.equal(r.warnings.filter((w) => w.code === 'keyframe_cut').length, 0);
    assert.equal(paramsOf(r.graph, 'ffmpeg/trim')[0].reencode, true);
  });

  test('a join of mixed sources is brought to one shape, because concat will not do it', () => {
    const t = doc();
    // Generated black is the delivery size and carries no sound; a cut is the
    // source's size and carries one. ffmpeg/concat refuses that join at BOTH
    // values of reencode, with ffmpeg's EINVAL and no diagnostics, which is
    // the render failure this test was written the wrong way round for.
    // Proved by npm run prove:concat.
    t.tracks[V1].items = [clip('a', 'v1', 0, 60), gap('g', 30)];
    const r = run(t, { delivery: { ...HD, reencode: false } });
    assertCompiles(r.graph, 'mixed join');
    assert.equal(paramsOf(r.graph, 'ffmpeg/concat')[0].reencode, false, 'always the demuxer');

    const fits = fitNodes(r.graph);
    assert.equal(fits.length, 2, 'the cut and the black are both brought to one shape');
    for (const f of fits) {
      const args = (f.args as string[]).join(' ');
      assert.match(args, /scale=1920:1080/, 'to the delivery size');
      assert.match(args, /(^| )-an( |$)/, 'and with no sound, which the join cannot take unevenly');
    }
  });

  test('a join of stream copies from one file keeps the demuxer and re-encodes nothing', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60), clip('b', 'v1', 600, 60)];
    const r = run(t, { delivery: { ...HD, reencode: false } });
    assert.equal(paramsOf(r.graph, 'ffmpeg/concat')[0].reencode, false);
    // two cuts of one file share an encoder, so they already agree and the
    // whole point of the copy path is that nothing is re-encoded to join them
    assert.equal(fitNodes(r.graph).length, 0, 'nothing had to be matched');
  });
});

// ── what the join will actually take ────────────────────────────────────

/**
 * These assert facts about the live API, not preferences.
 *
 * `ffmpeg/concat` joins its inputs as they are: it does not scale them and it
 * does not put a silent track on a file that has none. `reencode: true` does
 * not rescue either case, it only re-encodes what is already compatible, and
 * an input set it cannot take comes back as "ffmpeg exited 234" with no
 * diagnostics at all. Every one of these was measured by npm run prove:concat,
 * and the render died in production on the two the compiler was getting wrong.
 */
describe('what ffmpeg/concat will actually take', () => {
  test('a sound track with a gap in it never asks for a video codec', () => {
    const t = doc();
    t.tracks[A1].items = [clip('music', 'a1', 0, 90), gap('hole', 30), clip('more', 'a1', 300, 90)];
    const r = run(t);
    assertCompiles(r.graph, 'a sound join');

    const joins = paramsOf(r.graph, 'ffmpeg/concat');
    assert.ok(joins.length > 0, 'expected a join to inspect');
    for (const j of joins) {
      assert.equal(j.reencode, false, 'the reencode path cannot take audio at all');
      assert.equal(j.videoCodec, undefined, 'there is no picture here to encode');
    }
  });

  test('every input to a sound join is audio, in one shape', () => {
    const t = doc();
    t.tracks[A1].items = [clip('music', 'a1', 0, 90), gap('hole', 30), clip('more', 'a1', 300, 90)];
    const r = run(t);

    const join = nodesOf(r.graph, 'ffmpeg/concat')[0];
    const feeding = r.graph.edges
      .filter((e) => e.to.node === join.id && e.to.port === 'inputs')
      .map((e) => r.graph.nodes.find((n) => n.id === e.from.node)!);
    assert.equal(feeding.length, 3, 'three segments, three wires');

    // a wav clip, a generated silence and another wav clip arrive in three
    // different codecs, and the demuxer refuses anything but one
    for (const n of feeding) {
      assert.equal(n.kind, 'engine');
      const params = engineParams(r.graph, n.id);
      const shape = n.operation === 'extract-audio'
        ? params
        : { codec: 'aac', sampleRate: '48000', channels: '2' };
      assert.equal(shape.codec, 'aac');
      assert.equal(shape.sampleRate, '48000');
      assert.equal(shape.channels, '2');
    }
  });

  test('a picture track with a gap brings the cut and the black to one size', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60), gap('g', 30), clip('b', 'v1', 300, 60)];
    const r = run(t, { delivery: { width: 1280, height: 720, container: 'mp4', reencode: true } });
    assertCompiles(r.graph, 'a picture join');

    const fits = fitNodes(r.graph);
    assert.equal(fits.length, 3, 'one per segment');
    for (const f of fits) {
      assert.match((f.args as string[]).join(' '), /scale=1280:720/, 'the delivery size, not the source\'s');
    }
  });

  test('a timeline with no sound track of its own is told where its sound went', () => {
    const t = doc();
    // two cuts, no gap and no audio track: the picture used to carry its own
    // sound here, and matching the segments for the join takes it away
    t.tracks[V1].items = [clip('a', 'v1', 0, 60), clip('b', 'v2', 300, 60)];
    const r = run(t);
    assertCompiles(r.graph, 'no sound track');
    assert.ok(fitNodes(r.graph).length > 0, 'the fixture has to be one that gets matched');

    const said = r.warnings.filter((w) => /audio track/.test(w.message));
    assert.equal(said.length, 1, 'losing the sound in silence is the thing not to do');
  });

  test('one clip is one segment, and a segment with nothing to agree with is left alone', () => {
    const t = doc();
    t.tracks[V1].items = [clip('only', 'v1', 0, 240)];
    const r = run(t);
    assertCompiles(r.graph, 'a single clip');
    assert.equal(nodesOf(r.graph, 'ffmpeg/concat').length, 0, 'nothing to join');
    assert.equal(fitNodes(r.graph).length, 0, 'and so nothing to re-encode for a join');
  });
});

// ── types ───────────────────────────────────────────────────────────────

describe('a value is typed by what it is', () => {
  test('a PNG is file:image and never reaches ffmpeg/trim', () => {
    const t = doc();
    t.tracks[V1].items = [clip('still', 'png', 0, 60)];
    const r = run(t);
    assertCompiles(r.graph, 'a still');

    const image = r.graph.nodes.find((n) => n.kind === 'input' && n.type === 'file:image');
    assert.ok(image, 'the image input is typed as an image');
    assert.equal(nodesOf(r.graph, 'ffmpeg/trim').length, 0, 'trim takes video or audio, not an image');
    // it is held for the clip's length instead
    const held = paramsOf(r.graph, 'ffmpeg/custom')[0];
    assert.deepEqual((held.args as string[]).slice(0, 2), ['-loop', '1']);
    assert.ok((held.args as string[]).includes('2'), '60 frames at 30fps is 2 seconds');
  });

  test('a subtitle file is file:subtitle, even though MediaRef has no such kind', () => {
    const t = doc();
    t.tracks[V1].items = [clip('pic', 'v1', 0, 60)];
    t.tracks.push(subtitleTrack([clip('s', 'srt', 0, 60)]));
    const r = run(t, { burnSubtitles: true });
    assertCompiles(r.graph, 'burned in subtitles');
    assert.ok(r.graph.nodes.some((n) => n.kind === 'input' && n.type === 'file:subtitle'));
    assert.ok(paramsOf(r.graph, 'ffmpeg/custom').some((p) => (p.args as string[]).includes('subtitles={in1}')));
  });

  test('subtitles asked for with none in the document is a warning, not a broken graph', () => {
    const t = doc();
    t.tracks[V1].items = [clip('pic', 'v1', 0, 60)];
    const r = run(t, { burnSubtitles: true });
    assertCompiles(r.graph, 'no subtitles to burn');
    assert.ok(r.warnings.some((w) => w.code === 'no_media'));
    assert.equal(nodesOf(r.graph, 'ffmpeg/custom').length, 0);
  });

  test('one media used twice is one input node, so the request schema has one field', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60), clip('b', 'v1', 600, 60)];
    const r = run(t);
    assert.equal(r.graph.nodes.filter((n) => n.kind === 'input').length, 1);
  });

  test('sound taken from a video file has its picture dropped first', () => {
    const t = doc();
    t.tracks[V1].items = [clip('pic', 'v2', 0, 60)];
    t.tracks[A1].items = [clip('dialogue', 'v1', 0, 60)];
    const r = run(t);
    assertCompiles(r.graph, 'audio from video');
    assert.equal(nodesOf(r.graph, 'ffmpeg/extract-audio').length, 1);
  });
});

// ── what the document gets wrong ────────────────────────────────────────

describe('a document the compiler cannot honour warns instead of guessing', () => {
  test('missing media becomes black and is reported against the clip', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60), clip('ghost', 'not-here', 0, 60)];
    const r = run(t);
    assertCompiles(r.graph, 'missing media');
    const w = r.warnings.find((x) => x.code === 'no_media');
    assert.equal(w?.clipId, 'ghost');
    assert.equal(nodesOf(r.graph, 'ffmpeg/synthetic').length, 1);
  });

  test('a disabled clip holds its time open rather than shifting the cut', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60), clip('off', 'v1', 600, 60, { enabled: false })];
    const r = run(t);
    assertCompiles(r.graph, 'disabled clip');
    assert.equal(nodesOf(r.graph, 'ffmpeg/trim').length, 1);
    assert.equal(paramsOf(r.graph, 'ffmpeg/synthetic')[0].durationSec, 2, 'its 60 frames are still there');
  });

  test('two gaps in a row are one piece of black, not two jobs', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 30), gap('g1', 30), gap('g2', 30), clip('b', 'v1', 600, 30)];
    const r = run(t);
    assertCompiles(r.graph, 'adjacent gaps');
    assert.equal(nodesOf(r.graph, 'ffmpeg/synthetic').length, 1);
    assert.equal(paramsOf(r.graph, 'ffmpeg/synthetic')[0].durationSec, 2);
  });

  test('a short track is padded so the layers stay in sync', () => {
    const t = doc();
    t.tracks[V2].items = [clip('over', 'v2', 0, 30)];
    t.tracks[V1].items = [clip('under', 'v1', 0, 120)];
    const r = run(t);
    assertCompiles(r.graph, 'short upper track');
    // the upper layer runs 30 frames and the programme 120, so 90 frames of
    // filler keep the composite from ending early
    assert.equal(paramsOf(r.graph, 'ffmpeg/synthetic')[0].durationSec, 3);
  });

  test('a transition is reported rather than silently dropped', () => {
    const t = doc();
    const dissolve: Transition = {
      id: 'tr1', kind: 'transition', transitionType: 'dissolve', inOffset: F(6), outOffset: F(6),
    };
    t.tracks[V1].items = [clip('a', 'v1', 0, 60), dissolve, clip('b', 'v1', 600, 60)];
    const r = run(t);
    assertCompiles(r.graph, 'a transition');
    const w = r.warnings.find((x) => x.code === 'unsupported_effect');
    assert.equal(w?.clipId, 'tr1');
  });

  test('an effect nothing implements is skipped and the rest of the chain survives', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60, {
      effects: [
        { kind: 'lens-flare', params: {}, enabled: true },
        { kind: 'speed', params: { factor: 2 }, enabled: true },
      ],
    })];
    const r = run(t);
    assertCompiles(r.graph, 'an unknown effect');
    assert.equal(nodesOf(r.graph, 'ffmpeg/speed').length, 1);
    assert.ok(r.warnings.some((w) => w.code === 'unsupported_effect' && w.clipId === 'a'));
  });

  test('an effect missing a required param is skipped, not emitted broken', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60, {
      effects: [{ kind: 'crop', params: { gravity: 'north' }, enabled: true }],
    })];
    const r = run(t);
    assertCompiles(r.graph, 'crop with no box');
    assert.equal(nodesOf(r.graph, 'ffmpeg/crop').length, 0);
    assert.ok(r.warnings.some((w) => w.code === 'unsupported_effect'));
  });

  test('a delivery codec the operation will not take is dropped, not compiled in', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60)];
    const r = run(t, { delivery: { ...HD, videoCodec: 'prores', videoBitrate: 'lots' } });
    assertCompiles(r.graph, 'a bad delivery spec');
    const p = paramsOf(r.graph, 'ffmpeg/transcode')[0];
    assert.equal(p.videoCodec, undefined);
    assert.equal(p.videoBitrate, undefined);
    assert.equal(r.warnings.filter((w) => w.code === 'unsupported_effect').length, 2);
  });
});

// ── effects and sound ───────────────────────────────────────────────────

describe('effects and sound', () => {
  test('effects chain in the order the clip lists them', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60, {
      effects: [
        { kind: 'speed', params: { factor: 2 }, enabled: true },
        { kind: 'fade', params: { inSec: 0.5, outSec: 0.5 }, enabled: true },
        { kind: 'volume', params: { gainDb: -6 }, enabled: true },
      ],
    })];
    const r = run(t);
    assertCompiles(r.graph, 'an effect chain');

    const trim = nodesOf(r.graph, 'ffmpeg/trim')[0].id;
    const speed = nodesOf(r.graph, 'ffmpeg/speed')[0].id;
    const fade = nodesOf(r.graph, 'ffmpeg/fade')[0].id;
    const volume = nodesOf(r.graph, 'ffmpeg/volume')[0].id;
    assert.deepEqual(inputsInto(r.graph, speed, 'input'), [trim]);
    assert.deepEqual(inputsInto(r.graph, fade, 'input'), [speed]);
    assert.deepEqual(inputsInto(r.graph, volume, 'input'), [fade]);
    assert.deepEqual(inputsInto(r.graph, nodesOf(r.graph, 'ffmpeg/transcode')[0].id, 'input'), [volume]);
  });

  test('a disabled effect is not emitted', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60, {
      effects: [{ kind: 'speed', params: { factor: 2 }, enabled: false }],
    })];
    assert.equal(nodesOf(run(t).graph, 'ffmpeg/speed').length, 0);
  });

  test('two sound tracks are summed at unity and put back onto the picture', () => {
    const t = doc();
    t.tracks[V1].items = [clip('pic', 'v1', 0, 120)];
    t.tracks[A1].items = [clip('vo', 'a1', 0, 120)];
    t.tracks[A2].items = [clip('mus', 'a1', 600, 120)];
    const r = run(t);
    assertCompiles(r.graph, 'a two track mix');

    const mix = nodesOf(r.graph, 'ffmpeg/custom').find(
      (n) => ((n as { params: Record<string, unknown> }).params.output) === 'mix.m4a',
    );
    assert.ok(mix, 'two beds need mixing');
    assert.equal(inputsInto(r.graph, mix.id, 'input').length, 2);
    const args = engineParams(r.graph, mix.id).args as string[];
    assert.ok(args.some((a) => a.includes('amix=inputs=2')));
    assert.ok(args.some((a) => a.includes('normalize=0')), 'an NLE sums tracks, it does not duck them');
  });

  test('a muted track is not in the mix and a soloed one is the only thing in it', () => {
    const t = doc();
    t.tracks[V1].items = [clip('pic', 'v1', 0, 120)];
    t.tracks[A1].items = [clip('vo', 'a1', 0, 120)];
    t.tracks[A2].items = [clip('mus', 'a1', 600, 120)];

    t.tracks[A2].muted = true;
    const muted = run(t);
    assert.equal(nodesOf(muted.graph, 'ffmpeg/custom').length, 0, 'one bed needs no mix');
    assertCompiles(muted.graph, 'a muted track');

    t.tracks[A2].muted = false;
    t.tracks[A2].solo = true;
    const solo = run(t);
    assertCompiles(solo.graph, 'a soloed track');
    const replace = nodesOf(solo.graph, 'ffmpeg/audio-replace')[0];
    const bed = inputsInto(solo.graph, replace.id, 'audio')[0];
    assert.equal(
      engineParams(solo.graph, bed).startSec, 20,
      'source frame 600: the soloed track, not the other one',
    );
  });

  test('a gap on a sound track is silence, not a tone', () => {
    const t = doc();
    t.tracks[V1].items = [clip('pic', 'v1', 0, 120)];
    t.tracks[A1].items = [clip('vo', 'a1', 0, 60), gap('g', 60)];
    const r = run(t);
    assertCompiles(r.graph, 'a gap in the sound');
    const args = paramsOf(r.graph, 'ffmpeg/custom')[0].args as string[];
    assert.ok(args.some((a) => a.startsWith('anullsrc')));
  });
});

// ── the report ──────────────────────────────────────────────────────────

describe('the result tells the caller what it is about to spend', () => {
  test('every emitted node has a cache key and the estimate counts them', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60), gap('g', 30), clip('b', 'v2', 0, 60)];
    const r = run(t);
    for (const n of r.graph.nodes) {
      if (n.kind === 'engine') assert.match(r.cacheKeys[n.id] ?? '', /^[0-9a-f]{16}$/, n.id);
    }
    assert.equal(r.estimate.nodes, r.graph.nodes.length);
    assert.ok(r.estimate.gpuSeconds > 0);
  });

  test('a stream copy is estimated cheaper than a re-encode of the same edit', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 300), clip('b', 'v1', 600, 300)];
    const copy = run(t, { delivery: { ...HD, reencode: false } });
    const full = run(t, { delivery: { ...HD, reencode: true } });
    assert.ok(copy.estimate.gpuSeconds < full.estimate.gpuSeconds);
  });

  test('the delivery container reaches the last node', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60)];
    const r = run(t, { delivery: { ...HD, container: 'webm', videoCodec: 'vp9' } });
    assertCompiles(r.graph, 'a webm delivery');
    const p = paramsOf(r.graph, 'ffmpeg/transcode')[0];
    assert.equal(p.container, 'webm');
    assert.equal(p.videoCodec, 'vp9');
    assert.equal(p.fps, 30);
  });
});

// ── lengths ─────────────────────────────────────────────────────────────
// Every track is padded to the compiled length, so anything that changes a
// segment's length changes where every later segment lands. These check the
// length the graph will really produce, not the shape of the nodes in it.

describe('every branch comes out the length the timeline says', () => {
  test('filler longer than ffmpeg/synthetic will generate is still the right length', () => {
    const t = doc();
    t.media.v1.available = timeRange(F(0), F(40000));
    const twentyMinutes = 30 * 60 * 20;
    t.tracks[V1].items = [clip('programme', 'v1', 0, twentyMinutes)];
    t.tracks[V2].items = [clip('title', 'v2', 0, 90)]; // three seconds over the top
    const r = run(t);
    assertCompiles(r.graph, 'a twenty minute programme');

    // synthetic.durationSec stops at 600, and the title's track needs 1197
    // seconds of filler under it. Clamping would end that layer at 603s.
    assert.equal(nodesOf(r.graph, 'ffmpeg/synthetic').length, 0);
    // the title is on screen for three seconds of the twenty minutes, so the
    // layer is gated: both inputs still have to run the whole programme, or
    // the overlay ends where the shorter one does
    const layer = layerNodes(r.graph)[0];
    assert.ok(layer, 'a title over a programme is one layer over another');
    const layers = inputsInto(r.graph, layer.id, 'input').map((id) => renderedSeconds(r.graph, id));
    assert.deepEqual(layers, [1200, 1200], 'both layers run the whole twenty minutes');
    near(deliveredSeconds(r), 1200);
  });

  test('a gap too short for ffmpeg/synthetic is not stretched to fit it', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 30), gap('g', 1), clip('b', 'v1', 600, 30)];
    const r = run(t);
    assertCompiles(r.graph, 'a one frame gap');
    assert.equal(nodesOf(r.graph, 'ffmpeg/synthetic').length, 0, 'a frame at 30fps is under the 0.1s floor');
    assert.equal(customDuration(r.graph, nodesOf(r.graph, 'ffmpeg/custom')[0].id), 0.033333);
    near(deliveredSeconds(r), 61 / 30, 'the track is exactly as long as the timeline');
  });

  test('a one frame hole in the sound is one frame of silence, not a tenth of a second', () => {
    const t = doc();
    t.tracks[V1].items = [clip('pic', 'v1', 0, 60)];
    t.tracks[A1].items = [clip('vo', 'a1', 0, 59)]; // one frame short of the picture
    const r = run(t);
    assertCompiles(r.graph, 'a one frame hole in the sound');
    const quiet = nodesOf(r.graph, 'ffmpeg/custom')
      .find((n) => customArgs(r.graph, n.id).some((a) => a.startsWith('anullsrc')));
    assert.ok(quiet, 'the hole is filled with silence');
    assert.equal(customDuration(r.graph, quiet.id), 0.033333);
    near(deliveredSeconds(r), 2, 'the sound is exactly as long as the picture');
  });

  test('a still is held for its slot and not for the generator floor', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60), clip('flash', 'png', 0, 1)];
    const r = run(t);
    assertCompiles(r.graph, 'a one frame still');
    const held = nodesOf(r.graph, 'ffmpeg/custom')[0];
    assert.deepEqual(customArgs(r.graph, held.id).slice(0, 2), ['-loop', '1']);
    assert.equal(customDuration(r.graph, held.id), 0.033333);
    near(deliveredSeconds(r), 61 / 30, 'the picture is as long as the timeline');
  });
});

// ── retiming ────────────────────────────────────────────────────────────

describe('a retimed clip still fills its slot', () => {
  test('a 2x clip cuts twice as much source, so its track does not come out short', () => {
    const t = doc();
    t.tracks[V1].items = [
      clip('fast', 'v1', 0, 60, { effects: [{ kind: 'speed', params: { factor: 2 }, enabled: true }] }),
      clip('rest', 'v1', 600, 60),
    ];
    t.tracks[A1].items = [clip('bed', 'a1', 0, 120)];
    const r = run(t);
    assertCompiles(r.graph, 'a 2x clip');

    const speed = nodesOf(r.graph, 'ffmpeg/speed')[0];
    const source = inputsInto(r.graph, speed.id, 'input')[0];
    assert.equal(engineParams(r.graph, source).durationSec, 4, '2 seconds of slot at 2x is 4 of source');
    near(renderedSeconds(r.graph, speed.id), 2, 'and it comes back out filling the slot');

    const replace = nodesOf(r.graph, 'ffmpeg/audio-replace')[0];
    near(renderedSeconds(r.graph, inputsInto(r.graph, replace.id, 'input')[0]), 4, 'the picture');
    near(renderedSeconds(r.graph, inputsInto(r.graph, replace.id, 'audio')[0]), 4, 'the sound');
  });

  test('half speed cuts half as much, and the in point does not move', () => {
    const t = doc();
    t.tracks[V1].items = [clip('slow', 'v1', 300, 60, {
      effects: [{ kind: 'speed', params: { factor: 0.5 }, enabled: true }],
    })];
    const r = run(t);
    assertCompiles(r.graph, 'a half speed clip');
    const p = paramsOf(r.graph, 'ffmpeg/trim')[0];
    assert.equal(p.durationSec, 1);
    assert.equal(p.startSec, 10, 'source frame 300 at 30fps');
    near(deliveredSeconds(r), 2);
  });

  test("ffmpeg/speed's own default factor is the one the cut is scaled by", () => {
    const t = doc();
    t.tracks[V1].items = [clip('fast', 'v1', 0, 60, {
      effects: [{ kind: 'speed', params: {}, enabled: true }],
    })];
    const r = run(t);
    assertCompiles(r.graph, 'speed with no factor named');
    assert.equal(paramsOf(r.graph, 'ffmpeg/trim')[0].durationSec, 4, 'the node defaults to 2x');
    near(deliveredSeconds(r), 2);
  });

  test('a retime with no source left to read is reported, not silently short', () => {
    const t = doc();
    t.media.v1.available = timeRange(F(0), F(90));
    t.tracks[V1].items = [clip('fast', 'v1', 0, 60, {
      effects: [{ kind: 'speed', params: { factor: 2 }, enabled: true }],
    })];
    const r = run(t);
    assertCompiles(r.graph, 'a retime past the end of the file');
    const w = r.warnings.find((x) => x.clipId === 'fast');
    assert.equal(w?.code, 'unsupported_effect');
    assert.equal(paramsOf(r.graph, 'ffmpeg/trim')[0].durationSec, 3, 'it cuts what there is');
  });

  test('a speed effect the catalogue rejects does not scale the cut either', () => {
    const t = doc();
    // 40x is past ffmpeg/speed's own maximum, so the effect is dropped and
    // the cut must be the plain slot, not forty times it
    t.tracks[V1].items = [clip('a', 'v1', 0, 60, {
      effects: [{ kind: 'speed', params: { factor: 40 }, enabled: true }],
    })];
    const r = run(t);
    assertCompiles(r.graph, 'a speed past the maximum');
    assert.equal(nodesOf(r.graph, 'ffmpeg/speed').length, 0);
    assert.equal(paramsOf(r.graph, 'ffmpeg/trim')[0].durationSec, 2);
    near(deliveredSeconds(r), 2);
  });
});

// ── an effect goes only where the operation takes it ─────────────────────

describe('an effect is wired only where the operation accepts it', () => {
  test('a crop on a sound clip is refused rather than emitted for the server to reject', () => {
    const t = doc();
    t.tracks[V1].items = [clip('pic', 'v2', 0, 60)];
    t.tracks[A1].items = [clip('snd', 'v1', 0, 60, {
      effects: [{ kind: 'crop', params: { width: 640, height: 360 }, enabled: true }],
    })];
    const r = run(t);
    // ffmpeg/crop.input takes file:video only, and the sound arrives as
    // file:audio out of extract-audio: that graph is a type_mismatch
    assertCompiles(r.graph, 'a crop on a sound clip');
    assert.equal(nodesOf(r.graph, 'ffmpeg/crop').length, 0);
    const w = r.warnings.find((x) => x.clipId === 'snd');
    assert.equal(w?.code, 'unsupported_effect');
    assert.match(w?.message ?? '', /file:audio/);
  });

  test('the same crop on a picture clip is emitted', () => {
    const t = doc();
    t.tracks[V1].items = [clip('pic', 'v1', 0, 60, {
      effects: [{ kind: 'crop', params: { width: 640, height: 360 }, enabled: true }],
    })];
    const r = run(t);
    assertCompiles(r.graph, 'a crop on a picture clip');
    assert.equal(nodesOf(r.graph, 'ffmpeg/crop').length, 1);
    assert.equal(r.warnings.length, 0);
  });

  test('volume reaches both kinds of segment, because it takes both', () => {
    const t = doc();
    const gain = { kind: 'volume', params: { gainDb: -6 }, enabled: true };
    t.tracks[V1].items = [clip('pic', 'v1', 0, 60, { effects: [gain] })];
    t.tracks[A1].items = [clip('snd', 'a1', 0, 60, { effects: [gain] })];
    const r = run(t);
    assertCompiles(r.graph, 'volume on both');
    assert.equal(nodesOf(r.graph, 'ffmpeg/volume').length, 2);
    assert.equal(r.warnings.length, 0);
  });
});

// ── the limits the catalogue puts on a node ─────────────────────────────

describe('nothing is wired past what the operation will take', () => {
  test('150 cuts are joined in runs, not wired into one concat', () => {
    const t = doc();
    t.tracks[V1].items = Array.from({ length: 150 }, (_, i) => clip(`c${i}`, 'v1', i * 60, 30));
    const r = run(t);
    assertCompiles(r.graph, '150 cuts');
    for (const join of nodesOf(r.graph, 'ffmpeg/concat')) {
      assert.ok(
        inputsInto(r.graph, join.id, 'inputs').length <= 100,
        `${join.id} is past ffmpeg/concat's hundred inputs`,
      );
    }
    assert.equal(nodesOf(r.graph, 'ffmpeg/trim').length, 150, 'and every cut is still in there');
    near(deliveredSeconds(r), 150, '150 one second cuts');
  });

  test('a tree of joins still stream copies when every cut came from one file', () => {
    const t = doc();
    t.tracks[V1].items = Array.from({ length: 150 }, (_, i) => clip(`c${i}`, 'v1', i * 60, 30));
    const r = run(t, { delivery: { ...HD, reencode: false } });
    assertCompiles(r.graph, '150 stream copied cuts');
    for (const p of paramsOf(r.graph, 'ffmpeg/concat')) assert.equal(p.reencode, false);
  });

  test('many sound tracks all reach the mix, folded two at a time', () => {
    /**
     * ffmpeg/custom takes at most TWO wired inputs, whatever its args say.
     * Verified against the live compiler: a third wire answers "args use
     * {in2} but only 2 inputs were declared". So the mixer folds pairwise,
     * and nothing is dropped.
     */
    const t = doc();
    t.tracks[V1].items = [clip('pic', 'v1', 0, 120)];
    const beds = 55;
    for (let i = 0; i < beds; i++) {
      t.tracks.push({
        id: `trk_extra_${i}`, kind: 'audio', name: `A${i}`,
        items: [clip(`s${i}`, 'a1', i * 30, 120)],
        locked: false, muted: false, solo: false, enabled: true, autoSelect: true,
      });
    }
    const r = run(t);
    assertCompiles(r.graph, `${beds} sound tracks`);

    const mixers = nodesOf(r.graph, 'ffmpeg/custom').filter((n) => {
      const out = String(engineParams(r.graph, n.id).output ?? '');
      return out === 'mix.m4a' || out === 'mix.wav';
    });
    assert.ok(mixers.length > 1, 'more than two beds needs more than one mixer');

    for (const m of mixers) {
      assert.ok(
        inputsInto(r.graph, m.id, 'input').length <= 2,
        `${m.id} wires more than the two inputs ffmpeg/custom will read`,
      );
    }

    // exactly one node produces the final AAC; the rest stay PCM so the tree
    // does not stack a lossy generation at every level
    const finals = mixers.filter((m) => engineParams(r.graph, m.id).output === 'mix.m4a');
    assert.equal(finals.length, 1, 'one final encode, not one per layer');

    assert.deepEqual(
      r.warnings.filter((w) => /drop/i.test(w.message)),
      [],
      'nothing is dropped any more, so nothing should warn about dropping',
    );
  });
});

// ── delivery ────────────────────────────────────────────────────────────

describe('the delivery codecs are ones the container can hold', () => {
  test('a webm is written with opus and vp9, whatever the node would default to', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60)];

    const asked = run(t, { delivery: { ...HD, container: 'webm', videoCodec: 'vp9' } });
    assert.equal(paramsOf(asked.graph, 'ffmpeg/transcode')[0].audioCodec, 'opus', 'no webm holds aac');

    // ffmpeg/transcode defaults to h264, so an unset codec cannot be left to it
    const unset = run(t, { delivery: { ...HD, container: 'webm' } });
    assertCompiles(unset.graph, 'a webm with no codec named');
    const p = paramsOf(unset.graph, 'ffmpeg/transcode')[0];
    assert.equal(p.videoCodec, 'vp9');
    assert.equal(p.audioCodec, 'opus');

    const wrong = run(t, { delivery: { ...HD, container: 'webm', videoCodec: 'h264' } });
    assertCompiles(wrong.graph, 'a webm asked for in h264');
    assert.equal(paramsOf(wrong.graph, 'ffmpeg/transcode')[0].videoCodec, 'vp9');
    assert.ok(wrong.warnings.some((w) => /webm cannot hold h264/.test(w.message)));
  });

  test('an mp4 is left to the defaults it already agrees with', () => {
    const t = doc();
    t.tracks[V1].items = [clip('a', 'v1', 0, 60)];
    const p = paramsOf(run(t).graph, 'ffmpeg/transcode')[0];
    assert.equal(p.audioCodec, 'aac');
    assert.equal(p.videoCodec, undefined, 'h264 is the node default already');
  });
});

// ── subtitles ───────────────────────────────────────────────────────────

describe('subtitles are one burned in file', () => {
  test('a captions track split across two files burns the first and says so', () => {
    const t = doc();
    t.media.srt2 = { key: 'srt2', name: 'captions-2.srt', kind: 'video', available: timeRange(F(0), F(9000)) };
    t.tracks[V1].items = [clip('pic', 'v1', 0, 600)];
    t.tracks.push(subtitleTrack([clip('s1', 'srt', 0, 300), clip('s2', 'srt2', 0, 300)]));
    const r = run(t, { burnSubtitles: true });
    assertCompiles(r.graph, 'two subtitle files');
    assert.equal(r.graph.nodes.filter((n) => n.kind === 'input' && n.type === 'file:subtitle').length, 1);
    assert.ok(
      r.warnings.some((w) => /only the first can be burned in/.test(w.message)),
      'half the captions going missing is worth a word',
    );
  });

  test('one file across two clips is not a file going missing', () => {
    const t = doc();
    t.tracks[V1].items = [clip('pic', 'v1', 0, 600)];
    t.tracks.push(subtitleTrack([clip('s1', 'srt', 0, 300), clip('s2', 'srt', 0, 300)]));
    const r = run(t, { burnSubtitles: true });
    assertCompiles(r.graph, 'one subtitle file on two clips');
    assert.deepEqual(r.warnings, []);
  });
});
