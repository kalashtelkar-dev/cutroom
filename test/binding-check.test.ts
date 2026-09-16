/**
 * The values a step is about to send, checked before it sends them.
 *
 * Every case here is a real failure that reached the live API and came back
 * as `input_unreachable: The specified key does not exist`, which is a true
 * answer to the wrong question. Four of the nine cards had one.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkFileValue, checkOperationInput, checkRunBody, describeProblems, filePorts,
} from '../lib/executor/bindingCheck.ts';

describe('a value that cannot be a file', () => {
  test('a binding nothing set is refused, not posted as text', () => {
    // subtitle-burn bound "$program", which nothing sets, so the seven
    // characters were sent as an object key
    const p = checkFileValue('video', '$program');
    assert.ok(p);
    assert.match(p.reason, /nothing bound \$program/);
    assert.match(p.reason, /\$source/);
  });

  test('a clip id is refused: it resolves, and it is still not a file', () => {
    // auto-broll-weave and volume-adjust both bound "$selection", which is a
    // clip id. It is a real string, which is why nothing caught it.
    const p = checkFileValue('input', 'clp_9f2ab31c');
    assert.ok(p);
    assert.match(p.reason, /not a file in storage/);
  });

  test('a track or timeline id too', () => {
    assert.ok(checkFileValue('input', 'trk_v1'));
    assert.ok(checkFileValue('input', 'tl_untitled'));
  });

  test('a bare word with no prefix has nothing to open', () => {
    const p = checkFileValue('input', 'interview');
    assert.ok(p);
    assert.match(p.reason, /not an object key or a url/);
  });

  test('a real object key passes', () => {
    assert.equal(checkFileValue('video', 'output/7b47d08e/transcript.srt'), null);
    assert.equal(checkFileValue('video', 'input/2026-09-14/clip.mp4'), null);
  });

  test('a url passes, because the API takes one', () => {
    assert.equal(checkFileValue('video', 'https://example.com/a.mp4'), null);
  });

  test('a value that is not a string is not this check\'s business', () => {
    assert.equal(checkFileValue('width', 1920), null);
    assert.equal(checkFileValue('video', undefined), null);
  });
});

describe('which ports it looks at', () => {
  test('only the ports that open a file, read from the catalogue', () => {
    const ports = filePorts('ffmpeg', 'volume');
    assert.ok(ports.includes('input'), `volume takes a file on input, got ${ports.join(', ')}`);
  });

  test('an operation nobody has heard of has no file ports to check', () => {
    assert.deepEqual(filePorts('nonsuch', 'nothing'), []);
  });

  test('a numeric param beside a bad file is not confused for one', () => {
    const problems = checkOperationInput('ffmpeg', 'volume', { input: '$selection', volume: 0.5 });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].port, 'input');
  });

  test('a good operation input passes', () => {
    assert.deepEqual(
      checkOperationInput('ffmpeg', 'volume', { input: 'output/a/b.mp4', volume: 0.5 }),
      [],
    );
  });
});

describe('a pipeline run body', () => {
  test('every value is checked, because a run body is nothing but inputs', () => {
    const problems = checkRunBody({ video: '$program' });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].port, 'video');
  });

  test('the right body passes', () => {
    assert.deepEqual(checkRunBody({ video: 'output/c21e1072/transcode.mp4' }), []);
  });

  test('several bad ports are all named, not just the first', () => {
    const problems = checkRunBody({ video: '$program', audio: 'clp_1' });
    assert.equal(problems.length, 2);
    const said = describeProblems(problems);
    assert.match(said, /video:/);
    assert.match(said, /audio:/);
  });
});

/**
 * The check runs over the BODY, not over the bindings.
 *
 * This is the defect the user saw on screen: every subtitle run failed before
 * it started, saying `selection: clp_tevzon7u is an id inside the document,
 * not a file in storage. Use $source.` The advice was correct and the key was
 * not in the request. The shell seeds `selection` with the selected clip's id
 * for the benefit of local timeline ops, the check was handed the whole
 * bindings object, and it reported on a value nothing was going to send.
 *
 * Both halves are worth pinning, because the same mistake in the other
 * direction is silent: over the bindings, `checkOperationInput` found nothing
 * to object to either, since the bindings have no port named `input`. The
 * check that fired falsely on pipelines did not fire at all on operations.
 */
describe('a check of the bindings is not a check of the request', () => {
  const bindings = {
    selection: 'clp_tevzon7u',
    playhead: 0,
    timeline: { tracks: [] },
    source: 'input/2026-09-16/a.mp4',
  };

  test('a seeded clip id nothing sends is not a problem with the run', () => {
    // what the shell knows
    assert.equal(checkRunBody(bindings).length, 1, 'the bindings alone do look wrong');
    // what the step actually posts, once $source has resolved
    assert.deepEqual(checkRunBody({ video: bindings.source }), []);
  });

  test('an operation is checked on its ports, which the bindings do not have', () => {
    assert.deepEqual(
      checkOperationInput('whisperx', 'subtitle', bindings),
      [],
      'no port called `input` in there, so checking the bindings checks nothing',
    );
    assert.equal(
      checkOperationInput('whisperx', 'subtitle', { input: '$source' }).length,
      1,
      'and the body is where an unresolved binding is actually visible',
    );
  });
});
