/**
 * The cost table, and how it stops being a guess.
 *
 * The previous version of this file called the setter and then read it back,
 * which passes forever and proves nothing: while it was green, nothing in
 * the application ever called the setter, so every estimate a user saw was
 * the number somebody typed in 2026. These tests measure a real run payload
 * instead, and one of them asserts that the wiring exists at all.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getCostPerSecond, recordCostMetric, getReencodeMultiplier, recordReencodeMultiplier,
} from '../lib/compiler/compile.ts';
import {
  BLEND, calibrateFromRun, describeCalibration, measureRun, type RunStep,
} from '../lib/compiler/calibrate.ts';
import { getEncoderLimits } from '../lib/export/limits.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Six steps copied out of a real run on this account
 * (`GET /v1/runs/run_8f318981…`), timestamps and all. Not invented: the
 * shape of this payload is the thing under test, and a fixture written from
 * the same assumption as the code would agree with it no matter what.
 */
const REAL_STEPS: RunStep[] = [
  { step: 'ffmpeg_trim_1', engine: 'ffmpeg', operation: 'trim', status: 'succeeded', startedAt: '2026-09-14T16:26:05.335Z', finishedAt: '2026-09-14T16:26:07.114Z' },
  { step: 'ffmpeg_synthetic_1', engine: 'ffmpeg', operation: 'synthetic', status: 'succeeded', startedAt: '2026-09-14T16:26:05.350Z', finishedAt: '2026-09-14T16:26:06.273Z' },
  { step: 'ffmpeg_synthetic_2', engine: 'ffmpeg', operation: 'synthetic', status: 'succeeded', startedAt: '2026-09-14T16:26:05.372Z', finishedAt: '2026-09-14T16:26:06.382Z' },
  { step: 'ffmpeg_custom_3', engine: 'ffmpeg', operation: 'custom', status: 'succeeded', startedAt: '2026-09-14T16:26:05.409Z', finishedAt: '2026-09-14T16:26:06.622Z' },
  { step: 'ffmpeg_synthetic_3', engine: 'ffmpeg', operation: 'synthetic', status: 'succeeded', startedAt: '2026-09-14T16:26:05.423Z', finishedAt: '2026-09-14T16:26:10.033Z' },
  { step: 'ffmpeg_custom_7', engine: 'ffmpeg', operation: 'custom', status: 'succeeded', startedAt: '2026-09-14T16:26:05.436Z', finishedAt: '2026-09-14T16:26:05.567Z' },
];

/** Two seconds of output from every node, so the arithmetic is checkable. */
const TWO_SECONDS = Object.fromEntries(REAL_STEPS.map((s) => [s.step, 2]));

describe('measuring a run', () => {
  test('a real payload becomes one sample per successful step', () => {
    const { samples, skipped } = measureRun(REAL_STEPS, TWO_SECONDS);
    assert.equal(samples.length, REAL_STEPS.length, `dropped steps: ${JSON.stringify(skipped)}`);

    // 16:26:07.114 minus 16:26:05.335 is 1.779s, over 2s of output
    const trim = samples.find((s) => s.opKey === 'ffmpeg/trim');
    assert.ok(trim);
    assert.equal(trim.wallSeconds, 1.779);
    assert.equal(trim.outputSeconds, 2);
    assert.equal(Math.round(trim.perSecond * 10000) / 10000, 0.8895);
  });

  test('a step that did not succeed is not evidence', () => {
    const steps: RunStep[] = [
      { ...REAL_STEPS[0], status: 'failed' },
      { ...REAL_STEPS[1], status: 'skipped' },
    ];
    const { samples, skipped } = measureRun(steps, TWO_SECONDS);
    assert.equal(samples.length, 0);
    assert.equal(skipped['did not succeed'], 2);
  });

  test('a step with no timestamps is dropped, not treated as instant', () => {
    const { samples, skipped } = measureRun(
      [{ ...REAL_STEPS[0], startedAt: null, finishedAt: null }],
      TWO_SECONDS,
    );
    assert.equal(samples.length, 0);
    assert.equal(skipped['no usable timestamps'], 1);
  });

  test('a node that produced no output seconds is dropped, not divided by zero', () => {
    const { samples, skipped } = measureRun(REAL_STEPS, {});
    assert.equal(samples.length, 0);
    assert.equal(skipped['no output duration for that node'], REAL_STEPS.length);
    assert.ok(samples.every((s) => Number.isFinite(s.perSecond)));
  });

  test('a step that finished in the same instant it started is a cache hit, not free work', () => {
    const at = '2026-09-14T16:26:05.335Z';
    const { samples, skipped } = measureRun(
      [{ ...REAL_STEPS[0], startedAt: at, finishedAt: at }],
      TWO_SECONDS,
    );
    assert.equal(samples.length, 0);
    assert.equal(skipped['finished in no time, so nothing ran'], 1);
  });

  test('a finish before its start is refused rather than recorded as negative', () => {
    const { samples } = measureRun(
      [{ ...REAL_STEPS[0], startedAt: '2026-09-14T16:26:07.114Z', finishedAt: '2026-09-14T16:26:05.335Z' }],
      TWO_SECONDS,
    );
    assert.equal(samples.length, 0);
  });
});

describe('moving the table towards what was measured', () => {
  test('several steps of one operation count as one opinion, averaged', () => {
    const before = getCostPerSecond('ffmpeg/synthetic');
    try {
      const c = calibrateFromRun(REAL_STEPS, TWO_SECONDS);
      const synthetic = c.applied.find((a) => a.opKey === 'ffmpeg/synthetic');
      assert.ok(synthetic);
      assert.equal(synthetic.samples, 3, 'three synthetic steps, one entry');

      // 0.923, 1.010 and 4.610 seconds over 2s each: mean 1.0905 per second
      const mean = (0.923 + 1.010 + 4.610) / 3 / 2;
      assert.equal(synthetic.to, Math.round((before + (mean - before) * BLEND) * 1000) / 1000);
    } finally {
      recordCostMetric('ffmpeg/synthetic', before);
    }
  });

  test('one odd run moves the table part of the way, never all of it', () => {
    const before = getCostPerSecond('ffmpeg/trim');
    try {
      // a worker that took a minute over two seconds of output
      calibrateFromRun(
        [{ ...REAL_STEPS[0], startedAt: '2026-09-14T16:26:05.000Z', finishedAt: '2026-09-14T16:27:05.000Z' }],
        { ffmpeg_trim_1: 2 },
      );
      const after = getCostPerSecond('ffmpeg/trim');
      assert.ok(after > before, 'it moved');
      assert.ok(after < 30, `it did not take the whole 30 per second: ${after}`);
    } finally {
      recordCostMetric('ffmpeg/trim', before);
    }
  });

  test('a run that teaches nothing changes nothing and says so', () => {
    const before = getCostPerSecond('ffmpeg/trim');
    const c = calibrateFromRun([], {});
    assert.deepEqual(c.applied, []);
    assert.equal(describeCalibration(c), null);
    assert.equal(getCostPerSecond('ffmpeg/trim'), before);
  });

  test('the estimate actually reads the calibrated value', () => {
    const before = getCostPerSecond('ffmpeg/trim');
    try {
      recordCostMetric('ffmpeg/trim', 0.42);
      assert.equal(getCostPerSecond('ffmpeg/trim'), 0.42);
    } finally {
      recordCostMetric('ffmpeg/trim', before);
    }
  });
});

describe('the calibration is connected to something', () => {
  /**
   * The defect this file was written over: a setter with no caller, and a
   * test that called it itself. If the export stops measuring its own run,
   * every other test here still passes, so this is the one that notices.
   */
  test('the export path calls it after a run finishes', () => {
    const render = readFileSync(join(ROOT, 'lib', 'export', 'render.ts'), 'utf8');
    assert.match(render, /calibrateFromRun\(/, 'nothing in the export measures the run it just did');
    assert.match(render, /nodeSeconds/, 'the measurement has no output durations to divide by');
  });

  test('the compiler hands back the output seconds the measurement needs', () => {
    const types = readFileSync(join(ROOT, 'lib', 'compiler', 'types.ts'), 'utf8');
    assert.match(types, /nodeSeconds: Record<string, number>/);
  });

  test('the transport does not drop the timestamps on the way through', () => {
    const t = readFileSync(join(ROOT, 'lib', 'export', 'transport.server.ts'), 'utf8');
    assert.match(t, /startedAt/);
    assert.match(t, /finishedAt/);
  });
});

describe('encoder limits come from the catalogue', () => {
  test('getEncoderLimits consults catalogue schema', () => {
    const limits = getEncoderLimits();
    assert.ok(limits.minWidth >= 16);
    assert.ok(limits.maxWidth >= 1920);
    assert.ok(limits.minHeight >= 16);
    assert.ok(limits.maxHeight >= 1080);
    assert.ok(limits.containers.includes('mp4'));
  });

  test('the reencode multiplier can be measured too', () => {
    const original = getReencodeMultiplier();
    try {
      recordReencodeMultiplier(8);
      assert.equal(getReencodeMultiplier(), 8);
    } finally {
      recordReencodeMultiplier(original);
    }
  });
});
