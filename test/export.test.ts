/**
 * The export sequence, including every way it can fail.
 *
 * A fake that always succeeds only proves the happy path exists, so most of
 * what follows makes the transport refuse at one step and checks that the
 * message names the step and the reason. The one thing a person cannot act on
 * is an export that fails silently.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { exportTimeline, dryRun } from '../lib/export/render.ts';
import { ExportError, type ExportEvent, type ExportTransport, type RunSnapshot } from '../lib/export/types.ts';
import { emptyTimeline } from '../lib/timeline/document.ts';
import { RATES, frames, timeRange, type Frames } from '../lib/time/frames.ts';
import type { Clip, Timeline } from '../lib/timeline/types.ts';
import type { DeliverySpec } from '../lib/compiler/types.ts';

const RATE = RATES.web;
const F = (n: number): Frames => frames(n);
const HD: DeliverySpec = { width: 1920, height: 1080, container: 'mp4', reencode: true };

const clip = (id: string, mediaKey: string, start: number, duration: number): Clip => ({
  id, kind: 'clip', name: id, mediaKey,
  sourceRange: timeRange(F(start), F(duration)),
  enabled: true, effects: [],
});

/** One picture track with two cuts on it, which is the smallest real export. */
function doc(): Timeline {
  const t = emptyTimeline('tl_x', 'Test cut', RATE);
  t.media.v1 = { key: 'obj/a.mp4', name: 'interview.mp4', kind: 'video', available: timeRange(F(0), F(9000)) };
  t.media.v2 = { key: 'obj/b.mp4', name: 'broll.mov', kind: 'video', available: timeRange(F(0), F(9000)) };
  const v1 = t.tracks.find((x) => x.kind === 'video' && x.name === 'Video 1') ?? t.tracks[1];
  v1.items.push(clip('c1', 'v1', 0, 60), clip('c2', 'v2', 0, 45));
  return t;
}

// ── a transport that works, and knobs to make it not ────────────────────

interface Knobs {
  compiles?: boolean;
  errors?: { code?: string; message: string }[];
  importFails?: string;
  replaceCompiles?: boolean;
  publishFails?: string;
  /** Statuses the run reports, in order. The last one is the terminal one. */
  statuses?: string[];
  output?: Record<string, string> | null;
  runError?: unknown;
  signs?: boolean;
  headEtag?: string;
}

interface Recorder {
  calls: string[];
  runInput: Record<string, string> | null;
  replacedWith: { id: string; etag: string } | null;
  importedName: string | null;
}

function fake(knobs: Knobs = {}): { transport: ExportTransport; rec: Recorder } {
  const rec: Recorder = { calls: [], runInput: null, replacedWith: null, importedName: null };
  const statuses = [...(knobs.statuses ?? ['running', 'succeeded'])];
  let clock = 0;

  const transport: ExportTransport = {
    validate: async () => {
      rec.calls.push('validate');
      return {
        compiles: knobs.compiles ?? true,
        errors: (knobs.errors ?? []) as never[],
        unfinished: [],
      };
    },
    importPipeline: async (name) => {
      rec.calls.push('import');
      rec.importedName = name;
      if (knobs.importFails) throw new Error(knobs.importFails);
      return 'tpl_new';
    },
    head: async (id) => {
      rec.calls.push('head');
      return { id, etag: knobs.headEtag ?? 'etag-1', version: 1, published: true };
    },
    replace: async (id, _g, etag) => {
      rec.calls.push('replace');
      rec.replacedWith = { id, etag };
      return { compiles: knobs.replaceCompiles ?? true, errors: [] as never[] };
    },
    publish: async () => {
      rec.calls.push('publish');
      if (knobs.publishFails) throw new Error(knobs.publishFails);
    },
    start: async (_id, inputs) => {
      rec.calls.push('start');
      rec.runInput = inputs;
      return 'run_1';
    },
    poll: async (): Promise<RunSnapshot> => {
      rec.calls.push('poll');
      const status = statuses.length > 1 ? statuses.shift() as string : statuses[0];
      return {
        runId: 'run_1',
        status,
        output: status === 'succeeded' ? (knobs.output ?? { file: 'out/final.mp4' }) : null,
        error: knobs.runError,
        steps: [{ step: 'trim1', status: 'succeeded' }, { step: 'transcode1', status }],
        timings: { runMs: 1234 },
      };
    },
    sign: async (keys) => {
      rec.calls.push('sign');
      if (knobs.signs === false) return {};
      return Object.fromEntries(keys.map((k) => [k, `https://signed/${k}?sig=x`]));
    },
    wait: async () => { clock += 2000; },
    now: () => clock,
  };
  return { transport, rec };
}

const collect = () => {
  const events: ExportEvent[] = [];
  return { events, emit: (e: ExportEvent) => { events.push(e); } };
};

// ── the happy path ──────────────────────────────────────────────────────

describe('export, end to end', () => {
  test('compiles, checks, saves, publishes, runs and signs, in that order', async () => {
    const { transport, rec } = fake();
    const { events, emit } = collect();

    const r = await exportTimeline(doc(), { delivery: HD }, transport, emit);

    assert.equal(r.url, 'https://signed/out/final.mp4?sig=x');
    assert.equal(r.key, 'out/final.mp4');
    assert.equal(r.runId, 'run_1');
    assert.equal(r.pipelineId, 'tpl_new');
    assert.equal(r.runMs, 1234);

    // the order matters: validating after publishing would mean paying to
    // find out, and signing before the run finishes signs nothing
    const order = rec.calls.filter((c) => c !== 'poll');
    assert.deepEqual(order, ['validate', 'import', 'publish', 'start', 'sign']);

    const phases = [...new Set(events.map((e) => e.phase))];
    assert.deepEqual(phases, ['compiling', 'checking', 'validating', 'saving', 'publishing', 'running', 'signing', 'done']);
  });

  test('the run is started with the media keys, keyed by input NAME', async () => {
    const { transport, rec } = fake();
    await exportTimeline(doc(), { delivery: HD }, transport, collect().emit);

    assert.ok(rec.runInput, 'the run got no inputs');
    const values = Object.values(rec.runInput);
    // the names come from the media names, the values are the object keys
    assert.ok(values.includes('obj/a.mp4'), `expected obj/a.mp4 in ${JSON.stringify(rec.runInput)}`);
    assert.ok(values.includes('obj/b.mp4'), `expected obj/b.mp4 in ${JSON.stringify(rec.runInput)}`);
    for (const name of Object.keys(rec.runInput)) {
      assert.match(name, /^[A-Za-z0-9_]+$/, `"${name}" is not usable as a request key`);
    }
  });

  test('an existing pipeline is replaced rather than another one created', async () => {
    const { transport, rec } = fake({ headEtag: 'etag-77' });
    await exportTimeline(doc(), { delivery: HD, pipelineId: 'tpl_mine' }, transport, collect().emit);

    assert.ok(!rec.calls.includes('import'), 'it created a second pipeline');
    assert.deepEqual(rec.replacedWith, { id: 'tpl_mine', etag: 'etag-77' });
    // the etag is read immediately before the write it guards
    assert.ok(rec.calls.indexOf('head') < rec.calls.indexOf('replace'));
  });

  test('progress names the step it reached, and does not repeat itself', async () => {
    const { transport } = fake({ statuses: ['queued', 'running', 'running', 'running', 'succeeded'] });
    const { events, emit } = collect();
    await exportTimeline(doc(), { delivery: HD }, transport, emit);

    const running = events.filter((e) => e.phase === 'running').map((e) => e.message);
    // five polls, three of them identical: the identical ones say nothing
    const repeated = running.filter((m, i) => m === running[i - 1]);
    assert.deepEqual(repeated, [], `progress repeated itself: ${JSON.stringify(running)}`);
  });
});

// ── the ways it fails ───────────────────────────────────────────────────

describe('export failures say which step and why', () => {
  const expectFail = async (
    t: Timeline, knobs: Knobs, phase: string, matcher: RegExp,
    opts: Parameters<typeof exportTimeline>[1] = { delivery: HD },
  ) => {
    const { transport } = fake(knobs);
    await assert.rejects(
      () => exportTimeline(t, opts, transport, collect().emit),
      (e: unknown) => {
        assert.ok(e instanceof ExportError, `not an ExportError: ${e}`);
        assert.equal(e.phase, phase);
        assert.match(e.message, matcher);
        return true;
      },
    );
  };

  test('an empty timeline is refused before anything is spent', async () => {
    const { transport, rec } = fake();
    await assert.rejects(
      () => exportTimeline(emptyTimeline('tl_0', 'Empty', RATE), { delivery: HD }, transport, collect().emit),
      /nothing on the timeline/,
    );
    assert.deepEqual(rec.calls, [], 'it called the API for an empty timeline');
  });

  test('the server refusing to compile stops before publish, and quotes the reason', async () => {
    const { transport, rec } = fake({
      compiles: false,
      errors: [{ code: 'type_mismatch', message: 'file:audio into file:video' }],
    });
    await assert.rejects(
      () => exportTimeline(doc(), { delivery: HD }, transport, collect().emit),
      /type_mismatch.*file:audio into file:video/,
    );
    assert.ok(!rec.calls.includes('publish'), 'it published a graph that does not compile');
    assert.ok(!rec.calls.includes('start'), 'it spent money on a graph that does not compile');
  });

  test('a failed run reports the run error, not just "failed"', async () => {
    await expectFail(
      doc(),
      { statuses: ['running', 'failed'], runError: { message: 'ffmpeg exited 1: no such filter' } },
      'running',
      /no such filter/,
    );
  });

  test('a run that succeeds with no output is a failure, not a success', async () => {
    await expectFail(doc(), { output: {} }, 'signing', /returned no file/);
  });

  test('an output that cannot be signed is a failure, not an empty link', async () => {
    await expectFail(doc(), { signs: false }, 'signing', /could not be signed/);
  });

  test('a saved graph that does not compile stops before publish', async () => {
    const { transport, rec } = fake({ replaceCompiles: false });
    await assert.rejects(
      () => exportTimeline(doc(), { delivery: HD, pipelineId: 'tpl_mine' }, transport, collect().emit),
      /does not compile/,
    );
    assert.ok(!rec.calls.includes('publish'));
  });

  test('a run that never finishes gives up rather than polling forever', async () => {
    await expectFail(doc(), { statuses: ['running'] }, 'running', /after 30 minutes/);
  });
});

// ── the free check ──────────────────────────────────────────────────────

describe('dryRun', () => {
  test('reports what a render would do without saving, publishing or spending', async () => {
    const { transport, rec } = fake();
    const { compiled, problems } = await dryRun(doc(), { delivery: HD }, transport);

    assert.deepEqual(problems, []);
    assert.ok(compiled.graph.nodes.length > 0);
    assert.deepEqual(rec.calls, ['validate'], 'dryRun touched more than validate');
  });

  test('surfaces what the server objects to, without throwing', async () => {
    const { transport } = fake({ compiles: false, errors: [{ code: 'cycle', message: 'a loops to b' }] });
    const { problems } = await dryRun(doc(), { delivery: HD }, transport);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].message, 'a loops to b');
  });
});
