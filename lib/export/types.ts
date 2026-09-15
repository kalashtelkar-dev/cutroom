/**
 * Export: a timeline becomes a file you can play.
 *
 * There is no renderer on the server, so this is six calls in a row rather
 * than one, and every one of them can fail in a way the person watching needs
 * told about. The sequence, and why it is this sequence:
 *
 *   compile    the timeline becomes a graph               (ours, instant)
 *   preflight  ten of the twelve compiler codes, offline  (ours, instant)
 *   validate   the server has the last word               (free)
 *   save       import a new pipeline, or replace a draft  (mutates)
 *   publish    freeze it so it can be run                 (mutates)
 *   run        spend the GPU                              (spends)
 *   sign       turn the output key into a URL             (free)
 *
 * The two instant checks come first on purpose: a graph that cannot compile
 * should cost nothing to find out about, and the offline pass answers in a
 * millisecond what the round trip answers in three hundred.
 *
 * Facts below were learned by calling the endpoints, not from the spec, which
 * declares empty schemas for all of them:
 *
 *  - A pipeline CANNOT be created by PUT. `PUT /v1/pipelines/{id}` refuses
 *    without an etag even for an id that does not exist. New ones come from
 *    `POST /v1/pipelines/import`, whose body is one exported document.
 *  - The etag goes in the BODY of the PUT, not in `If-Match`. Sending the
 *    header alone answers 400, "give the etag of the version you edited".
 *  - `POST /v1/run/{id}` takes the inputs keyed by input node NAME.
 *  - It answers `runId`, not `id`, and the run's result carries `output` as an
 *    object keyed by the output node's fields, not as an array.
 */
import type { Graph, Diagnostic } from '../editor-api/graph.ts';
import type { DeliverySpec, CompileWarning } from '../compiler/types.ts';
import type { SubtitleFont } from '../subtitles/fonts.ts';

export type ExportPhase =
  | 'compiling' | 'checking' | 'validating' | 'saving'
  | 'publishing' | 'running' | 'signing' | 'done' | 'failed';

export interface ExportEvent {
  phase: ExportPhase;
  message: string;
  /** 0..1 where it is known. Absent means "working, length unknown". */
  progress?: number;
  detail?: unknown;
}

export interface ExportResult {
  /** Signed, and good for about an hour. Re-sign rather than storing it. */
  url: string;
  key: string;
  bytes?: number;
  runId: string;
  pipelineId: string;
  warnings: CompileWarning[];
  /** Milliseconds the run itself took, when the server reports it. */
  runMs?: number;
}

export interface ExportOptions {
  delivery: DeliverySpec;
  /**
   * Reuse this pipeline rather than creating another.
   *
   * Without it every export leaves a new pipeline behind, which is what the
   * previous attempt at this did: the account still carries its litter. One
   * per project, replaced in place.
   */
  pipelineId?: string | null;
  name?: string;
  burnSubtitles?: boolean;
  /** Compile only what covers this range, in frames. */
  range?: { start: any; duration: any };
}

export interface PipelineHead {
  id: string;
  etag: string;
  version: number;
  published: boolean;
}

export interface RunSnapshot {
  runId: string;
  status: string;
  /** Keyed by the output node's field names. */
  output?: Record<string, string> | null;
  error?: unknown;
  /**
   * `startedAt` and `finishedAt` are not decoration: they are what turns a
   * finished run into a measurement of what each operation actually costs.
   * See `lib/compiler/calibrate.ts`.
   */
  steps?: {
    step: string; status: string; operation?: string; engine?: string;
    startedAt?: string | null; finishedAt?: string | null;
  }[];
  timings?: { runMs?: number };
}

export interface ValidateAnswer {
  compiles: boolean;
  errors: Diagnostic[];
  unfinished: Diagnostic[];
}

/**
 * Everything the export needs from the outside world.
 *
 * Injected rather than imported so the orchestration can be tested without
 * spending a penny, and so the one place that holds the API key stays the
 * route handler.
 */
export interface ExportTransport {
  validate(graph: Graph): Promise<ValidateAnswer>;
  importPipeline(name: string, graph: Graph): Promise<string>;
  head(id: string): Promise<PipelineHead>;
  replace(id: string, graph: Graph, etag: string): Promise<{ compiles: boolean; errors: Diagnostic[] }>;
  publish(id: string): Promise<void>;
  start(id: string, inputs: Record<string, string>): Promise<string>;
  poll(runId: string): Promise<RunSnapshot>;
  sign(keys: string[]): Promise<Record<string, string>>;
  /**
   * Put a small text file in storage and return its key.
   *
   * Used for the subtitle file: the document's captions are the source of
   * truth, `subtitles=` needs a file, and the compiler is a pure function
   * that cannot make one. Optional, because a transport that cannot upload
   * can still export everything that is not captioned.
   */
  uploadText?(filename: string, text: string): Promise<string>;
  /**
   * Put one of the bundled subtitle fonts in storage and return its key.
   *
   * Reading the file is the transport's job rather than the sequence's for
   * the same reason the API key is: `exportTimeline` stays a function of its
   * arguments, and everything that touches the disk or the network sits on
   * one side of it. Optional, because a transport that cannot do it can
   * still export, and the captions come out as boxes rather than not at all.
   */
  uploadFont?(font: SubtitleFont): Promise<string>;
  /** Injected so a test does not wait in real time. */
  wait(ms: number): Promise<void>;
  now(): number;
}

/** A failure that knows which step it happened in, so the UI can say. */
export class ExportError extends Error {
  // plain fields rather than constructor parameter properties: node strips
  // types without transforming and cannot desugar one, and these tests run
  // under `node --test`
  readonly phase: ExportPhase;
  readonly detail?: unknown;

  constructor(phase: ExportPhase, message: string, detail?: unknown) {
    super(message);
    this.name = 'ExportError';
    this.phase = phase;
    this.detail = detail;
  }
}
