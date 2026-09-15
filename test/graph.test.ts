import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GraphBuilder, preflight, analyseFanOut, topoSort, edge, type Graph } from '../lib/editor-api/graph.ts';

/** Positions are required by the server; hand-built test graphs need one. */
const P = { x: 0, y: 0 };
import { NODE_LIST, getNode, portSurface, validateParams, fansOut } from '../lib/editor-api/catalogue.ts';

const codes = (g: Graph) => preflight(g).map((d) => d.code).sort();

describe('the catalogue answers what the compiler needs', () => {
  test('116 nodes across 10 engines', () => {
    assert.equal(NODE_LIST.length, 116);
    assert.equal(new Set(NODE_LIST.map((n) => n.engine)).size, 10);
  });

  test('the port surface includes bindable params, not just declared inputs', () => {
    const s = portSurface(getNode('ffmpeg/concat')!);
    assert.ok(s.has('inputs'), 'declared input');
    assert.ok(s.has('reencode'), 'bindable param is addressable by a wire');
  });

  test('a param-decided arity resolves from the params', () => {
    assert.equal(fansOut('ffmpeg/thumbnail', 'frames', { count: 1 }), false);
    assert.equal(fansOut('ffmpeg/thumbnail', 'frames', { count: 5 }), true);
  });

  test('param validation catches the shapes models get wrong', () => {
    assert.deepEqual(validateParams('ffmpeg/thumbnail', { input: 'k', count: 5 }), []);
    const bad = validateParams('ffmpeg/thumbnail', { input: 'k', count: 500 });
    assert.equal(bad[0]?.code, 'range');
    const enumErr = validateParams('ffmpeg/thumbnail', { input: 'k', format: 'tiff' });
    assert.equal(enumErr[0]?.code, 'enum');
    const missing = validateParams('ffmpeg/thumbnail', {});
    assert.equal(missing[0]?.code, 'missing');
  });

  test('a wired param satisfies required without a literal', () => {
    assert.deepEqual(validateParams('ffmpeg/thumbnail', {}, ['input']), []);
  });
});

describe('preflight reproduces the compiler offline', () => {
  test('a sound graph is clean', () => {
    const b = new GraphBuilder();
    const src = b.input('video', 'file:video');
    const thumbs = b.op('ffmpeg', 'thumbnail', { count: 4, width: 320 });
    const out = b.output(['frames']);
    b.wire(src, 'value', thumbs, 'input').wire(thumbs, 'frames', out, 'frames');
    assert.deepEqual(preflight(b.build()), []);
  });

  test('unknown operation', () => {
    const g: Graph = { version: 1, nodes: [
      { id: 'x', kind: 'engine', engine: 'ffmpeg', operation: 'deflicker', params: {}, position: P },
      { id: 'out1', kind: 'output', fields: ['f'], position: P },
    ], edges: [] };
    assert.ok(codes(g).includes('unknown_engine'));
  });

  test('unknown port, with a suggestion of the real ones', () => {
    const b = new GraphBuilder();
    const src = b.input('video', 'file:video');
    const probe = b.op('ffmpeg', 'probe');
    const out = b.output(['format']);
    b.wire(src, 'value', probe, 'inpt').wire(probe, 'format', out, 'format');
    const d = preflight(b.build()).find((x) => x.code === 'unknown_port');
    assert.ok(d, 'reported');
    assert.match(d!.message, /no input or bindable param "inpt"/);
  });

  test('type mismatch between a port and what it accepts', () => {
    const b = new GraphBuilder();
    const src = b.input('words', 'text');
    const probe = b.op('ffmpeg', 'probe');
    const out = b.output(['format']);
    b.wire(src, 'value', probe, 'input').wire(probe, 'format', out, 'format');
    const d = preflight(b.build()).find((x) => x.code === 'type_mismatch');
    assert.ok(d, 'text into a file:video port is caught');
  });

  test('two wires into one scalar port', () => {
    const b = new GraphBuilder();
    const a = b.input('a', 'file:video');
    const c = b.input('b', 'file:video');
    const probe = b.op('ffmpeg', 'probe');
    const out = b.output(['format']);
    b.wire(a, 'value', probe, 'input').wire(c, 'value', probe, 'input').wire(probe, 'format', out, 'format');
    assert.ok(codes(b.build()).includes('port_overwired'));
  });

  test('but a list input may take many wires: that is what it is for', () => {
    const b = new GraphBuilder();
    const a = b.input('a', 'file:video');
    const c = b.input('b', 'file:video');
    const cat = b.op('ffmpeg', 'concat');
    const out = b.output(['file']);
    b.wire(a, 'value', cat, 'inputs').wire(c, 'value', cat, 'inputs').wire(cat, 'file', out, 'file');
    assert.ok(!codes(b.build()).includes('port_overwired'));
  });

  test('a param given both a literal and a wire', () => {
    const b = new GraphBuilder();
    const src = b.input('video', 'file:video');
    const th = b.op('ffmpeg', 'thumbnail', { input: 'some-key', count: 2 });
    const out = b.output(['frames']);
    b.wire(src, 'value', th, 'input').wire(th, 'frames', out, 'frames');
    assert.ok(codes(b.build()).includes('param_and_wire'));
  });

  test('a cycle is refused, and named', () => {
    const g: Graph = { version: 1, nodes: [
      { id: 'a', kind: 'engine', engine: 'util', operation: 'merge', params: {}, position: P },
      { id: 'b', kind: 'engine', engine: 'util', operation: 'merge', params: {}, position: P },
      { id: 'out1', kind: 'output', fields: ['value'], position: P },
    ], edges: [
      edge({ node: 'a', port: 'value' }, { node: 'b', port: 'a' }),
      edge({ node: 'b', port: 'value' }, { node: 'a', port: 'a' }),
    ] };
    const d = preflight(g).find((x) => x.code === 'cycle');
    assert.ok(d);
    assert.match(d!.message, /iteration belongs in the executor/);
  });

  test('duplicate input names', () => {
    const g: Graph = { version: 1, nodes: [
      { id: 'i1', kind: 'input', name: 'video', type: 'file:video', required: true, position: P },
      { id: 'i2', kind: 'input', name: 'video', type: 'file:video', required: true, position: P },
      { id: 'out1', kind: 'output', fields: ['x'], position: P },
    ], edges: [] };
    assert.ok(codes(g).includes('input_name'));
  });

  test('the shape is checked before anything else, because the server 400s on it', () => {
    // both of these were found by the server rejecting a graph outright
    const missingPosition: Graph = { version: 1, nodes: [
      { id: 'i1', kind: 'input', name: 'v', type: 'file:video', required: true } as never,
    ], edges: [] };
    assert.match(preflight(missingPosition)[0].message, /no position/);

    const missingRequired: Graph = { version: 1, nodes: [
      { id: 'i1', kind: 'input', name: 'v', type: 'file:video', position: P } as never,
    ], edges: [] };
    assert.match(preflight(missingRequired)[0].message, /required: true or false/);
  });

  test('a graph with no output produces nothing', () => {
    const g: Graph = { version: 1, nodes: [{ id: 'i1', kind: 'input', name: 'v', type: 'file:video', required: true, position: P }], edges: [] };
    assert.ok(codes(g).includes('output_node'));
  });
});

describe('fan-out: the only iteration the graph has', () => {
  test('a list output into a scalar input iterates the whole subgraph', () => {
    const b = new GraphBuilder();
    const src = b.input('video', 'file:video');
    const th = b.op('ffmpeg', 'thumbnail', { count: 6 });
    const cap = b.op('imagemagick', 'caption', { text: 'hi' });
    const out = b.output(['file']);
    b.wire(src, 'value', th, 'input').wire(th, 'frames', cap, 'input').wire(cap, 'file', out, 'file');
    const g = b.build();
    const fan = analyseFanOut(g);
    assert.ok(fan.iterated.has(cap), 'the node fed by the fan-out is iterated');
    assert.deepEqual(preflight(g), [], 'one iterated port is legal');
  });

  test('count:1 does not fan out, so nothing downstream iterates', () => {
    const b = new GraphBuilder();
    const src = b.input('video', 'file:video');
    const th = b.op('ffmpeg', 'thumbnail', { count: 1 });
    const cap = b.op('imagemagick', 'caption', { text: 'hi' });
    const out = b.output(['file']);
    b.wire(src, 'value', th, 'input').wire(th, 'frames', cap, 'input').wire(cap, 'file', out, 'file');
    assert.ok(!analyseFanOut(b.build()).iterated.has(cap));
  });

  test('fan_out_twice: the move everyone reaches for, and cannot have', () => {
    // "measure each segment, then trim each by its own measurement" needs a
    // zip. There isn't one: both wires would iterate the same node.
    const b = new GraphBuilder();
    const src = b.input('video', 'file:video');
    const a = b.op('ffmpeg', 'thumbnail', { count: 4 });
    const c = b.op('ffmpeg', 'thumbnail', { count: 4, atSec: 1 });
    const cap = b.op('imagemagick', 'composite');
    const out = b.output(['file']);
    b.wire(src, 'value', a, 'input').wire(src, 'value', c, 'input')
     .wire(a, 'frames', cap, 'base').wire(c, 'frames', cap, 'overlay')
     .wire(cap, 'file', out, 'file');
    const d = preflight(b.build()).find((x) => x.code === 'fan_out_twice');
    assert.ok(d, 'caught without a round trip');
    assert.match(d!.message, /no zip/);
  });

  test('a list input collapses a fan-out instead of iterating', () => {
    const b = new GraphBuilder();
    const src = b.input('video', 'file:video');
    const th = b.op('ffmpeg', 'thumbnail', { count: 8 });
    const cat = b.op('ffmpeg', 'concat');
    const out = b.output(['file']);
    b.wire(src, 'value', th, 'input').wire(th, 'frames', cat, 'inputs').wire(cat, 'file', out, 'file');
    const g = b.build();
    assert.ok(!analyseFanOut(g).iterated.has(cat), 'concat gathers, it does not iterate');
  });

  test('topological order puts producers before consumers', () => {
    const b = new GraphBuilder();
    const src = b.input('video', 'file:video');
    const th = b.op('ffmpeg', 'thumbnail', { count: 2 });
    const out = b.output(['frames']);
    b.wire(src, 'value', th, 'input').wire(th, 'frames', out, 'frames');
    const r = topoSort(b.build());
    assert.ok('order' in r);
    const o = (r as { order: string[] }).order;
    assert.ok(o.indexOf(src) < o.indexOf(th) && o.indexOf(th) < o.indexOf(out));
  });
});
