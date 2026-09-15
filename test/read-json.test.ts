/**
 * Reading a file a pipeline produced.
 *
 * `tighten-cut` needs sentence timings. `whisperx/subtitle` has a `segments`
 * port, but a port is a wire inside a graph: it is not in the run's reply,
 * and the two published subtitle pipelines wire only `files`, `text` and
 * `language` to their outputs. So the timings exist in exactly one place, the
 * `.json` file the run wrote, and a plan that cannot read a file cannot have
 * them. That is what this step is for.
 *
 * The shapes below were read off the real thing: a `whisperx/subtitle` job on
 * this account wrote `transcript.srt` at 0 bytes beside a 55 byte
 * `transcript.json` saying `{"segments": [], "word_segments": [], "language": "en"}`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseOutput, parseOutput } from '../lib/executor/readJson.ts';
import { validatePlan } from '../lib/router/plan.ts';
import type { Step } from '../lib/intel/types.ts';

/** What whisperx/subtitle actually returns when asked for srt and json. */
const REAL_OUTPUTS = [
  { key: 'output/6c9046f9/transcript.srt', role: 'output', bytes: 0 },
  { key: 'output/6c9046f9/transcript.json', role: 'output', bytes: 55 },
];

describe('choosing which output to read', () => {
  test('the suffix picks the one that is wanted', () => {
    assert.deepEqual(chooseOutput(REAL_OUTPUTS, '.json'), { key: 'output/6c9046f9/transcript.json' });
    assert.deepEqual(chooseOutput(REAL_OUTPUTS, '.srt'), { key: 'output/6c9046f9/transcript.srt' });
  });

  test('two files and no pick is refused, not guessed at', () => {
    const r = chooseOutput(REAL_OUTPUTS);
    assert.ok('error' in r);
    if (!('error' in r)) return;
    // the message has to list what there was, or the author cannot fix it
    assert.match(r.error, /transcript\.srt/);
    assert.match(r.error, /transcript\.json/);
    assert.match(r.error, /"pick"/);
  });

  test('one file and no pick is unambiguous', () => {
    assert.deepEqual(chooseOutput([REAL_OUTPUTS[1]]), { key: 'output/6c9046f9/transcript.json' });
  });

  test('a pick that matches nothing says what there was instead', () => {
    const r = chooseOutput(REAL_OUTPUTS, '.vtt');
    assert.ok('error' in r);
    if (!('error' in r)) return;
    assert.match(r.error, /no output ends with "\.vtt"/);
    assert.match(r.error, /transcript\.json/);
  });

  test('a step that produced nothing is not a file to read', () => {
    const r = chooseOutput([]);
    assert.ok('error' in r);
  });

  test('an ambiguous pick is refused rather than taking the first', () => {
    const r = chooseOutput(
      [{ key: 'a/one.json' }, { key: 'b/two.json' }],
      '.json',
    );
    assert.ok('error' in r);
    if (!('error' in r)) return;
    assert.match(r.error, /cannot tell them apart/);
  });
});

describe('parsing it', () => {
  test('the real empty transcript parses to a real empty answer', () => {
    const r = parseOutput('{"segments": [], "word_segments": [], "language": "en"}', 'x/transcript.json');
    assert.ok('value' in r);
    if (!('value' in r)) return;
    assert.deepEqual((r.value as { segments: unknown[] }).segments, []);
  });

  test('the 0 byte srt beside it is reported as empty, not as broken JSON', () => {
    const r = parseOutput('', 'x/transcript.srt');
    assert.ok('error' in r);
    if (!('error' in r)) return;
    assert.match(r.error, /transcript\.srt is empty/);
  });

  test('a file that is not JSON says so, with the file named', () => {
    const r = parseOutput('1\n00:00:01,000 --> 00:00:02,000\nhello\n', 'x/transcript.srt');
    assert.ok('error' in r);
    if (!('error' in r)) return;
    assert.match(r.error, /transcript\.srt is not JSON/);
  });
});

describe('the plan validator knows the step', () => {
  test('a read-json step is accepted', () => {
    const steps: Step[] = [{ kind: 'read-json', from: '$transcription', pick: '.json', as: '$transcript' }];
    assert.deepEqual(validatePlan(steps), []);
  });

  test('a read with no source is refused before it runs', () => {
    const problems = validatePlan([{ kind: 'read-json', pick: '.json' } as Step]);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, 'bad_param');
    assert.match(problems[0].message, /needs "from"/);
  });

  test('the step costs nothing, so it does not raise the plan rung', async () => {
    const { actualRung } = await import('../lib/router/plan.ts');
    assert.equal(actualRung([{ kind: 'read-json', from: '$x' }] as Step[]), 1);
  });
});
