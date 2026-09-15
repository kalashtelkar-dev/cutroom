/**
 * Building a graph by hand.
 *
 * The rules a click has to obey are the compiler's rules, which is why they
 * live in a module and not in a handler: a wire the canvas allows and the
 * compiler refuses is a round trip spent to be told something that was
 * knowable before the mouse came up.
 *
 * Every test here ends by running `preflight()` over the result where it can,
 * because "the editor let me draw it" and "it compiles" are different claims.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  addInput, addOperation, addOutput, canWire, emptyGraph, freeId, inPorts,
  moveNode, outPorts, removeNode, searchOperations, setParams, unwire, wire,
} from '../lib/editor-api/edit-graph.ts';
import { preflight } from '../lib/editor-api/graph.ts';
import { NODE_LIST } from '../lib/editor-api/catalogue.ts';

const at = (x: number, y: number) => ({ x, y });

/** input(video) -> ffmpeg/extract-audio -> output(audio), built by hand. */
function built() {
  let g = emptyGraph();
  g = addInput(g, 'video', 'file:video', at(0, 0));
  g = addOperation(g, 'ffmpeg/extract-audio', at(240, 0));
  g = addOutput(g, ['audio'], at(480, 0));
  const [src, op, out] = g.nodes.map((n) => n.id);
  g = wire(g, { node: src, port: 'value' }, { node: op, port: 'input' });
  g = wire(g, { node: op, port: 'file' }, { node: out, port: 'audio' });
  return { g, src, op, out };
}

describe('a graph built by hand', () => {
  test('starts empty, which is a state the editor has to survive', () => {
    const g = emptyGraph();
    assert.deepEqual(g.nodes, []);
    assert.deepEqual(g.edges, []);
  });

  test('three nodes and two wires make something that compiles', () => {
    const { g } = built();
    assert.equal(g.nodes.length, 3);
    assert.equal(g.edges.length, 2);
    assert.deepEqual(preflight(g), [], 'the graph the editor built does not compile');
  });

  test('every node it places carries a position and inputs carry required', () => {
    const { g } = built();
    for (const n of g.nodes) {
      assert.ok(n.position && Number.isFinite(n.position.x), `${n.id} has no position`);
      if (n.kind === 'input') {
        assert.equal(typeof n.required, 'boolean', `${n.id}.required is not a boolean`);
      }
    }
  });

  test('ids do not collide, however many of the same operation are placed', () => {
    let g = emptyGraph();
    for (let i = 0; i < 5; i += 1) g = addOperation(g, 'ffmpeg/trim', at(i * 40, 0));
    const ids = g.nodes.map((n) => n.id);
    assert.equal(new Set(ids).size, 5, `duplicate id in ${ids.join(', ')}`);
  });
});

describe('a wire is refused before it is drawn, with a reason', () => {
  test('a node cannot feed itself', () => {
    const { g, op } = built();
    const v = canWire(g, { node: op, port: 'file' }, { node: op, port: 'input' });
    assert.equal(v.ok, false);
    assert.match(v.why ?? '', /itself/);
  });

  test('nothing leaves an output node and nothing arrives at an input node', () => {
    const { g, src, out } = built();
    assert.equal(canWire(g, { node: out, port: 'audio' }, { node: src, port: 'value' }).ok, false);
    const back = canWire(g, { node: out, port: 'audio' }, { node: src, port: 'value' });
    assert.match(back.why ?? '', /output node|end of the line/);
  });

  test('a type mismatch says which types, not just "no"', () => {
    let g = emptyGraph();
    g = addInput(g, 'sound', 'file:audio', at(0, 0));
    g = addOperation(g, 'ffmpeg/crop', at(200, 0));   // crop takes file:video
    const [src, op] = g.nodes.map((n) => n.id);
    const v = canWire(g, { node: src, port: 'value' }, { node: op, port: 'input' });
    assert.equal(v.ok, false);
    assert.match(v.why ?? '', /file:video/);
    assert.match(v.why ?? '', /file:audio/);
  });

  test('a scalar input takes one wire, because a second would overwrite it', () => {
    let g = emptyGraph();
    g = addInput(g, 'a', 'file:video', at(0, 0));
    g = addInput(g, 'b', 'file:video', at(0, 90));
    g = addOperation(g, 'ffmpeg/extract-audio', at(240, 0));
    const [a, b, op] = g.nodes.map((n) => n.id);
    g = wire(g, { node: a, port: 'value' }, { node: op, port: 'input' });
    const v = canWire(g, { node: b, port: 'value' }, { node: op, port: 'input' });
    assert.equal(v.ok, false);
    assert.match(v.why ?? '', /already has a wire/);
  });

  test('a loop is refused, because the graph is a strict DAG', () => {
    let g = emptyGraph();
    g = addInput(g, 'v', 'file:video', at(0, 0));
    g = addOperation(g, 'ffmpeg/trim', at(200, 0));
    g = addOperation(g, 'ffmpeg/transcode', at(400, 0));
    const [src, a, b] = g.nodes.map((n) => n.id);
    g = wire(g, { node: src, port: 'value' }, { node: a, port: 'input' });
    g = wire(g, { node: a, port: 'file' }, { node: b, port: 'input' });
    const v = canWire(g, { node: b, port: 'file' }, { node: a, port: 'input' });
    assert.equal(v.ok, false);
    assert.match(v.why ?? '', /loop|DAG/);
  });

  test('the same wire twice is refused', () => {
    const { g, src, op } = built();
    const v = canWire(g, { node: src, port: 'value' }, { node: op, port: 'input' });
    assert.equal(v.ok, false);
    assert.match(v.why ?? '', /already there/);
  });

  test('a port that does not exist is named, not shrugged at', () => {
    const { g, src, op } = built();
    const v = canWire(g, { node: src, port: 'value' }, { node: op, port: 'nonsense' });
    assert.equal(v.ok, false);
    assert.match(v.why ?? '', /nonsense/);
  });

  test('wire() throws exactly what canWire refused, so neither can drift', () => {
    const { g, op } = built();
    const v = canWire(g, { node: op, port: 'file' }, { node: op, port: 'input' });
    assert.throws(() => wire(g, { node: op, port: 'file' }, { node: op, port: 'input' }),
      (e: Error) => { assert.equal(e.message, v.why); return true; });
  });
});

describe('ports come off the catalogue, not off a hand-written table', () => {
  test('an operation reports the ports its spec declares', () => {
    let g = emptyGraph();
    g = addOperation(g, 'ffmpeg/extract-audio', at(0, 0));
    const n = g.nodes[0];
    assert.deepEqual(inPorts(n).map((p) => p.name), ['input']);
    assert.deepEqual(outPorts(n).map((p) => p.name), ['file']);
    assert.deepEqual(inPorts(n)[0].accepts, ['file:video', 'file:audio']);
  });

  test('an input node has one out port and no in ports', () => {
    let g = emptyGraph();
    g = addInput(g, 'video', 'file:video', at(0, 0));
    assert.deepEqual(outPorts(g.nodes[0]).map((p) => p.name), ['value']);
    assert.deepEqual(inPorts(g.nodes[0]), []);
  });

  test('an output node has one in port per field', () => {
    let g = emptyGraph();
    g = addOutput(g, ['audio', 'text'], at(0, 0));
    assert.deepEqual(inPorts(g.nodes[0]).map((p) => p.name), ['audio', 'text']);
    assert.deepEqual(outPorts(g.nodes[0]), []);
  });

  test('a list port is reported as one, since it collects a fan-out', () => {
    let g = emptyGraph();
    g = addOperation(g, 'ffmpeg/concat', at(0, 0));
    const collects = inPorts(g.nodes[0]).filter((p) => p.list);
    assert.ok(collects.length, 'concat has no list input, which cannot be right');
  });
});

describe('taking things away', () => {
  test('deleting a node takes its wires with it, leaving no dangling edge', () => {
    const { g, op } = built();
    const after = removeNode(g, op);
    assert.equal(after.nodes.length, 2);
    assert.deepEqual(after.edges, [], 'a wire outlived the node it was attached to');
  });

  test('unwiring leaves the nodes alone', () => {
    const { g } = built();
    const after = unwire(g, g.edges[0].id);
    assert.equal(after.nodes.length, 3);
    assert.equal(after.edges.length, 1);
  });

  test('moving a node changes only its position', () => {
    const { g, op } = built();
    const after = moveNode(g, op, at(999, 111));
    const moved = after.nodes.find((n) => n.id === op);
    assert.deepEqual(moved?.position, { x: 999, y: 111 });
    assert.equal(after.edges.length, g.edges.length);
  });

  test('params reach the node, and only that node', () => {
    const { g, op } = built();
    const after = setParams(g, op, { codec: 'wav' });
    const n = after.nodes.find((x) => x.id === op) as { params?: Record<string, unknown> };
    assert.deepEqual(n.params, { codec: 'wav' });
    assert.deepEqual(preflight(after), []);
  });
});

describe('the palette', () => {
  test('an empty query offers everything in the catalogue', () => {
    assert.equal(searchOperations('', NODE_LIST).length, NODE_LIST.length);
  });

  test('a query narrows it, and finds by summary as well as by name', () => {
    const byName = searchOperations('extract-audio', NODE_LIST);
    assert.ok(byName.includes('ffmpeg/extract-audio'));
    assert.ok(byName.length < NODE_LIST.length, 'the query narrowed nothing');

    const bySummary = searchOperations('subtitle', NODE_LIST);
    assert.ok(bySummary.length, 'nothing matched a word that is in several summaries');
  });

  test('a query that matches nothing offers nothing, rather than everything', () => {
    assert.deepEqual(searchOperations('zzzznotathing', NODE_LIST), []);
  });

  test('freeId never returns something already taken', () => {
    const { g } = built();
    for (const n of g.nodes) assert.notEqual(freeId(g, n.id), n.id);
  });
});
