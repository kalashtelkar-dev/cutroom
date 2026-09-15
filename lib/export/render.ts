/**
 * The export sequence.
 *
 * Emits an event per phase rather than returning only at the end: a render
 * takes minutes and a progress bar that cannot say which of six steps it is
 * on is a spinner with extra steps.
 *
 * Nothing here talks to the network. `ExportTransport` does, which is what
 * lets the whole sequence, including its failures, be tested for free.
 */
import { compile } from '../compiler/compile.ts';
import { timelineSrt } from '../subtitles/place.ts';
import { calibrateFromRun, describeCalibration } from '../compiler/calibrate.ts';
import { preflight } from '../editor-api/graph.ts';
import type { Timeline } from '../timeline/types.ts';
import type { CompileResult } from '../compiler/types.ts';
import {
  ExportError,
  type ExportEvent, type ExportOptions, type ExportResult,
  type ExportTransport, type RunSnapshot,
} from './types.ts';

const DONE = new Set(['succeeded', 'done', 'completed']);
const BROKEN = new Set(['failed', 'error', 'cancelled', 'canceled']);

/** How long to let a run sit before giving up on it. */
const RUN_TIMEOUT_MS = 30 * 60_000;
const POLL_MS = 2_000;

const say = (d: Diagnosticish[]) =>
  d.map((x) => `${x.code ?? 'error'}${x.node ? ` at ${x.node}` : ''}: ${x.message}`).join('; ');

interface Diagnosticish { code?: string; node?: string; message: string }

/**
 * Compile and check, without saving, publishing or spending anything.
 *
 * Separate from the run so the UI can show what a render would do, and what
 * is wrong with it, before anyone commits to paying for it.
 */
export async function dryRun(
  timeline: Timeline,
  opts: ExportOptions,
  transport: Pick<ExportTransport, 'validate'>,
): Promise<{ compiled: CompileResult; problems: Diagnosticish[] }> {
  const compiled = compile(timeline, {
    delivery: opts.delivery,
    burnSubtitles: opts.burnSubtitles,
    range: opts.range,
  });

  const local = preflight(compiled.graph);
  if (local.length) return { compiled, problems: local };

  const answer = await transport.validate(compiled.graph);
  // `unfinished` is a wire not yet drawn, not a wrong one. For an export both
  // stop the render, and keeping them apart is what lets the message say
  // which kind it is.
  const problems = [...(answer.errors ?? []), ...(answer.unfinished ?? [])];
  return { compiled, problems: answer.compiles && !problems.length ? [] : problems };
}

export async function exportTimeline(
  timeline: Timeline,
  opts: ExportOptions,
  transport: ExportTransport,
  emit: (e: ExportEvent) => void,
): Promise<ExportResult> {
  /**
   * The captions become a file before anything is compiled.
   *
   * They live in the document as cue items, which is what makes them
   * editable and visible in the viewer, and `subtitles=` needs a path. So
   * they are written out here, once, and the compiler is handed the key.
   * Failing to upload them is not a reason to lose the render: the export
   * carries on without the burn and says so.
   */
  let subtitleKey: string | undefined;
  if (opts.burnSubtitles) {
    const srt = timelineSrt(timeline);
    if (!srt.trim()) {
      emit({ phase: 'compiling', message: 'subtitles were asked for and the timeline has no captions' });
    } else if (!transport.uploadText) {
      emit({ phase: 'compiling', message: 'this transport cannot upload the caption file, so nothing is burned in' });
    } else {
      try {
        subtitleKey = await transport.uploadText('captions.srt', srt);
        emit({ phase: 'compiling', message: 'captions written out for the burn', detail: subtitleKey });
      } catch (e) {
        emit({ phase: 'compiling', message: `the caption file could not be uploaded: ${(e as Error).message}` });
      }
    }
  }

  // ── compile ──────────────────────────────────────────────────────────
  emit({ phase: 'compiling', message: 'Compiling the timeline' });
  const compiled = compile(timeline, {
    delivery: opts.delivery,
    burnSubtitles: opts.burnSubtitles,
    range: opts.range,
    ...(subtitleKey ? { subtitleKey } : {}),
  });
  emit({
    phase: 'compiling',
    message: `${compiled.graph.nodes.length} nodes, ${Object.keys(compiled.inputs).length} source file(s)`,
    detail: { estimate: compiled.estimate, reused: compiled.reused.length },
  });
  for (const w of compiled.warnings) emit({ phase: 'compiling', message: w.message, detail: w.code });

  if (!Object.keys(compiled.inputs).length) {
    // Every graph this compiler builds reads from at least one file. None
    // means an empty timeline, and a render of nothing is not worth the GPU.
    throw new ExportError('compiling', 'there is nothing on the timeline to render');
  }

  // ── check, free and instant ──────────────────────────────────────────
  emit({ phase: 'checking', message: 'Checking the graph offline' });
  const local = preflight(compiled.graph);
  if (local.length) {
    throw new ExportError('checking', `the compiled graph is not sound: ${say(local)}`, local);
  }

  emit({ phase: 'validating', message: 'Asking the server to compile it' });
  const answer = await transport.validate(compiled.graph);
  const problems = [...(answer.errors ?? []), ...(answer.unfinished ?? [])];
  if (!answer.compiles || problems.length) {
    throw new ExportError('validating', `the server will not compile it: ${say(problems)}`, problems);
  }

  // ── save ─────────────────────────────────────────────────────────────
  const name = opts.name?.trim() || timeline.name || 'Cutroom export';
  let pipelineId = opts.pipelineId ?? null;

  if (pipelineId) {
    emit({ phase: 'saving', message: `Replacing the graph in ${pipelineId}` });
    // the etag is read immediately before the write it protects: reading it
    // earlier would widen the window in which someone else can move first
    const head = await transport.head(pipelineId);
    const saved = await transport.replace(pipelineId, compiled.graph, head.etag);
    if (!saved.compiles) {
      throw new ExportError('saving', `saved, but it does not compile: ${say(saved.errors ?? [])}`, saved.errors);
    }
  } else {
    emit({ phase: 'saving', message: `Creating a pipeline for "${name}"` });
    pipelineId = await transport.importPipeline(name, compiled.graph);
    emit({ phase: 'saving', message: `pipeline ${pipelineId}` });
  }

  // ── publish ──────────────────────────────────────────────────────────
  emit({ phase: 'publishing', message: 'Publishing it' });
  await transport.publish(pipelineId);

  // ── run ──────────────────────────────────────────────────────────────
  emit({ phase: 'running', message: 'Starting the render', detail: compiled.inputs });
  const runId = await transport.start(pipelineId, compiled.inputs);
  emit({ phase: 'running', message: `run ${runId}` });

  const started = transport.now();
  let last: RunSnapshot | null = null;
  let reported = '';

  for (;;) {
    await transport.wait(POLL_MS);
    const snap = await transport.poll(runId);
    last = snap;

    const steps = snap.steps ?? [];
    const finished = steps.filter((s) => DONE.has(s.status)).length;
    const running = steps.find((s) => s.status === 'running' || s.status === 'started');
    // one line per change, not one per poll: fifteen identical "running"
    // lines bury the one that says which step it reached
    const line = running
      ? `${running.engine ?? ''}/${running.operation ?? running.step}`
      : snap.status;
    if (line !== reported) {
      reported = line;
      emit({
        phase: 'running',
        message: steps.length ? `${finished}/${steps.length} steps, at ${line}` : `run ${snap.status}`,
        progress: steps.length ? finished / steps.length : undefined,
      });
    }

    if (DONE.has(snap.status)) break;
    if (BROKEN.has(snap.status)) {
      const why = snap.error
        ? (typeof snap.error === 'string' ? snap.error : JSON.stringify(snap.error))
        : steps.find((s) => BROKEN.has(s.status))?.step ?? 'no reason given';
      throw new ExportError('running', `the render ${snap.status}: ${why}`, snap);
    }
    if (transport.now() - started > RUN_TIMEOUT_MS) {
      throw new ExportError('running', `the render was still ${snap.status} after 30 minutes`, snap);
    }
  }

  /**
   * The run is over, so it is now evidence.
   *
   * Every step reported when it started and finished, and the compiler knows
   * how much output each node made, so this is the one moment where the cost
   * table can stop being a guess. Wrapped, because a calibration is a nicety
   * and a finished render is not: a surprise in here must not lose the file.
   */
  try {
    const measured = calibrateFromRun(last?.steps ?? [], compiled.nodeSeconds);
    const said = describeCalibration(measured);
    if (said) emit({ phase: 'running', message: said, detail: measured.applied });
  } catch (e) {
    emit({ phase: 'running', message: `the run could not be measured: ${(e as Error).message}` });
  }

  // ── sign ─────────────────────────────────────────────────────────────
  const outputs = last?.output ?? {};
  // `file` is what this compiler's output node is called; fall back to the
  // first field rather than failing, because a future graph may name it else
  const key = outputs.file ?? Object.values(outputs)[0];
  if (!key) {
    throw new ExportError('signing', 'the render succeeded and returned no file', last);
  }

  emit({ phase: 'signing', message: 'Signing the output' });
  const urls = await transport.sign([key]);
  const url = urls[key];
  if (!url) {
    throw new ExportError('signing', `the output ${key} could not be signed`, urls);
  }

  emit({ phase: 'done', message: 'Rendered', progress: 1, detail: { key } });
  return {
    url,
    key,
    runId,
    pipelineId,
    warnings: compiled.warnings,
    runMs: last?.timings?.runMs,
  };
}
