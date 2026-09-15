/**
 * Timeline to pipeline graph.
 *
 * The server has no renderer, so this file is what turns an edit into a file.
 * It walks the document once, bottom of the stack upwards, and emits one node
 * per piece of real work:
 *
 *   media -> trim -> effects -> concat (per track)
 *         -> compose (tracks over one another)
 *         -> mix + audio-replace (the sound)
 *         -> subtitles -> transcode -> output
 *
 * Three rules run through all of it.
 *
 * **Nothing is emitted that the catalogue has not been asked about.** Every
 * operation goes through `requireNode` and every param set through
 * `validateParams` before it becomes a node, because a graph that fails
 * `preflight()` is worse than no graph: it costs a round trip to find out.
 *
 * **A value is typed by what it is.** A PNG is `file:image` and cannot be fed
 * to `ffmpeg/trim`, which takes `file:video | file:audio`. Typing everything
 * as video makes the graph compile locally and fail on the server.
 *
 * **Seconds only exist at the ffmpeg boundary.** Inside, time is `Frames` at
 * the project rate; `framesToSeconds` is called at the exact moment a param
 * is written and nowhere else.
 */
import {
  getNode, outPort, requireNode, validateParams, wireTarget,
} from '../editor-api/catalogue.ts';
import { GraphBuilder, layout, type Graph } from '../editor-api/graph.ts';
import { placeTrack, timelineDuration } from '../timeline/document.ts';
import {
  ZERO, frames, framesToSeconds, rangeEnd, rangeIntersection, rateEquals, rateFps,
  scaleFrames, timeRange,
  type Frames, type Rate, type TimeRange,
} from '../time/frames.ts';
import type { Clip, MediaRef, Timeline, Track } from '../timeline/types.ts';
import type { CompileOptions, CompileResult, CompileWarning, DeliverySpec } from './types.ts';
import { cacheKey, combineKeys } from './cache.ts';
import { COMPOSITE_EFFECT, TRANSFORM_EFFECT, AUDIO_PAN_EFFECT } from '../inspector/effects.ts';

// ── the numbers the catalogue imposes ───────────────────────────────────

/** `ffmpeg/trim.durationSec` will not go below this. One frame at 30fps is under it. */
const MIN_CUT_SECONDS = 0.04;
/** `ffmpeg/synthetic.durationSec` will not go below this. */
const MIN_GENERATED_SECONDS = 0.1;
/** `ffmpeg/synthetic.durationSec` will not go above this one, either. */
const MAX_GENERATED_SECONDS = 600;
/** `ffmpeg/compose.inputs` and its cell list both stop here. */
const MAX_COMPOSE_INPUTS = 16;
/**
 * How many separate visible runs an upper layer may have before its gaps stop
 * being gated out and go back to being painted black.
 *
 * The gate is one `enable=` expression per run, and an expression is parsed
 * once per frame. Thirty two runs covers every real overlay track; a track
 * chopped finer than that is better served by the cheap opaque path than by
 * an expression the size of the filter graph.
 */
const MAX_GATE_RUNS = 32;
/** `ffmpeg/custom.input` stops here. */
const MAX_CUSTOM_INPUTS = 50;
/** `ffmpeg/concat.inputs` stops here, so a longer track is joined as a tree. */
const MAX_CONCAT_INPUTS = 100;
/** `ffmpeg/synthetic` generates no larger than UHD. */
const MAX_SYNTHETIC = { width: 3840, height: 2160 };
/** Canvas sizes `ffmpeg/compose.size` names, so we only fall back to custom when we must. */
const COMPOSE_PRESETS = new Set(['1920x1080', '1280x720', '1080x1920', '720x1280', '1080x1080', '3840x2160']);

/**
 * Intermediates are always mp4. `ffmpeg/concat` cannot write webm at all, and
 * the container the user asked for is set once, by the final transcode.
 */
const INTERMEDIATE = 'mp4';

/**
 * What `ffmpeg/concat` will actually join, proved by `npm run prove:concat`.
 *
 * The node joins its inputs as they are. It does not scale them and it does
 * not invent a stream that is missing, and `reencode: true` does not rescue
 * either case: it needs every input to carry BOTH a picture and a sound at
 * one geometry, so audio-only inputs, video-only inputs, and two different
 * frame sizes all exit 234, which is ffmpeg's EINVAL. That is the render
 * failure this file shipped: a sound track was joined with `videoCodec:
 * h264` over files with no picture in them, and a picture track was joined
 * from a cut at the source's size beside black generated at the delivery
 * size.
 *
 * So every join is the concat demuxer, and everything handed to one is made
 * to match first. The demuxer takes audio-only and video-only happily; what
 * it will not take is inputs that disagree.
 */
/** The one shape a sound segment has when it is going to be joined. */
const SOUND_SHAPE = {
  codec: 'aac', bitrate: '192k', sampleRate: '48000', channels: '2',
} as const;

/**
 * Encoder identity for the two shapes this file writes on purpose.
 *
 * `Ref.origin` already means "came out of this encoder untouched", and the
 * join uses it to tell segments that already match from ones that have to be
 * made to match. Anything written to one of these shapes can claim it.
 */
const SOUND_ORIGIN = 'shape:aac-192k-48000-2';
const PICTURE_ORIGIN = 'shape:join-picture';

/**
 * What a webm can actually hold.
 *
 * `ffmpeg/transcode` defaults to h264 video and aac audio and its schema takes
 * both alongside `container: webm`, but no webm muxer will write either. The
 * codecs therefore follow the container rather than the node's defaults: the
 * alternative is a render that fails at the very last node, with the whole
 * programme already built and paid for.
 */
const WEBM_VIDEO_CODECS = new Set(['vp9', 'av1']);
const WEBM_AUDIO_CODEC = 'opus';

/** Nothing generated ever runs to nothing, whatever the arithmetic says. */
const ONE_FRAME = frames(1);

/**
 * Seconds of work per second of output, by operation.
 *
 * These are the starting values. `lib/compiler/calibrate.ts` replaces them
 * with what real runs actually cost: an export reports each step's start and
 * finish, and `nodeSeconds` says how much output that step produced, so the
 * two together are a measurement rather than a guess.
 *
 * What is measured is wall time for the step, which includes whatever the
 * worker spent getting to it. That is deliberately the number a person
 * waits for, and it is an over-estimate of pure encode time. Blending rather
 * than replacing keeps one cold start from rewriting the table.
 */
const MEASURED_COST_PER_SECOND: Record<string, number> = {
  'ffmpeg/trim': 0.05,
  'ffmpeg/concat': 0.06,
  'ffmpeg/synthetic': 0.15,
  'ffmpeg/extract-audio': 0.05,
  'ffmpeg/volume': 0.08,
  'ffmpeg/audio-replace': 0.1,
  'ffmpeg/compose': 0.9,
  'ffmpeg/transcode': 0.5,
  'ffmpeg/speed': 0.4,
  'ffmpeg/fade': 0.35,
  'ffmpeg/crop': 0.35,
  'ffmpeg/custom': 0.4,
};

let measuredReencodeMultiplier = 6;

/** Record or update calibrated run cost metrics. */
export function recordCostMetric(opKey: string, costPerSec: number): void {
  if (costPerSec > 0) MEASURED_COST_PER_SECOND[opKey] = costPerSec;
}

export function recordReencodeMultiplier(multiplier: number): void {
  if (multiplier > 0) measuredReencodeMultiplier = multiplier;
}

export function getCostPerSecond(opKey: string): number {
  return MEASURED_COST_PER_SECOND[opKey] ?? 0.3;
}

export function getReencodeMultiplier(): number {
  return measuredReencodeMultiplier;
}

/** What a user's `Effect.kind` means when it is not already an operation key. */
const EFFECT_ALIASES: Record<string, string> = {
  speed: 'ffmpeg/speed',
  retime: 'ffmpeg/speed',
  fade: 'ffmpeg/fade',
  crop: 'ffmpeg/crop',
  volume: 'ffmpeg/volume',
  gain: 'ffmpeg/volume',
};

// ── small helpers ───────────────────────────────────────────────────────

/**
 * Seconds, rounded to the microsecond.
 *
 * Two clips cut identically must hash identically, and `1/24` in binary
 * floating point is not reliably the same string as the sum of some other
 * arithmetic that lands on the same frame. A microsecond is four orders of
 * magnitude finer than a frame, so the rounding cannot move a cut.
 */
const secs = (f: Frames, rate: Rate): number => Math.round(framesToSeconds(f, rate) * 1e6) / 1e6;

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

const clampInt = (n: number, lo: number, hi: number): number =>
  Math.min(Math.max(Math.round(n), lo), hi);

const splitOp = (key: string): [string, string] => {
  const i = key.indexOf('/');
  return [key.slice(0, i), key.slice(i + 1)];
};

const defined = (params: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));

/** `192k` and friends. Anything else is not worth passing to the server. */
const isBitrate = (v: string | undefined): v is string => typeof v === 'string' && /^\d+[kK]$/.test(v);

// ── what a wire carries ─────────────────────────────────────────────────

interface Ref {
  node: string;
  port: string;
  /** What the value actually is, so the next wire can be reasoned about. */
  type: string;
  /** Content key: the media key for a source, the cache key for a computed value. */
  key: string;
  /**
   * Encoder identity. Two values with the same origin came out of the same
   * encoder untouched, which is the only case where `ffmpeg/concat` can use
   * the demuxer instead of re-encoding.
   */
  origin: string;
}

type Warn = (w: CompileWarning) => void;

// ── the builder ─────────────────────────────────────────────────────────

/**
 * Emits nodes, and refuses to emit one twice.
 *
 * Every emission is keyed by content, which does three jobs at once: a key
 * already in `opts.cache` becomes an input carrying the finished file instead
 * of a node, two identical segments inside one compile collapse to one node,
 * and the executor gets a node-to-key map it can use to skip work next time.
 */
class Build {
  readonly graph = new GraphBuilder();
  readonly warnings: CompileWarning[] = [];
  readonly cacheKeys: Record<string, string> = {};
  /** Input nodes standing in for a file the cache already holds. */
  readonly standIns = new Map<string, string>();
  /** Input node id -> the object key it stands for, for the run's body. */
  readonly inputKeys = new Map<string, string>();
  /** Estimated GPU seconds per node, so pruning can take them back off. */
  readonly nodeCost = new Map<string, number>();
  /**
   * How many seconds of output each node produces.
   *
   * The estimate multiplies by this, and so does calibration in reverse: a
   * run says how long a step took, and a cost per second of output needs
   * both halves of that fraction.
   */
  readonly nodeSeconds = new Map<string, number>();

  private readonly byKey = new Map<string, Ref>();
  private readonly sources = new Map<string, Ref>();
  private readonly names = new Set<string>();
  private readonly edges = new Set<string>();
  /** node id -> how to build another node exactly like it. See `wireAll`. */
  private readonly fresh = new Map<string, () => Ref>();
  // a plain field rather than a constructor parameter property, because node
  // strips types without transforming and cannot desugar one
  private readonly cache: ReadonlyMap<string, string>;

  constructor(cache: ReadonlyMap<string, string>) {
    this.cache = cache;
  }

  warn = (w: CompileWarning): void => { this.warnings.push(w); };

  /** An input node for a piece of media, typed by what the media is. */
  source(media: MediaRef, type: string): Ref {
    // one media key can legitimately appear as two types (a file used as
    // picture on one track and as subtitles on another), so the memo is both
    const memo = `${media.key}|${type}`;
    const found = this.sources.get(memo);
    if (found) return found;
    const id = this.graph.input(this.uniqueName(media.name || media.key), type, true);
    this.inputKeys.set(id, media.key);
    const ref: Ref = { node: id, port: 'value', type, key: media.key, origin: `media:${media.key}` };
    this.sources.set(memo, ref);
    return ref;
  }

  /**
   * One operation. Returns the port its result arrives on.
   *
   * `seconds` is how long the result runs, for the estimate only. `origin`
   * defaults to the node itself, which is the safe answer: only a stream copy
   * may claim its input's encoder identity.
   */
  emit(
    opKey: string,
    params: Record<string, unknown>,
    wires: ReadonlyArray<readonly [string, Ref]>,
    seconds: number,
    opts: { type?: string; origin?: string; outPort?: string } = {},
  ): Ref {
    const spec = requireNode(opKey);
    const clean = defined(params);
    const errors = validateParams(opKey, clean, wires.map(([port]) => port));
    if (errors.length) {
      // the compiler chose these params, so this is a bug here and not in the
      // document. Failing loudly beats shipping a graph the server rejects.
      throw new Error(
        `compiler built an invalid ${opKey}: ${errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    }

    const port = opts.outPort ?? 'file';
    const type = opts.type ?? outPort(spec, port)?.type ?? 'any';
    const key = cacheKey(combineKeys(...wires.map(([, r]) => r.key)), opKey, clean);

    const already = this.byKey.get(key);
    if (already) return already; // same source, same op, same params: same file

    const hit = this.cache.get(key);
    if (hit !== undefined) {
      // A finished file enters the graph as an input: there is no literal node
      // kind, and `cacheKeys` tells the executor which key each one carries.
      const makeInput = (): Ref => {
        const id = this.graph.input(this.uniqueName(`cached_${key}`), type, true);
        this.cacheKeys[id] = key;
        this.standIns.set(id, key);
        this.inputKeys.set(id, key);
        const twinable: Ref = { node: id, port: 'value', type, key, origin: `cached:${key}` };
        this.fresh.set(id, makeInput);
        return twinable;
      };
      const ref = makeInput();
      this.byKey.set(key, ref);
      return ref;
    }

    const [engine, operation] = splitOp(opKey);
    const makeNode = (): Ref => {
      const id = this.graph.op(engine, operation, clean);
      this.wireAll(id, wires);
      this.cacheKeys[id] = key;
      if (spec.gpu) this.nodeCost.set(id, cost(opKey, clean) * Math.max(0, seconds));
      this.nodeSeconds.set(id, Math.max(0, seconds));
      const made: Ref = { node: id, port, type, key, origin: opts.origin ?? `node:${id}` };
      this.fresh.set(id, makeNode);
      return made;
    };
    const ref = makeNode();
    this.byKey.set(key, ref);
    return ref;
  }

  /**
   * Draw the wires into a node, giving a repeated source a twin.
   *
   * An edge is identified by its two endpoints, so wiring one node into the
   * same port twice produces two edges with one id and the second is lost.
   * That happens the moment a track repeats a clip: both cuts are the same
   * content, so they are the same node, and the stinger that plays twice
   * would play once. A second node producing the same file keeps the two
   * edges distinct, and both still carry the same cache key so the executor
   * builds the file once regardless.
   */
  private wireAll(nodeId: string, wires: ReadonlyArray<readonly [string, Ref]>): void {
    for (const [port, from] of wires) {
      let src = from;
      if (this.edges.has(`${src.node}.${src.port}->${nodeId}.${port}`)) src = this.twin(src);
      this.edges.add(`${src.node}.${src.port}->${nodeId}.${port}`);
      this.graph.wire(src.node, src.port, nodeId, port);
    }
  }

  /** Another node producing the same file, for the duplicate-edge case above. */
  private twin(ref: Ref): Ref {
    return this.fresh.get(ref.node)?.() ?? ref;
  }

  /** Input names become the request schema, so two may never collide. */
  private uniqueName(raw: string): string {
    const base = (raw.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'source').slice(0, 60);
    let name = base;
    for (let n = 2; this.names.has(name); n++) name = `${base}_${n}`;
    this.names.add(name);
    return name;
  }
}

function cost(opKey: string, params: Record<string, unknown>): number {
  const base = getCostPerSecond(opKey);
  const copies = opKey === 'ffmpeg/trim' || opKey === 'ffmpeg/concat';
  return copies && params.reencode === true ? base * getReencodeMultiplier() : base;
}

// ── flattening a track ──────────────────────────────────────────────────

interface Slot {
  /** Where it lands on the programme, already clipped to the compile range. */
  at: TimeRange;
  /** null for filler: a gap, a disabled clip, or a clip we cannot render. */
  clip: Clip | null;
  /** The part of the source used, shifted for a clip the range cuts into. */
  source: TimeRange;
}

/**
 * A track as an unbroken run of slots covering the whole compiled range.
 *
 * Unbroken is the point. Every track has to come out the same length or the
 * composite and the audio drift apart, so a track that runs out early, starts
 * late or has a hole in it is padded with filler here rather than left for
 * `duration: shortest` to truncate later.
 */
function flattenTrack(track: Track, compiled: TimeRange, warn: Warn): Slot[] {
  const slots: Slot[] = [];
  let cursor: Frames = compiled.start;

  const fillTo = (to: Frames): void => {
    if (to <= cursor) return;
    const last = slots[slots.length - 1];
    if (last && last.clip === null && rangeEnd(last.at) === cursor) {
      // two gaps in a row are one piece of black, not two jobs
      const merged = timeRange(last.at.start, (to - last.at.start) as Frames);
      slots[slots.length - 1] = { at: merged, clip: null, source: merged };
    } else {
      const span = timeRange(cursor, (to - cursor) as Frames);
      slots.push({ at: span, clip: null, source: span });
    }
    cursor = to;
  };

  for (const placed of placeTrack(track)) {
    const item = placed.item;
    if (item.kind === 'transition') {
      // A transition occupies no time and overlaps its neighbours, so honouring
      // one means re-cutting both of them. ffmpeg/transition exists and the
      // compiler does not use it yet, so say so rather than silently pretend.
      warn({
        code: 'unsupported_effect',
        clipId: item.id,
        message: `the ${item.transitionType} transition on "${track.name}" is rendered as a hard cut`,
      });
      continue;
    }
    const visible = rangeIntersection(placed.range, compiled);
    if (!visible) continue;
    fillTo(visible.start);

    if (item.kind === 'clip' && item.enabled) {
      const head = (visible.start - placed.range.start) as Frames;
      slots.push({
        at: visible,
        clip: item,
        source: timeRange((item.sourceRange.start + head) as Frames, visible.duration),
      });
      cursor = rangeEnd(visible);
    } else {
      fillTo(rangeEnd(visible)); // a disabled clip still holds its time open
    }
  }

  fillTo(rangeEnd(compiled));
  return slots;
}

/**
 * The runs of a flattened track that actually carry a picture.
 *
 * Adjacent clips are one run: what matters is where the track has something
 * to show, not where its cuts are. Returned relative to the start of the
 * compiled range, because that is frame zero of the file being built.
 *
 * `null` means the track covers the whole range, which is the common case and
 * the one that needs no gate at all.
 */
function visibleRuns(slots: Slot[], compiled: TimeRange): TimeRange[] | null {
  if (!slots.some((s) => s.clip === null)) return null;
  const runs: TimeRange[] = [];
  for (const slot of slots) {
    if (!slot.clip) continue;
    const start = (slot.at.start - compiled.start) as Frames;
    const last = runs[runs.length - 1];
    if (last && rangeEnd(last) === start) {
      runs[runs.length - 1] = timeRange(last.start, (last.duration + slot.at.duration) as Frames);
    } else {
      runs.push(timeRange(start, slot.at.duration));
    }
  }
  return runs;
}

/**
 * Whether a track holds anything that could have rendered, anywhere.
 *
 * `items.length` is not the question. A track the user placed a clip on and
 * then deleted it from keeps the gap the clip left, and a track of gaps is an
 * empty track: telling someone their empty track is empty, in the sentence
 * reserved for "your clips are outside the range you asked for", sends them
 * looking for a clip that is not there.
 */
const hasLiveClips = (track: Track): boolean =>
  track.items.some((i) => i.kind === 'clip' && i.enabled);

/** Enabled tracks of a kind, honouring solo and (for sound) mute. */
function activeTracks(timeline: Timeline, kind: Track['kind']): Track[] {
  const all = timeline.tracks.filter(
    (t) => t.kind === kind && t.enabled && !(kind === 'audio' && t.muted),
  );
  const solo = all.filter((t) => t.solo);
  return solo.length ? solo : all;
}

// ── segments ────────────────────────────────────────────────────────────

interface Ctx {
  build: Build;
  timeline: Timeline;
  delivery: DeliverySpec;
  /** Media keys already reported for a rate that is not the project's. */
  ratesReported: Set<string>;
  /** How many cuts were made as stream copies, for the one keyframe warning. */
  copiedCuts: number;
  /**
   * Whether a picture segment had to be re-encoded to match its neighbours.
   * Matching drops the segment's own sound, so a timeline with no sound track
   * of its own has to be told where its audio went.
   */
  fittedPicture: boolean;
}

function media(ctx: Ctx, clip: Clip): MediaRef | undefined {
  return ctx.timeline.media[clip.mediaKey];
}

/**
 * Black, for a gap, a disabled clip or a track that runs short.
 *
 * `audio: false` because `ffmpeg/synthetic`'s only tone is a 440 Hz sine, and
 * a beep over a gap is worse than the silence.
 *
 * Filler is the one thing here whose length is not negotiable: every track is
 * padded to the compiled length, so a gap that comes out longer or shorter
 * than it was asked for slides an entire track against every other one.
 * `ffmpeg/synthetic` generates between 0.1s and 600s and refuses everything
 * else, and a twenty minute programme with a three second title over it wants
 * nineteen minutes of filler on the title's track. So outside that window the
 * same black comes from lavfi through `ffmpeg/custom`, which has no limit at
 * either end.
 */
function black(ctx: Ctx, duration: Frames): Ref {
  const rate = ctx.timeline.rate;
  const wanted = secs(duration, rate);
  if (wanted > MAX_GENERATED_SECONDS || (wanted > 0 && wanted < MIN_GENERATED_SECONDS)) {
    return lavfiBlack(ctx, wanted);
  }
  // a zero length gap is an empty timeline, already reported as one, and a
  // moment of black is the only thing that can be delivered for it
  const durationSec = Math.max(MIN_GENERATED_SECONDS, wanted);
  return ctx.build.emit('ffmpeg/synthetic', {
    pattern: 'color',
    color: 'black',
    width: clampInt(ctx.delivery.width, 16, MAX_SYNTHETIC.width),
    height: clampInt(ctx.delivery.height, 16, MAX_SYNTHETIC.height),
    fps: round6(rateFps(rate)),
    durationSec,
    audio: false,
    container: INTERMEDIATE,
    videoCodec: 'h264',
  }, [], durationSec);
}

/** The same black, for a length `ffmpeg/synthetic` will not take. */
function lavfiBlack(ctx: Ctx, durationSec: number): Ref {
  const rate = ctx.timeline.rate;
  // lavfi has no size ceiling either, so this is the delivery size rather
  // than synthetic's UHD cap
  const w = clampInt(ctx.delivery.width, 16, 7680);
  const h = clampInt(ctx.delivery.height, 16, 4320);
  return ctx.build.emit('ffmpeg/custom', {
    args: [
      '-f', 'lavfi',
      '-t', String(durationSec),
      '-i', `color=c=black:s=${w}x${h}:r=${round6(rateFps(rate))}`,
      '-c:v', '{enc:h264}',
      '-pix_fmt', 'yuv420p',
      '{out}',
    ],
    output: 'black.mp4',
  }, [], durationSec, { type: 'file:video' });
}

/**
 * Silence, for a gap on an audio track.
 *
 * There is no "generate silence" operation, so this is `ffmpeg/custom` with
 * anullsrc, which is what the escape hatch is for. `ffmpeg/custom` imposes no
 * minimum duration, so a one frame hole is one frame of silence: rounding it
 * up to synthetic's floor would make the sound run longer than the picture it
 * sits under, which is the drift the padding exists to prevent.
 */
function silence(ctx: Ctx, duration: Frames): Ref {
  const rate = ctx.timeline.rate;
  const durationSec = Math.max(secs(ONE_FRAME, rate), secs(duration, rate));
  return ctx.build.emit('ffmpeg/custom', {
    args: [
      '-f', 'lavfi',
      '-t', String(durationSec),
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-c:a', 'aac', '-b:a', '192k',
      '{out}',
    ],
    output: 'silence.m4a',
    // aac, 192k, 48000, stereo: written to match what extract-audio writes,
    // so a gap and a clip can be joined without re-encoding either
  }, [], durationSec, { type: 'file:audio', origin: SOUND_ORIGIN });
}

/**
 * A still held for the clip's duration.
 *
 * An image is `file:image`, which `ffmpeg/trim` does not accept, so there is
 * nothing to trim: the picture is looped for as long as the clip runs.
 */
function still(ctx: Ctx, image: Ref, duration: Frames): Ref {
  const rate = ctx.timeline.rate;
  // as in silence(): ffmpeg/custom has no floor, and holding the picture for
  // longer than the slot asked for pushes everything after it out of sync
  const durationSec = Math.max(secs(ONE_FRAME, rate), secs(duration, rate));
  const w = clampInt(ctx.delivery.width, 16, 7680);
  const h = clampInt(ctx.delivery.height, 16, 4320);
  return ctx.build.emit('ffmpeg/custom', {
    args: [
      '-loop', '1',
      '-i', '{in0}',
      '-t', String(durationSec),
      '-r', String(round6(rateFps(rate))),
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
      '-c:v', '{enc:h264}',
      '{out}',
    ],
    output: 'still.mp4',
  }, [['input', image]], durationSec, { type: 'file:video' });
}

/** One cut. This is the node the cache exists for. */
function cut(ctx: Ctx, src: Ref, clip: Clip, source: TimeRange): Ref {
  const rate = ctx.timeline.rate;
  const startSec = Math.max(0, secs(source.start, rate));
  const wanted = secs(source.duration, rate);
  const durationSec = Math.max(MIN_CUT_SECONDS, wanted);
  if (durationSec > wanted) {
    // not `rate_mismatch`: that code means the media's rate and the project's
    // disagree, and a consumer filtering on it would say something untrue
    ctx.build.warn({
      code: 'unsupported_effect',
      clipId: clip.id,
      message: `${source.duration} frame(s) at ${round6(rateFps(rate))}fps is ${wanted}s, under ffmpeg/trim's ${MIN_CUT_SECONDS}s floor, so the cut is lengthened to ${durationSec}s`,
    });
  }
  const reencode = ctx.delivery.reencode;
  if (!reencode) ctx.copiedCuts += 1;
  return ctx.build.emit('ffmpeg/trim', {
    startSec,
    durationSec,
    reencode,
    container: INTERMEDIATE,
  }, [['input', src]], durationSec, {
    type: src.type === 'file:audio' ? 'file:audio' : 'file:video',
    // a stream copy keeps the source's codec, which is what lets a whole
    // track of cuts from one file be joined by the concat demuxer later
    origin: reencode ? undefined : src.origin,
  });
}

/** `ffmpeg/speed.factor`'s own default, for an effect that names no factor. */
const SPEED_FACTOR_DEFAULT =
  Number(requireNode('ffmpeg/speed').params.properties?.factor?.default ?? 1);

/** An effect resolved against the catalogue: the operation, and what to pass it. */
interface PlannedEffect {
  opKey: string;
  params: Record<string, unknown>;
}

/**
 * The operation an `Effect.kind` names, or why nothing fits.
 *
 * Anything in the catalogue that takes one `input` and returns one `file` can
 * sit in a segment chain, so `ffmpeg/denoise` and `ffmpeg/rotate` work without
 * being listed anywhere. Operations shaped differently do not, and saying so
 * is better than guessing at a translation.
 *
 * `type` is load bearing rather than decorative. `ffmpeg/crop.input` takes
 * `file:video` and nothing else, so a crop on a sound clip is not an effect
 * that quietly does nothing: it is a graph the server rejects outright with
 * `type_mismatch`, after the round trip.
 */
function effectOp(kind: string, type: string): { op: string } | { skip: string } {
  const key = EFFECT_ALIASES[kind] ?? kind;
  const spec = getNode(key);
  const target = spec ? wireTarget(spec, 'input') : null;
  if (!spec || !target || target.list || !outPort(spec, 'file')) {
    return { skip: `no operation matches the effect "${kind}", so it is skipped` };
  }
  // an empty accepts list is the catalogue's way of saying "anything"
  if (target.accepts.length && !target.accepts.includes(type)) {
    return {
      skip: `${key} takes ${target.accepts.join(' or ')} and this segment is ${type}, so "${kind}" is skipped`,
    };
  }
  return { op: key };
}

/**
 * Resolve a clip's effects once, saying what could not be kept and why.
 *
 * This runs before the cut rather than during it, because `ffmpeg/speed`
 * decides how much source the cut has to take. Resolving twice, once to
 * measure and once to emit, is a pair that eventually disagrees: the cut
 * would be scaled for an effect that then gets dropped as invalid.
 */
function planEffects(ctx: Ctx, clip: Clip, type: string): PlannedEffect[] {
  const plan: PlannedEffect[] = [];
  for (const fx of clip.effects) {
    if (!fx.enabled) continue;
    // visual markers and compositing are handled during track layering
    if (fx.kind === COMPOSITE_EFFECT || fx.kind === TRANSFORM_EFFECT || fx.kind === AUDIO_PAN_EFFECT) continue;
    const resolved = effectOp(fx.kind, type);
    if ('skip' in resolved) {
      ctx.build.warn({ code: 'unsupported_effect', clipId: clip.id, message: resolved.skip });
      continue;
    }
    const opKey = resolved.op;

    const props = requireNode(opKey).params.properties ?? {};
    const params: Record<string, unknown> = {};
    const ignored: string[] = [];
    for (const [name, value] of Object.entries(fx.params)) {
      if (value === undefined) continue;
      if (name === 'input' || name === 'inputs') continue; // the wire supplies it
      if (name in props) params[name] = value;
      else ignored.push(name);
    }

    const errors = validateParams(opKey, params, ['input']);
    if (errors.length) {
      ctx.build.warn({
        code: 'unsupported_effect',
        clipId: clip.id,
        message: `${fx.kind} is skipped: ${errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      });
      continue;
    }
    if (ignored.length) {
      ctx.build.warn({
        code: 'unsupported_effect',
        clipId: clip.id,
        message: `${opKey} has no param ${ignored.map((n) => `"${n}"`).join(', ')}, so it was dropped`,
      });
    }
    plan.push({ opKey, params });
  }
  return plan;
}

/**
 * How much source a plan eats per frame of programme.
 *
 * `ffmpeg/speed` is the one operation in a chain that changes duration, and a
 * segment that changes length breaks the promise flattenTrack exists to keep.
 * A 2x clip emitted from its own cut comes out half its slot, which drags
 * every later segment on that track earlier and slides the whole track
 * against the sound. Filling n frames of programme at factor f means cutting
 * n * f frames of source, which is the derivation the rest of the file
 * already uses: how much source to take follows from how much programme time
 * the slot covers, not from the clip's own `sourceRange.duration`.
 */
function retimeFactor(plan: PlannedEffect[]): number {
  let factor = 1;
  for (const step of plan) {
    if (step.opKey !== 'ffmpeg/speed') continue;
    const f = typeof step.params.factor === 'number' ? step.params.factor : SPEED_FACTOR_DEFAULT;
    if (f > 0) factor *= f;
  }
  return factor;
}

/** Frames of source for `d` frames of programme at `factor`, never fewer than one. */
const retimed = (d: Frames, factor: number): Frames => Math.max(1, scaleFrames(d, factor)) as Frames;

/**
 * The part of the source a slot needs, with any retime counted in.
 *
 * Speeding a clip up is the one thing that can ask for source the media does
 * not have, because it is the one thing that reads past the clip's own out
 * point. There is nothing to cut there, so the cut stops at the end of the
 * file and the caller is told the slot will not be filled.
 */
function retimedSource(ctx: Ctx, clip: Clip, ref: MediaRef, source: TimeRange, factor: number): TimeRange {
  if (factor === 1) return source;
  const wanted = retimed(source.duration, factor);
  const room = (rangeEnd(ref.available) - source.start) as Frames;
  if (wanted > room) {
    ctx.build.warn({
      code: 'unsupported_effect',
      clipId: clip.id,
      message: `"${clip.name}" plays at ${round6(factor)}x, which needs ${wanted} frames of "${ref.name}" and only ${Math.max(0, room)} are left, so it ends before its slot does`,
    });
    return timeRange(source.start, Math.max(1, room) as Frames);
  }
  return timeRange(source.start, wanted);
}

/** The clip's effects, chained in the order the user put them in. */
function applyEffects(ctx: Ctx, start: Ref, plan: PlannedEffect[], seconds: number): Ref {
  let current = start;
  for (const step of plan) {
    current = ctx.build.emit(step.opKey, step.params, [['input', current]], seconds, {
      type: current.type,
    });
  }
  return current;
}

/**
 * A finished segment, and the number of frames it is supposed to run for.
 *
 * The length travels with the segment because the join is the last place that
 * can still fix it, and by then the slot it came from is long gone. A segment
 * that comes back from its encoder a frame long slides every cut after it.
 */
interface Segment { ref: Ref; duration: Frames }

/** One track's slots, each turned into a finished segment. */
function videoSegments(ctx: Ctx, track: Track, slots: Slot[]): Segment[] {
  return slots.map((slot) => ({ ref: videoSegment(ctx, track, slot), duration: slot.at.duration }));
}

function videoSegment(ctx: Ctx, track: Track, slot: Slot): Ref {
  return ((): Ref => {
    const clip = slot.clip;
    if (!clip) return black(ctx, slot.at.duration);

    const ref = media(ctx, clip);
    if (!ref) {
      ctx.build.warn({
        code: 'no_media',
        clipId: clip.id,
        message: `"${clip.name}" points at media "${clip.mediaKey}", which the document does not carry, so it is black`,
      });
      return black(ctx, slot.at.duration);
    }
    if (ref.kind === 'audio') {
      ctx.build.warn({
        code: 'no_media',
        clipId: clip.id,
        message: `"${clip.name}" on picture track "${track.name}" is an audio file and has no picture, so it is black`,
      });
      return black(ctx, slot.at.duration);
    }
    reportRate(ctx, ref);

    const seconds = secs(slot.at.duration, ctx.timeline.rate);
    const plan = planEffects(ctx, clip, 'file:video');
    const factor = retimeFactor(plan);
    const source = ctx.build.source(ref, ref.kind === 'image' ? 'file:image' : 'file:video');
    const segment = ref.kind === 'image'
      // a still has no source range to stretch, so a retime instead holds the
      // picture for longer and plays it back faster, which comes to the same
      ? still(ctx, source, retimed(slot.at.duration, factor))
      : cut(ctx, source, clip, retimedSource(ctx, clip, ref, slot.source, factor));
    return applyEffects(ctx, segment, plan, seconds);
  })();
}

function audioSegments(ctx: Ctx, track: Track, slots: Slot[]): Segment[] {
  return slots.map((slot) => ({ ref: audioSegment(ctx, track, slot), duration: slot.at.duration }));
}

function audioSegment(ctx: Ctx, track: Track, slot: Slot): Ref {
  return ((): Ref => {
    const clip = slot.clip;
    if (!clip) return silence(ctx, slot.at.duration);

    const ref = media(ctx, clip);
    if (!ref || ref.kind === 'image') {
      ctx.build.warn({
        code: 'no_media',
        clipId: clip.id,
        message: ref
          ? `"${clip.name}" on sound track "${track.name}" is an image and has no sound, so it is silent`
          : `"${clip.name}" points at media "${clip.mediaKey}", which the document does not carry, so it is silent`,
      });
      return silence(ctx, slot.at.duration);
    }
    reportRate(ctx, ref);

    const seconds = secs(slot.at.duration, ctx.timeline.rate);
    // the effects land after the extract below, so they are planned against
    // the sound they will actually be handed and not against the file's kind
    const plan = planEffects(ctx, clip, 'file:audio');
    const source = ctx.build.source(ref, ref.kind === 'audio' ? 'file:audio' : 'file:video');
    const cutRange = retimedSource(ctx, clip, ref, slot.source, retimeFactor(plan));
    let segment = cut(ctx, source, clip, cutRange);
    if (ref.kind === 'video') {
      // the picture is dead weight in the mix, and dropping it here means the
      // mix node handles one kind of file rather than two
      segment = ctx.build.emit('ffmpeg/extract-audio', { ...SOUND_SHAPE },
        [['input', segment]], secs(cutRange.duration, ctx.timeline.rate),
        { type: 'file:audio', origin: SOUND_ORIGIN });
    }
    return applyEffects(ctx, segment, plan, seconds);
  })();
}

function reportRate(ctx: Ctx, ref: MediaRef): void {
  if (!ref.rate || ctx.ratesReported.has(ref.key) || rateEquals(ref.rate, ctx.timeline.rate)) return;
  ctx.ratesReported.add(ref.key);
  ctx.build.warn({
    code: 'rate_mismatch',
    message: `"${ref.name}" runs at ${round6(rateFps(ref.rate))}fps and the timeline at ${round6(rateFps(ctx.timeline.rate))}fps, so its cuts are placed to the nearest project frame`,
  });
}

/**
 * One segment, made to match every other segment of its track.
 *
 * This is the step the render was missing. `ffmpeg/concat` will not scale a
 * picture up to meet another one and will not put a silent track on a file
 * that has none, so the cut at the source's own size and the black generated
 * at the delivery size have to be brought to one shape here or the join is
 * refused outright. See the note above `SOUND_SHAPE`.
 *
 * Sound comes out as the aac every other sound segment is written in.
 *
 * Picture comes out at the delivery geometry and the project rate, and with
 * no sound at all: a track's sound is built from the audio tracks and laid
 * back on at the end by `ffmpeg/audio-replace`, which is also what the
 * program monitor does, so the file and the monitor agree.
 */
function matchForJoin(ctx: Ctx, segment: Segment): Ref {
  const seconds = secs(segment.duration, ctx.timeline.rate);
  if (segment.ref.type === 'file:audio') {
    return ctx.build.emit('ffmpeg/extract-audio', { ...SOUND_SHAPE },
      [['input', segment.ref]], seconds, { type: 'file:audio', origin: SOUND_ORIGIN });
  }
  const w = clampInt(ctx.delivery.width, 16, 7680);
  const h = clampInt(ctx.delivery.height, 16, 4320);
  const fps = round6(rateFps(ctx.timeline.rate));
  ctx.fittedPicture = true;
  return ctx.build.emit('ffmpeg/custom', {
    args: [
      '-i', '{in0}',
      '-filter_complex',
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,`
      + `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},`
      // an encoder that hands back one frame more or less than it was asked
      // for slides every cut after this one, so the segment is held out to
      // its length and then cut to it exactly by -frames:v below
      + `tpad=stop_mode=clone:stop_duration=1,format=yuv420p[v]`,
      '-map', '[v]', '-an',
      '-frames:v', String(Math.max(1, Math.round(segment.duration))),
      '-c:v', '{enc:h264}', '-pix_fmt', 'yuv420p',
      // the demuxer joins on timestamps, so the segments share a timebase
      '-video_track_timescale', String(Math.round(fps * 1000)),
      '{out}',
    ],
    output: `fit.${INTERMEDIATE}`,
  }, [['input', segment.ref]], seconds, { type: 'file:video', origin: PICTURE_ORIGIN });
}

/**
 * Join a track's segments.
 *
 * Always the concat demuxer, because it is the only path that takes a sound
 * track at all and the only one that takes a picture with no sound on it.
 * Its price is that every input must already agree, so anything that does not
 * is sent through `matchForJoin` first. Segments that came out of one encoder
 * untouched already agree, which is what `origin` is for: a track of stream
 * copies from one file still joins without re-encoding a frame.
 */
function joinTrack(ctx: Ctx, segments: Segment[], seconds: number): Ref {
  if (segments.length === 1) return segments[0].ref;
  if (segments.length > MAX_CONCAT_INPUTS) {
    // `ffmpeg/concat.inputs` stops at a hundred and a real cut sequence has
    // more segments than that, so the join is a tree: each run of a hundred
    // becomes one file and the files are joined in turn. A matched run keeps
    // its inputs' encoder identity, so the next join up sees one origin again
    // and does not match a second time.
    const runs: Segment[] = [];
    for (let i = 0; i < segments.length; i += MAX_CONCAT_INPUTS) {
      const run = segments.slice(i, i + MAX_CONCAT_INPUTS);
      const length = run.reduce((n, s) => n + s.duration, 0) as Frames;
      runs.push({ ref: joinTrack(ctx, run, secs(length, ctx.timeline.rate)), duration: length });
    }
    return joinTrack(ctx, runs, seconds);
  }
  const uniform = new Set(segments.map((s) => s.ref.origin)).size === 1;
  const inputs = uniform ? segments.map((s) => s.ref) : segments.map((s) => matchForJoin(ctx, s));
  return ctx.build.emit('ffmpeg/concat', {
    reencode: false,
    container: INTERMEDIATE,
  }, inputs.map((s) => ['inputs', s] as const), seconds, {
    type: inputs[0].type,
    origin: inputs[0].origin,
  });
}

// ── compositing, sound and delivery ─────────────────────────────────────

/** Lay the picture tracks over one another, bottom of the stack first. */
/**
 * How a picture track sits over the one below it.
 *
 * The setting lives on clips and the composite is per track, so a track whose
 * clips disagree cannot be honoured exactly. The first non-default one wins
 * and the disagreement is said out loud, which beats silently picking one.
 */
export interface CompositeIntent { mode: string; opacity: number }

const DEFAULT_INTENT: CompositeIntent = { mode: 'normal', opacity: 1 };

const isDefaultIntent = (i: CompositeIntent) =>
  i.mode === 'normal' && Math.abs(i.opacity - 1) < 1e-6;

function trackIntent(ctx: Ctx, track: Track): CompositeIntent {
  const found: CompositeIntent[] = [];
  for (const item of track.items) {
    if (item.kind !== 'clip') continue;
    for (const fx of item.effects) {
      if (!fx.enabled || fx.kind !== COMPOSITE_EFFECT) continue;
      const mode = BLEND_MODES_ALLOWED.has(String(fx.params.mode))
        ? String(fx.params.mode)
        : 'normal';
      const raw = Number(fx.params.opacity);
      found.push({
        mode,
        opacity: Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1,
      });
    }
  }
  if (!found.length) return DEFAULT_INTENT;
  const first = found[0];
  const differs = found.some((i) => i.mode !== first.mode || Math.abs(i.opacity - first.opacity) > 1e-6);
  if (differs) {
    ctx.build.warn({
      code: 'unsupported_effect',
      message: `the clips on "${track.name}" ask for different blends, and a track composites as one layer, so ${first.mode} at ${Math.round(first.opacity * 100)}% is used for all of them`,
    });
  }
  return first;
}

/** The modes ffmpeg's `blend` filter takes that the picker offers. */
const BLEND_MODES_ALLOWED = new Set(['normal', 'addition', 'overlay', 'screen', 'multiply']);

/**
 * Where a track's picture sits in the frame.
 *
 * The same shape as `CompositeIntent`, and per track for the same reason: the
 * values are set on clips and a layer is composited once. Per clip would mean
 * a moved segment carrying alpha through the join, and a joined mp4 has no
 * alpha to carry it in.
 *
 * Rotation is deliberately not here. `paramsToEffects` writes it twice, once
 * into this effect and once as an `ffmpeg/rotate` that `planEffects` puts on
 * the segment itself, and reading it here as well would turn 30 degrees into
 * 60.
 */
export interface TransformIntent { zoom: number; posX: number; posY: number }

const DEFAULT_TRANSFORM: TransformIntent = { zoom: 1, posX: 0, posY: 0 };

const isDefaultTransform = (t: TransformIntent) =>
  Math.abs(t.zoom - 1) < 1e-6 && Math.abs(t.posX) < 1e-6 && Math.abs(t.posY) < 1e-6;

/** A zoom at or below this is not a picture, it is a rounding error. */
const MIN_ZOOM = 0.01;

/** The inspector's Position unit: a fifth of a percent of the frame. */
const POSITION_UNIT = 0.002;

function trackTransform(ctx: Ctx, track: Track): TransformIntent {
  const found: TransformIntent[] = [];
  for (const item of track.items) {
    if (item.kind !== 'clip') continue;
    for (const fx of item.effects) {
      if (!fx.enabled || fx.kind !== TRANSFORM_EFFECT) continue;
      const zoom = Number(fx.params.zoom);
      const posX = Number(fx.params.posX);
      const posY = Number(fx.params.posY);
      found.push({
        zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1,
        posX: Number.isFinite(posX) ? posX : 0,
        posY: Number.isFinite(posY) ? posY : 0,
      });
    }
  }
  // an identity transform is not a vote: the inspector only writes the effect
  // when something moved, and one written by hand should not outrank a real one
  const real = found.filter((t) => !isDefaultTransform(t));
  if (!real.length) return DEFAULT_TRANSFORM;
  const first = real[0];
  const differs = real.some((t) => Math.abs(t.zoom - first.zoom) > 1e-6
    || Math.abs(t.posX - first.posX) > 1e-6 || Math.abs(t.posY - first.posY) > 1e-6);
  if (differs) {
    ctx.build.warn({
      code: 'unsupported_effect',
      message: `the clips on "${track.name}" are placed differently and a track is placed as one layer, so a zoom of ${round6(first.zoom)} at ${Math.round(first.posX)}, ${Math.round(first.posY)} is used for all of them`,
    });
  }
  return first;
}

/** How big a moved picture is drawn, and where in the frame it goes. */
interface Placement {
  /** The scale chain that brings the picture to its drawn size. */
  fit: string;
  x: string;
  y: string;
}

/** `(W-w)/2` shifted by a signed number of pixels, without writing `+-38`. */
const offsetExpr = (span: string, by: number): string =>
  by === 0 ? `(${span})/2` : `(${span})/2${by > 0 ? '+' : '-'}${Math.abs(by)}`;

/**
 * A transform as ffmpeg sees it.
 *
 * This mirrors `layerStyle` in components/viewer/Layers.tsx deliberately and
 * exactly, because a preview that does not match the render is worse than no
 * preview at all. What the viewer does to a layer:
 *
 *   object-fit: contain      the picture is fitted inside the whole frame
 *   scale(z) about centre    so the fitted box comes out z times as big
 *   translate(x%, y%)        of the ELEMENT box, which is the frame, and the
 *                            inspector's unit is a fifth of a percent
 *
 * Fitting inside the frame and then scaling by z is the same picture as
 * fitting inside a box z times the frame, which is one scale rather than a
 * scale and a pad, and leaves no black border to lay over the track below.
 * The offset is written against overlay's own `W,H,w,h` because how wide the
 * fitted picture came out depends on the source's shape, and at the point the
 * filter is written only ffmpeg knows it.
 */
function placement(ctx: Ctx, t: TransformIntent, pixelFormat: string): Placement {
  const w = clampInt(ctx.delivery.width, 16, 7680);
  const h = clampInt(ctx.delivery.height, 16, 4320);
  const fps = round6(rateFps(ctx.timeline.rate));
  // no larger than the biggest picture the delivery clamp itself allows, so a
  // zoom of 40 is a big picture and not a scale the filter refuses
  const zoom = Math.min(Math.max(t.zoom, MIN_ZOOM), 7680 / w, 4320 / h);
  if (Math.abs(zoom - t.zoom) > 1e-6) {
    ctx.build.warn({
      code: 'unsupported_effect',
      message: `a zoom of ${round6(t.zoom)} cannot be drawn at ${w}x${h}, so ${round6(zoom)} is used instead`,
    });
  }
  return {
    // even dimensions: yuv420p has half as many chroma samples as luma and an
    // odd size leaves the last column of one of them undefined
    fit: `scale=${Math.max(2, Math.round(w * zoom))}:${Math.max(2, Math.round(h * zoom))}`
      + `:force_original_aspect_ratio=decrease:force_divisible_by=2,`
      + `setsar=1,fps=${fps},format=${pixelFormat}`,
    x: offsetExpr('W-w', Math.round(t.posX * POSITION_UNIT * w)),
    y: offsetExpr('H-h', Math.round(t.posY * POSITION_UNIT * h)),
  };
}

/**
 * A transform on the bottom layer, which has nothing underneath it.
 *
 * Every other layer is placed as it is laid over the one below, because where
 * its picture is not drawn the track below has to show through. The bottom
 * layer has no track below: what it does not cover is black, which is what an
 * uncovered frame already is, so it can be placed on its own and the layering
 * below it left alone.
 */
function transformLayer(ctx: Ctx, ref: Ref, xf: TransformIntent, seconds: number): Ref {
  const w = clampInt(ctx.delivery.width, 16, 7680);
  const h = clampInt(ctx.delivery.height, 16, 4320);
  const fps = round6(rateFps(ctx.timeline.rate));
  const place = placement(ctx, xf, 'yuv420p');
  return ctx.build.emit('ffmpeg/custom', {
    args: [
      '-i', '{in0}',
      '-filter_complex',
      `color=c=black:s=${w}x${h}:r=${fps}[bg];[0:v]${place.fit}[top];`
      + `[bg][top]overlay=x=${place.x}:y=${place.y}:shortest=1,format=yuv420p[v]`,
      '-map', '[v]',
      // with no sound track to replace it, this layer's own sound is the
      // programme's, and a re-encode that drops it loses the whole mix
      '-map', '0:a?',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'copy',
      '{out}',
    ],
    output: `placed.${INTERMEDIATE}`,
    tier: 'cpu',
  }, [['input', ref]], seconds, { type: 'file:video' });
}

/**
 * When an upper layer is only on screen for part of the programme.
 *
 * A track's gaps are black in the strip that was joined for it, because a
 * joined mp4 has no alpha to be transparent with. Painting that black over
 * the track below is the wrong answer and the one the compiler used to give.
 * The fix is not to make the black transparent, it is not to draw the layer
 * at all where it has nothing: `overlay` is gated by `enable=`, and a gated
 * overlay passes its base through untouched.
 *
 * Frames are sampled at `n/fps`, so a run covering frames `[s, e)` is on
 * screen for `t` in `[(s - 0.5)/fps, (e - 0.5)/fps]`. Half a frame either side
 * puts the boundary between two samples instead of on one, where float
 * comparison decides whether a cut lands a frame early.
 */
function gateExpression(runs: TimeRange[], rate: Rate): string {
  const fps = rateFps(rate);
  return runs
    .map((r) => {
      const from = round6(Math.max(0, (r.start - 0.5) / fps));
      const to = round6((rangeEnd(r) - 0.5) / fps);
      return `between(t,${from},${to})`;
    })
    // a sum, not an or: the expression evaluator has no `||`, and any
    // non-zero result enables the filter, which is exactly an or
    .join('+');
}

/**
 * Lay a moved or scaled picture over the one below it.
 *
 * Its own function rather than a fourth case in `layerOver`, because the
 * shape of the graph is different: the top is no longer the size of the
 * frame, so it is drawn where it belongs instead of at 0,0, and there is no
 * padding around it to lay black over the track below.
 *
 * `normal` at any opacity is an overlay at that alpha, which is the same
 * arithmetic `blend all_opacity` does, in one filter instead of six.
 *
 * A real blend mode needs the whole frame on both sides and the top no longer
 * covers it, so the top is drawn onto a transparent canvas first and its
 * alpha kept as a mask. The blend is then put back through that mask: outside
 * the picture the blend has nothing to say, and what it would say is wrong.
 * `multiply` against the black of an empty canvas is black, which is the
 * exact bug `enable=` was added to fix, one layer further in.
 */
function placedFilter(
  ctx: Ctx, fit: string, intent: CompositeIntent, xf: TransformIntent, gate: string,
): string {
  const opaque = isDefaultIntent(intent);
  const place = placement(ctx, xf, opaque ? 'yuv420p' : 'yuva420p');
  if (intent.mode === 'normal') {
    const alpha = opaque ? '' : `,colorchannelmixer=aa=${round6(intent.opacity)}`;
    return `[0:v]${fit}[base];[1:v]${place.fit}${alpha}[top];`
      + `[base][top]overlay=x=${place.x}:y=${place.y}${gate},format=yuv420p[v]`;
  }
  const w = clampInt(ctx.delivery.width, 16, 7680);
  const h = clampInt(ctx.delivery.height, 16, 4320);
  const fps = round6(rateFps(ctx.timeline.rate));
  return `color=c=black@0:s=${w}x${h}:r=${fps},format=yuva420p[canvas];`
    + `[1:v]${place.fit}[top];`
    + `[canvas][top]overlay=x=${place.x}:y=${place.y}:shortest=1[full];`
    + `[full]split[shown][alpha];[alpha]alphaextract[mask];`
    + `[0:v]${fit},split[keep][under];`
    + `[under][shown]blend=all_mode=${intent.mode}:all_opacity=${intent.opacity}[mixed];`
    + `[mixed][mask]alphamerge[masked];`
    + `[keep][masked]overlay=x=0:y=0${gate},format=yuv420p[v]`;
}

/**
 * Hold the last frame for a second before cutting to an exact count.
 *
 * `blend` and `overlay` decide their own output length from how their inputs
 * pair up, and measured against a real render the blend of two 144 frame
 * layers came back with 143: one frame short, silently, with the container
 * still claiming six seconds. `-frames:v` alone cannot fix that, because it
 * is a cap and not a floor.
 *
 * So the same trick `matchForJoin` uses: clone the last frame past the end,
 * then cut to the exact count. A second is far more than any rounding needs
 * and costs nothing, because the cut happens before it is encoded.
 */
export const HOLD_LAST = 'tpad=stop_mode=clone:stop_duration=1';

/**
 * Lay one picture over another, with a blend mode, an opacity, and a gate.
 *
 * `ffmpeg/compose` cannot do any of this: it arranges cells, has no alpha, no
 * modes and no notion of time. `ffmpeg/custom` takes two wired inputs, which
 * is exactly what laying one picture over another needs, and ffmpeg's `blend`
 * filter does every mode the picker offers. Verified on the live API with
 * screen, multiply and normal at 50%.
 *
 * Both layers are scaled and padded to the delivery size first, because
 * `blend` and `overlay` both refuse inputs of different sizes, and `fps` is
 * forced for the same reason: they pair frames by index, so two different
 * rates drift apart.
 *
 * A blend that is also gated blends against a copy of the base and then lays
 * the result over the original, rather than trusting `blend` to honour a
 * timeline of its own. One filter is responsible for the gate, and it is the
 * one whose documentation is an `enable=` example.
 */
function layerOver(
  ctx: Ctx, base: Ref, top: Ref, intent: CompositeIntent, xf: TransformIntent,
  runs: TimeRange[] | null, seconds: number, durationFrames: number, keepSound: boolean,
): Ref {
  const w = clampInt(ctx.delivery.width, 16, 7680);
  const h = clampInt(ctx.delivery.height, 16, 4320);
  const fps = round6(rateFps(ctx.timeline.rate));
  const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease,`
    + `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=${fps},format=yuv420p`;
  // quoted, because the filter graph is split on commas and `between(t,a,b)`
  // is full of them
  const gate = runs ? `:enable='${gateExpression(runs, ctx.timeline.rate)}'` : '';
  const blend = `blend=all_mode=${intent.mode}:all_opacity=${intent.opacity}`;

  const filter = ((): string => {
    if (!isDefaultTransform(xf)) return placedFilter(ctx, fit, intent, xf, gate);
    if (isDefaultIntent(intent)) {
      return `[0:v]${fit}[base];[1:v]${fit}[top];`
        + `[base][top]overlay=x=0:y=0${gate},${HOLD_LAST},format=yuv420p[v]`;
    }
    if (!runs) {
      return `[0:v]${fit}[base];[1:v]${fit}[top];`
        + `[base][top]${blend},${HOLD_LAST},format=yuv420p[v]`;
    }
    return `[0:v]${fit},split[keep][under];[1:v]${fit}[top];`
      + `[under][top]${blend}[mixed];`
      + `[keep][mixed]overlay=x=0:y=0${gate},${HOLD_LAST},format=yuv420p[v]`;
  })();

  const args = [
    '-i', '{in0}', '-i', '{in1}',
    '-filter_complex', filter,
    '-map', '[v]',
    // the lower layer's sound, when there is no separate bed to replace it
    ...(keepSound ? ['-map', '0:a?', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest',
    /**
     * The exact length, in frames, and not a duration in seconds.
     *
     * This node was the only one in a compiled export that did not pin its
     * output, and a measured render came back 145 frames where the timeline
     * said 144. `blend` pads to its longest input, `-shortest` has nothing to
     * shorten against once `-an` has removed the only other stream, and a
     * re-encoding trim of "6 seconds" can hand over the frame that sits
     * exactly on the boundary. The timeline's own integer frame count is the
     * authority, so it is stated, exactly as `matchForJoin` does.
     */
    '-frames:v', String(Math.max(1, Math.round(durationFrames))),
    '{out}',
  ];

  return ctx.build.emit('ffmpeg/custom', {
    args,
    output: `layer.${INTERMEDIATE}`,
    tier: 'cpu',
  }, [['input', base], ['input', top]], seconds, { type: 'file:video' });
}

/** One picture track, ready to be laid over the ones below it. */
interface Layer {
  ref: Ref;
  intent: CompositeIntent;
  /** When it is on screen, or null for a track that covers the whole range. */
  runs: TimeRange[] | null;
  /**
   * Where its picture goes. Always the default for the bottom layer, whose
   * transform is already in `ref`: see `transformLayer`.
   */
  xf: TransformIntent;
}

function composite(
  ctx: Ctx, layers: Layer[], seconds: number, durationFrames: number, keepSound: boolean,
): Ref {
  if (layers.length === 1) return layers[0].ref;

  /**
   * Two paths, and the cheap one is the default.
   *
   * `ffmpeg/compose` stacks any number of layers in one pass, so an ordinary
   * timeline where every track is opaque, normal, and covers the whole
   * programme costs exactly one node. A blend or a gate needs both layers in
   * one filter graph and `ffmpeg/custom` takes two wires, so that path folds
   * one layer at a time and is only taken when something asks for it.
   *
   * Only the layers ABOVE the bottom one are asked. The bottom layer has
   * nothing to show through it, so its gaps are black either way, and its
   * blend mode has nothing to blend with.
   */
  const wantsFold = layers.slice(1).some(
    (l) => !isDefaultIntent(l.intent) || l.runs || !isDefaultTransform(l.xf));
  if (wantsFold) {
    let base = layers[0].ref;
    for (let i = 1; i < layers.length; i += 1) {
      const { ref, intent, runs, xf } = layers[i];
      // the sound belongs to the bottom layer, and only the last pass writes it
      base = layerOver(ctx, base, ref, intent, xf, runs, seconds, durationFrames,
        keepSound && i === layers.length - 1);
    }
    return base;
  }

  const used = layers.slice(0, MAX_COMPOSE_INPUTS).map((l) => l.ref);
  if (used.length < layers.length) {
    ctx.build.warn({
      code: 'unsupported_effect',
      message: `ffmpeg/compose takes ${MAX_COMPOSE_INPUTS} layers and the timeline has ${layers.length}, so the top ${layers.length - used.length} are dropped`,
    });
  }

  const width = clampInt(ctx.delivery.width, 16, 7680);
  const height = clampInt(ctx.delivery.height, 16, 4320);
  const preset = `${width}x${height}`;
  const custom = !COMPOSE_PRESETS.has(preset);

  return ctx.build.emit('ffmpeg/compose', {
    size: custom ? 'custom' : preset,
    ...(custom ? { width, height } : {}),
    layout: 'cells',
    units: 'fraction',
    // every layer fills the canvas and later cells draw over earlier ones,
    // which is the whole of "V2 sits above V1"
    cells: used.map((_, i) => ({ x: 0, y: 0, w: 1, h: 1, source: i, fit: 'contain' })),
    background: '#000000',
    fps: round6(rateFps(ctx.timeline.rate)),
    gutter: 0,
    padding: 0,
    duration: 'longest',
    durationSec: Math.max(MIN_CUT_SECONDS, seconds),
    container: INTERMEDIATE,
    audio: keepSound ? 'first' : 'none',
    audioBitrate: isBitrate(ctx.delivery.audioBitrate) ? ctx.delivery.audioBitrate : '192k',
  }, used.map((r) => ['inputs', r] as const), seconds);
}

/**
 * Sum the sound tracks.
 *
 * An NLE sums its tracks at unity: amix's own normalisation divides by the
 * track count, which would duck the dialogue the moment a music track is
 * added, so it is explicitly off. Per clip gain has already been applied by
 * the volume effect on the segment, and the document carries no per track
 * gain, so there is no track level volume node to emit.
 */
/**
 * `ffmpeg/custom` takes at most TWO wired inputs.
 *
 * Not in the catalogue, and not what the `input` param's own schema suggests
 * (it accepts an array of up to 50). Wires are different: a third one answers
 *
 *   args: args use {in2} but only 2 inputs were declared
 *
 * Verified against the live compiler with 2, 3 and 4 wires. Anything needing
 * more sources has to fold them pairwise.
 */
const MAX_WIRED_CUSTOM_INPUTS = 2;

/** One amix of exactly two sources. */
function mixPair(ctx: Ctx, a: Ref, b: Ref, seconds: number, final: boolean): Ref {
  const bitrate = isBitrate(ctx.delivery.audioBitrate) ? ctx.delivery.audioBitrate : '192k';
  // Intermediate layers stay PCM. Encoding to AAC at every level of the tree
  // would put a lossy generation between each pair, which is audible on a
  // four track mix and entirely avoidable.
  const codec = final ? ['-c:a', 'aac', '-b:a', bitrate] : ['-c:a', 'pcm_s16le'];
  return ctx.build.emit('ffmpeg/custom', {
    args: [
      '-i', '{in0}', '-i', '{in1}',
      '-filter_complex', 'amix=inputs=2:duration=longest:normalize=0',
      ...codec, '{out}',
    ],
    output: final ? 'mix.m4a' : 'mix.wav',
  }, [['input', a], ['input', b]], seconds, { type: 'file:audio' });
}

/**
 * Fold every bed into one, two at a time.
 *
 * A balanced tree rather than a chain: ceil(log2(n)) layers instead of n-1,
 * so four beds cost two layers and the odd one out is carried rather than
 * re-encoded for nothing.
 */
function mix(ctx: Ctx, beds: Ref[], seconds: number): Ref | null {
  if (beds.length === 0) return null;
  if (beds.length === 1) return beds[0];

  let layer = beds;
  while (layer.length > 1) {
    const next: Ref[] = [];
    for (let i = 0; i < layer.length; i += MAX_WIRED_CUSTOM_INPUTS) {
      const pair = layer.slice(i, i + MAX_WIRED_CUSTOM_INPUTS);
      if (pair.length === 1) { next.push(pair[0]); continue; }
      next.push(mixPair(ctx, pair[0], pair[1], seconds, layer.length === 2));
    }
    layer = next;
  }
  return layer[0];
}

/** Burn a subtitle file into the picture. Nothing in ffmpeg's node set does this. */
function burnIn(ctx: Ctx, video: Ref, subtitle: Ref, seconds: number): Ref {
  return ctx.build.emit('ffmpeg/custom', {
    args: ['-i', '{in0}', '-vf', 'subtitles={in1}', '-c:a', 'copy', '{out}'],
    output: 'subtitled.mp4',
  }, [['input', video], ['input', subtitle]], seconds, { type: 'file:video' });
}

/**
 * Add a delivery param only if the operation's own schema accepts the value.
 *
 * The delivery spec is user data: its codec string is whatever the caller
 * typed. Dropping a value the node would reject is better than a graph that
 * fails to compile over a spelling.
 */
function offer(
  ctx: Ctx,
  target: Record<string, unknown>,
  opKey: string,
  name: string,
  value: unknown,
  wired: readonly string[],
): void {
  if (value === undefined) return;
  const bad = validateParams(opKey, { [name]: value }, wired).filter((e) => e.path === name);
  if (bad.length) {
    ctx.build.warn({
      code: 'unsupported_effect',
      message: `${opKey} will not take ${name}=${JSON.stringify(value)}: ${bad[0].message}. The operation's default is used instead.`,
    });
    return;
  }
  target[name] = value;
}

// ── the compiler ────────────────────────────────────────────────────────

export function compile(timeline: Timeline, opts: CompileOptions): CompileResult {
  const build = new Build(opts.cache ?? new Map<string, string>());
  const ctx: Ctx = {
    build,
    timeline,
    delivery: opts.delivery,
    ratesReported: new Set(),
    copiedCuts: 0,
    fittedPicture: false,
  };
  const rate = timeline.rate;
  const total = timelineDuration(timeline);

  // what to build: the whole programme, or the slice a preview asked for
  const asked = opts.range
    ? timeRange(opts.range.start, Math.max(0, opts.range.duration) as Frames)
    : timeRange(ZERO, total);
  const compiled = rangeIntersection(asked, timeRange(ZERO, total)) ?? timeRange(asked.start, ZERO);
  const seconds = secs(compiled.duration, rate);

  if (compiled.duration === ZERO) {
    build.warn({
      code: 'empty_track',
      message: total === ZERO
        ? 'the timeline is empty, so the render is a moment of black'
        : 'nothing in the timeline covers the requested range, so the render is a moment of black',
    });
  }

  // ── a. and b. and c. and d. picture tracks, bottom of the stack first ──
  const pictureTracks = activeTracks(timeline, 'video');
  const layers: Layer[] = [];
  let anyFiller = false;

  // tracks[0] is the topmost track, and the bottom layer has to be drawn first
  const bottomUp = [...pictureTracks].reverse();
  for (const track of bottomUp) {
    const slots = flattenTrack(track, compiled, build.warn);
    const carries = slots.some((s) => s.clip !== null);
    if (!carries) {
      // an all black layer would simply hide everything under it. A track of
      // gaps, or one whose clips are all switched off, is empty on purpose and
      // not worth a warning; one whose clips all fall outside the range is.
      if (hasLiveClips(track)) {
        build.warn({
          code: 'empty_track',
          message: `picture track "${track.name}" has clips, but none of them inside the range being rendered, so it is left out of the composite`,
        });
      }
      continue;
    }
    // `layers.length` and not the loop index: a skipped empty track below
    // this one means this one is the bottom layer, and has nothing to cover
    const above = layers.length > 0;
    let runs = above ? visibleRuns(slots, compiled) : null;
    if (runs && runs.length > MAX_GATE_RUNS) {
      // the gate is one `between()` per run and the expression is evaluated
      // every frame, so past a point the black is the cheaper wrong answer
      build.warn({
        code: 'unsupported_effect',
        message: `"${track.name}" goes on and off ${runs.length} times, which is more gaps than can be gated, so they show as black over the track below`,
      });
      runs = null;
    }
    if (slots.some((s) => s.clip === null)) anyFiller = true;
    const xf = trackTransform(ctx, track);
    const joined = joinTrack(ctx, videoSegments(ctx, track, slots), seconds);
    layers.push({
      // the bottom layer is placed here and once, because nothing lays it over
      // anything; every layer above it is placed by the fold that draws it
      ref: above || isDefaultTransform(xf) ? joined : transformLayer(ctx, joined, xf, seconds),
      intent: trackIntent(ctx, track),
      runs,
      xf: above ? xf : DEFAULT_TRANSFORM,
    });
  }

  // ── f. sound tracks ───────────────────────────────────────────────────
  const beds: Ref[] = [];
  for (const track of activeTracks(timeline, 'audio')) {
    const slots = flattenTrack(track, compiled, build.warn);
    if (!slots.some((s) => s.clip !== null)) {
      if (hasLiveClips(track)) {
        build.warn({
          code: 'empty_track',
          message: `sound track "${track.name}" has clips, but none of them inside the range being rendered`,
        });
      }
      continue; // silence adds nothing to a sum
    }
    beds.push(joinTrack(ctx, audioSegments(ctx, track, slots), seconds));
  }

  // ── e. the composite ──────────────────────────────────────────────────
  // With a bed the picture's own sound is replaced anyway. Without one it is
  // all the sound there is, so take the bottom layer's, unless that layer has
  // generated black in it and therefore no continuous audio stream, or its
  // segments had to be matched to each other to be joined at all, which
  // leaves the picture with no sound to take.
  const keepSound = beds.length === 0 && !anyFiller && !ctx.fittedPicture;
  if (beds.length === 0 && !anyFiller && ctx.fittedPicture) {
    build.warn({
      code: 'unsupported_effect',
      message: 'the picture clips had to be re-encoded to a single size before they could be '
        + 'joined, which drops the sound they carried, and there is no sound track to take it '
        + 'from. Put the audio on an audio track to keep it.',
    });
  }
  let picture = layers.length
    ? composite(ctx, layers, seconds, compiled.duration, keepSound)
    : black(ctx, compiled.duration);

  // ── g. the sound onto the picture ─────────────────────────────────────
  const bed = mix(ctx, beds, seconds);
  if (bed) {
    picture = build.emit('ffmpeg/audio-replace', {
      // both streams are built to the compiled length, and `shortest` would
      // let a millisecond of rounding in the sound clip the tail of the picture
      shortest: false,
      container: INTERMEDIATE,
      audioBitrate: isBitrate(opts.delivery.audioBitrate) ? opts.delivery.audioBitrate : '192k',
    }, [['input', picture], ['audio', bed]], seconds, { type: 'file:video' });
  }

  // ── h. subtitles ──────────────────────────────────────────────────────
  if (opts.burnSubtitles) {
    /**
     * The document's own cues, written to an SRT and burned with libass.
     *
     * The first attempt at this built one `drawtext` filter per cue, gated
     * the way a layer is gated. ffmpeg refused it: `%` is expansion syntax,
     * `:` separates options, and the combination of escapes that satisfies
     * all of them at once does not appear to exist. `subtitles=` takes a
     * file and libass handles every character, multi-line cues and hundreds
     * of them, which drawtext does not.
     *
     * The file has to exist before the graph is built, so `exportTimeline`
     * uploads it and hands the key down. A pure compiler cannot upload, and
     * making it able to would be a worse trade than this one parameter.
     */
    const captions = opts.subtitleKey
      ? ctx.build.source(
        { key: opts.subtitleKey, name: 'captions.srt', kind: 'video', available: timeRange(ZERO, compiled.duration) },
        'file:subtitle',
      )
      : subtitleSource(ctx);
    if (captions) picture = burnIn(ctx, picture, captions, seconds);
  }

  // ── i. the delivery ───────────────────────────────────────────────────
  const webm = opts.delivery.container === 'webm';
  const transcode: Record<string, unknown> = {
    container: opts.delivery.container,
    audioCodec: webm ? WEBM_AUDIO_CODEC : 'aac',
  };
  offer(ctx, transcode, 'ffmpeg/transcode', 'width', clampInt(opts.delivery.width, 16, 7680), ['input']);
  offer(ctx, transcode, 'ffmpeg/transcode', 'height', clampInt(opts.delivery.height, 16, 4320), ['input']);
  offer(ctx, transcode, 'ffmpeg/transcode', 'fps', round6(rateFps(rate)), ['input']);
  offer(ctx, transcode, 'ffmpeg/transcode', 'videoCodec', opts.delivery.videoCodec, ['input']);
  // the node's default is h264, which a webm cannot hold, so an unset or
  // unusable codec becomes vp9 rather than being left to the default
  if (webm && !WEBM_VIDEO_CODECS.has(String(transcode.videoCodec))) {
    if (transcode.videoCodec !== undefined) {
      build.warn({
        code: 'unsupported_effect',
        message: `a webm cannot hold ${transcode.videoCodec} video, so vp9 is written instead`,
      });
    }
    transcode.videoCodec = 'vp9';
  }
  offer(ctx, transcode, 'ffmpeg/transcode', 'videoBitrate', opts.delivery.videoBitrate, ['input']);
  offer(ctx, transcode, 'ffmpeg/transcode', 'audioBitrate', opts.delivery.audioBitrate, ['input']);
  /**
   * The delivered file is exactly as long as the timeline says.
   *
   * Without this it was one frame longer, measured: AAC packets are 1024
   * samples, so a six second bed is 6.036854s, `audio-replace` keeps the
   * longer of the two streams on purpose, and the final encode then padded
   * the picture out to the sound. Every earlier step in the chain pins its
   * own length; this one did not, so the one number a user can check was the
   * one number nothing was defending.
   *
   * `secs()` is the single conversion from frames, so a non-integer rate
   * lands on the same value the rest of the compiler uses.
   */
  transcode.durationSec = Math.max(MIN_CUT_SECONDS, secs(compiled.duration, rate));
  const delivered = build.emit('ffmpeg/transcode', transcode, [['input', picture]], seconds);

  // One warning for the whole render, not one per cut: the loss is the same
  // fact repeated, and a hundred copies of it drowns everything else.
  if (ctx.copiedCuts > 0) {
    build.warn({
      code: 'keyframe_cut',
      message: `reencode is off, so ${ctx.copiedCuts} cut(s) land on the nearest keyframe instead of the frame asked for. Turn it on for a frame accurate cut.`,
    });
  }

  const out = build.graph.output(['file']);
  build.graph.wire(delivered.node, delivered.port, out, 'file');

  const graph = prune(build.graph.build(), out);
  const live = new Set(graph.nodes.map((n) => n.id));
  const gpuSeconds = graph.nodes.reduce((sum, n) => sum + (build.nodeCost.get(n.id) ?? 0), 0);

  // by NAME and only for the nodes that survived pruning: a run refuses an
  // input it does not have, and a cache hit can prune one away
  const inputs: Record<string, string> = {};
  for (const n of graph.nodes) {
    if (n.kind !== 'input') continue;
    const key = build.inputKeys.get(n.id);
    if (key !== undefined && n.name) inputs[n.name] = key;
  }

  return {
    graph,
    inputs,
    cacheKeys: Object.fromEntries(Object.entries(build.cacheKeys).filter(([id]) => live.has(id))),
    reused: [...new Set([...build.standIns].filter(([id]) => live.has(id)).map(([, key]) => key))],
    warnings: build.warnings,
    estimate: { nodes: graph.nodes.length, gpuSeconds: Math.round(gpuSeconds * 10) / 10 },
    nodeSeconds: Object.fromEntries([...build.nodeSeconds].filter(([id]) => live.has(id))),
  };
}

/**
 * Drop everything the output does not depend on.
 *
 * A cache hit makes everything that fed it dead, and the compiler only finds
 * out after the fact: a segment is emitted, then its consumer turns out to be
 * a file that already exists. Left in, those nodes are GPU minutes spent on a
 * file nothing reads.
 */
function prune(graph: Graph, outputId: string): Graph {
  const feeds = new Map<string, string[]>();
  for (const e of graph.edges) feeds.set(e.to.node, [...(feeds.get(e.to.node) ?? []), e.from.node]);

  const keep = new Set<string>();
  const stack = [outputId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (keep.has(id)) continue;
    keep.add(id);
    for (const from of feeds.get(id) ?? []) stack.push(from);
  }

  const edges = graph.edges.filter((e) => keep.has(e.from.node) && keep.has(e.to.node));
  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  // positions are laid out again, because the columns have moved
  return { version: graph.version, nodes: layout(nodes, edges), edges };
}

/**
 * The subtitle file to burn, if the document has one to burn.
 *
 * One file, singular: the burn is a filter over the whole programme and a
 * second `subtitles=` pass would be a second re-encode of the picture. A
 * captions track split across several files therefore loses all but the
 * first, which is worth saying out loud rather than discovering in the render.
 */
function subtitleSource(ctx: Ctx): Ref | null {
  let first: Ref | null = null;
  const files = new Set<string>();
  for (const track of activeTracks(ctx.timeline, 'subtitle')) {
    for (const item of track.items) {
      if (item.kind !== 'clip') continue;
      const ref = ctx.timeline.media[item.mediaKey];
      if (!ref) continue;
      files.add(ref.key);
      // a file on a subtitle track is subtitles, whatever MediaRef.kind says:
      // the kind union has no subtitle member, and the track does
      if (!first) first = ctx.build.source(ref, 'file:subtitle');
    }
  }
  if (!first) {
    ctx.build.warn({
      code: 'no_media',
      message: 'subtitles were asked for and the timeline carries no subtitle file, so nothing is burned in',
    });
    return null;
  }
  if (files.size > 1) {
    ctx.build.warn({
      code: 'unsupported_effect',
      message: `the subtitle tracks carry ${files.size} files and only the first can be burned in, so the rest are ignored`,
    });
  }
  return first;
}

export type { CompileOptions, CompileResult, CompileWarning } from './types.ts';
