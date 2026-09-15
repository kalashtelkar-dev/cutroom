/**
 * The run body contract, and the message a mismatch gets.
 *
 * "the request body does not match this pipeline" is what the server says,
 * and it is useless on its own: it names neither the key that was wrong nor
 * the ones that would have been right. A real card shipped binding
 * `{input: "<key>"}` to a pipeline whose only input node is `video`, and the
 * only way anyone found out was by pressing the button.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyMismatch, inputContract } from '../lib/editor-api/run-body.ts';

/** The real shape, from GET /v1/pipelines/tpl_75e1fLGX64dF. */
const BROLL_NODES = [
  { id: 'in1', kind: 'input', name: 'video', type: 'file:video', required: true },
  { id: 'ffmpeg_probe_1', kind: 'engine', engine: 'ffmpeg', operation: 'probe' },
  { id: 'out1', kind: 'output', fields: ['broll'] },
];

describe('what a pipeline will accept', () => {
  test('only input nodes count, and required is the default', () => {
    const c = inputContract(BROLL_NODES);
    assert.deepEqual(c.required, ['video']);
    assert.deepEqual(c.optional, []);
  });

  test('an optional input is separated from a required one', () => {
    const c = inputContract([
      { kind: 'input', name: 'video', required: true },
      { kind: 'input', name: 'language', required: false },
    ]);
    assert.deepEqual(c.required, ['video']);
    assert.deepEqual(c.optional, ['language']);
  });

  test('a pipeline with no inputs has no inputs, not one called undefined', () => {
    assert.deepEqual(inputContract([{ kind: 'engine', name: 'x' }]), { required: [], optional: [] });
    assert.deepEqual(inputContract(undefined), { required: [], optional: [] });
  });
});

describe('the message a bad body gets', () => {
  const contract = inputContract(BROLL_NODES);

  test('the right body is accepted', () => {
    assert.equal(bodyMismatch({ video: 'output/a.mp4' }, contract), null);
  });

  test('the exact defect that shipped is named on both sides', () => {
    const why = bodyMismatch({ input: 'output/a.mp4' }, contract, 'broll-plan-v1');
    assert.ok(why);
    // the pipeline's name, what it takes, what was sent, and both faults
    assert.match(why, /broll-plan-v1/);
    assert.match(why, /takes video/);
    assert.match(why, /sent input/);
    assert.match(why, /missing: video/);
    assert.match(why, /not an input: input/);
  });

  test('an empty body says so rather than listing nothing', () => {
    const why = bodyMismatch({}, contract);
    assert.ok(why);
    assert.match(why, /sent nothing/);
  });

  test('an optional input may be left out, and is offered in the message', () => {
    const c = inputContract([
      { kind: 'input', name: 'video', required: true },
      { kind: 'input', name: 'language', required: false },
    ]);
    assert.equal(bodyMismatch({ video: 'a' }, c), null);
    assert.equal(bodyMismatch({ video: 'a', language: 'en' }, c), null);
    const why = bodyMismatch({ language: 'en' }, c);
    assert.ok(why);
    assert.match(why, /language \(optional\)/);
    assert.match(why, /missing: video/);
  });

  test('a pipeline that takes nothing says that, rather than an empty list', () => {
    const why = bodyMismatch({ video: 'a' }, { required: [], optional: [] });
    assert.ok(why);
    assert.match(why, /no inputs at all/);
  });
});
