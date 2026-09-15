/**
 * Opening a pipeline that is already in the account.
 *
 * There is no `GET /v1/pipelines`, so the id is the only handle on one and
 * everything here is about not losing it. The reply shape asserted below was
 * read off the live API rather than off the `Pipeline` type, which does not
 * mention `currentVersion` and would not have caught a body that came back
 * without a graph on it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pipelineIdFrom, readPipelineReply } from '../lib/editor-api/pipeline-ref.ts';

/** A real reply, trimmed. The ids and the field names are as they arrive. */
const REPLY = {
  id: 'tpl_04LUIcgXi_yU',
  name: 'Cutroom export proof',
  description: null,
  version: 1,
  published: true,
  currentVersion: 1,
  etag: '50763eb532f2818d3d3db0d60e40f51b',
  compiles: true,
  issues: [],
  graph: {
    version: 1,
    nodes: [{ id: 'in1', kind: 'input', name: 'video', type: 'file:video', position: { x: 0, y: 0 }, required: true }],
    edges: [],
  },
};

describe('finding the id in whatever it was pasted inside', () => {
  test('a bare id is the id', () => {
    assert.equal(pipelineIdFrom('tpl_75e1fLGX64dF'), 'tpl_75e1fLGX64dF');
  });

  test('whitespace around it does not make it a different id', () => {
    assert.equal(pipelineIdFrom('  tpl_75e1fLGX64dF \n'), 'tpl_75e1fLGX64dF');
  });

  test('ids carry hyphens, and the hyphen is part of the id', () => {
    assert.equal(pipelineIdFrom('tpl_sf-77VmRwbwX'), 'tpl_sf-77VmRwbwX');
  });

  test('a url is where a person copies one from', () => {
    assert.equal(
      pipelineIdFrom('https://worker.aisuite.run/v1/pipelines/tpl_04LUIcgXi_yU'),
      'tpl_04LUIcgXi_yU',
    );
  });

  test('a line lifted out of a card or a log still has the id in it', () => {
    assert.equal(pipelineIdFrom('"pipelineId": "tpl_75e1fLGX64dF",'), 'tpl_75e1fLGX64dF');
    assert.equal(pipelineIdFrom('  pipeline tpl_04LUIcgXi_yU'), 'tpl_04LUIcgXi_yU');
  });

  test('an id in a shape we have not seen is still taken, because the server decides', () => {
    // refusing an id here that the API would have accepted locks someone out
    // of their own pipeline, and this function cannot know what ids look like
    // next year
    assert.equal(pipelineIdFrom('pipe_ABC123'), 'pipe_ABC123');
    assert.equal(pipelineIdFrom('https://example.test/x/pipe_ABC123'), 'pipe_ABC123');
  });

  test('nothing, and prose with no id in it, are both null', () => {
    assert.equal(pipelineIdFrom(''), null);
    assert.equal(pipelineIdFrom('   '), null);
    assert.equal(pipelineIdFrom('the one I published yesterday'), null);
  });
});

describe('reading what came back', () => {
  test('a real reply becomes a pipeline with its graph', () => {
    const read = readPipelineReply(REPLY);
    assert.ok(!('error' in read), 'the live shape has to be readable');
    const p = read.pipeline;
    assert.equal(p.id, 'tpl_04LUIcgXi_yU');
    assert.equal(p.name, 'Cutroom export proof');
    assert.equal(p.published, true);
    assert.equal(p.compiles, true);
    assert.equal(p.issueCount, 0);
    assert.equal(p.version, 1);
    assert.equal(p.graph.nodes.length, 1, 'the graph is nested, not the body');
  });

  test('the 404 body says why, and the reason is not swallowed', () => {
    const read = readPipelineReply({ error: { code: 'not_found', message: 'pipeline not found' } });
    assert.ok('error' in read);
    assert.equal(read.error, 'pipeline not found');
  });

  test('our own route answers a plain string error, which is also a reason', () => {
    const read = readPipelineReply({ error: 'no pipeline "tpl_nope" in this account' });
    assert.ok('error' in read);
    assert.match(read.error, /tpl_nope/);
  });

  test('a body with no graph is refused rather than loaded as an empty one', () => {
    // the trap: treating the body AS the graph. It has no nodes array, so the
    // canvas would clear itself and report success
    const read = readPipelineReply({ id: 'tpl_x', name: 'x', nodes: [], edges: [] });
    assert.ok('error' in read, 'the body is not the graph');
    assert.match(read.error, /not a pipeline graph/);
  });

  test('a pipeline with an empty graph is a real answer and is said out loud', () => {
    const read = readPipelineReply({ ...REPLY, graph: { version: 1, nodes: [], edges: [] } });
    assert.ok(!('error' in read), 'empty is not the same as malformed');
    assert.equal(read.pipeline.graph.nodes.length, 0);
  });

  test('nothing at all does not throw', () => {
    for (const junk of [null, undefined, '', 0, [], 'not json']) {
      const read = readPipelineReply(junk);
      assert.ok('error' in read, `${JSON.stringify(junk)} is not a pipeline`);
    }
  });

  test('a nameless pipeline shows its id rather than an empty heading', () => {
    const read = readPipelineReply({ ...REPLY, name: '   ' });
    assert.ok(!('error' in read));
    assert.equal(read.pipeline.name, 'tpl_04LUIcgXi_yU');
  });
});
