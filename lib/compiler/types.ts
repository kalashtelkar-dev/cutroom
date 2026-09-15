/**
 * Timeline → pipeline graph.
 *
 * There is no renderer on the server: nothing turns a stored timeline into
 * video, and `otio/export` emits EDL/FCPXML/AAF only. This compiler is that
 * missing piece, and it is the core of the product.
 *
 * Content-addressed caching is mandatory rather than an optimisation. Without
 * it every small tweak re-renders the whole timeline; with it only the changed
 * segments rebuild. The key is a hash of (source key, operation, params) and
 * nothing else, no timestamps, no clip ids, nothing that changes when the
 * output would not.
 */
import type { Graph } from '../editor-api/graph.ts';
import type { Timeline } from '../timeline/types.ts';
import type { Frames } from '../time/frames.ts';

/**
 * What to do when the footage is not the shape of the frame it is going into.
 *
 * `contain` keeps the whole picture and puts bars where it does not reach.
 * `cover` fills the frame and loses whatever falls outside it. They are the
 * same answer whenever the two shapes agree, which is why nothing needed this
 * until a 16:9 cut was asked for as a 9:16 reel.
 */
export type FrameFit = 'contain' | 'cover';

export interface DeliverySpec {
  width: number;
  height: number;
  /** Default `contain`: a delivery must not crop someone's picture by surprise. */
  fit?: FrameFit;
  /** Container the final file is written to. */
  container: 'mp4' | 'mov' | 'webm';
  videoCodec?: string;
  videoBitrate?: string;
  audioBitrate?: string;
  /** true re-encodes everything; false keeps cuts on keyframes and loses frame accuracy. */
  reencode: boolean;
}

export interface CompileOptions {
  /**
   * An SRT already in storage, to burn in when `burnSubtitles` is set.
   *
   * The document's captions are the source, but writing them to a file is a
   * network call and this function is pure, so `exportTimeline` uploads and
   * passes the key. Absent, the compiler falls back to a subtitle file the
   * timeline itself references.
   */
  subtitleKey?: string;

  /**
   * A font already in storage, to burn the captions with.
   *
   * The render container has one font and it draws boxes for every Indic
   * script, Thai, Han, kana and Hangul, so a Hindi caption that is right in
   * the viewer renders as a row of squares. Given this, the compiler muxes
   * the font into the subtitle file as an attachment and names it in the
   * burn's style. See `lib/subtitles/fonts.ts` for why it takes both.
   *
   * `family` is matched by libass against the font's own name table, so it
   * is the font's string and not a label of ours.
   */
  subtitleFont?: { key: string; family: string; file: string };

  delivery: DeliverySpec;
  /** Keys already built, by cache key. A hit means the node is not emitted. */
  cache?: ReadonlyMap<string, string>;
  /** Compile only what covers this range, for a preview render. */
  range?: { start: Frames; duration: Frames };
  burnSubtitles?: boolean;
}

export interface CompileWarning {
  code: 'no_media' | 'keyframe_cut' | 'unsupported_effect' | 'empty_track' | 'rate_mismatch';
  clipId?: string;
  message: string;
}

export interface CompileResult {
  graph: Graph;
  /**
   * Input node name to the object key it stands for.
   *
   * This is what a run is started with: `POST /v1/run/{id}` takes one object
   * keyed by input NAME, not by node id, and a graph whose inputs are not all
   * supplied is refused. Deriving it afterwards from the graph is not
   * possible, the node carries a name and a type and never the key, so the
   * compiler is the only thing that knows which file each input stands for.
   */
  inputs: Record<string, string>;
  /** node id → cache key, so the executor can skip what already exists. */
  cacheKeys: Record<string, string>;
  /** Cache keys that were already present and therefore not emitted. */
  reused: string[];
  warnings: CompileWarning[];
  /** Rough cost, for the escalation ladder and for telling the user. */
  estimate: { nodes: number; gpuSeconds: number };
  /**
   * Node id to the seconds of output it produces.
   *
   * Kept so a finished run can be turned back into a measurement: the run
   * reports how long each step took, and this is the other half of "seconds
   * of work per second of output". Without it the cost table can only ever
   * be the numbers somebody typed.
   */
  nodeSeconds: Record<string, number>;
}

export type Compiler = (timeline: Timeline, opts: CompileOptions) => CompileResult;
