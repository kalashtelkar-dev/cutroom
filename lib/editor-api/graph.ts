/**
 * Pipeline graphs: the shape, and everything we can check about one without
 * asking the server.
 *
 * `POST /v1/pipelines/validate` is the authority and it is free, it compiles
 * a graph and returns the errors without storing anything. But it is a round
 * trip, and when a model is repairing a graph the difference between a local
 * answer and a 300ms answer is the difference between three repair rounds
 * that feel instant and three that do not. So we reproduce what the catalogue
 * already knows, and let the server have the last word.
 *
 * The rule that matters most is the fan-out rule, because it is the only form
 * of iteration the graph has and it is easy to violate by accident:
 *
 *   a multi-valued output wired into a scalar input runs that node, and its
 *   whole downstream subgraph, once per item. A node may be iterated on AT
 *   MOST ONE input, a second is `fan_out_twice`, and there is no zip. An
 *   input marked `list: true` collects the items instead, which is how a
 *   fan-out is joined back together.
 */
import {
  fansOut, getNode, outPort, portSurface, requireNode, validateParams, wireTarget,
} from './catalogue.ts';

export interface XY { x: number; y: number }

/**
 * Every node carries a position and the server requires it, a graph without
 * one is rejected as "not a pipeline graph" before it is ever compiled. The
 * canvas is part of the document, not a view over it, so anything generating
 * a graph has to lay it out. `GraphBuilder.build()` does that for you.
 */

export interface InputNode {
  id: string;
  kind: 'input';
  name: string;
  type: string;
  /** Required by the server, and it means it: `undefined` is a 400. */
  required: boolean;
  position: XY;
}
export interface OutputNode {
  id: string;
  kind: 'output';
  fields: string[];
  position: XY;
}
export interface EngineNode {
  id: string;
  kind: 'engine';
  engine: string;
  operation: string;
  params: Record<string, unknown>;
  position: XY;
}
export type GraphNode = InputNode | OutputNode | EngineNode;

export interface EdgeEnd { node: string; port: string }
export interface GraphEdge { id: string; from: EdgeEnd; to: EdgeEnd }

export interface Graph {
  version: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const edgeId = (from: EdgeEnd, to: EdgeEnd) =>
  `${from.node}.${from.port}->${to.node}.${to.port}`;

export const edge = (from: EdgeEnd, to: EdgeEnd): GraphEdge => ({ id: edgeId(from, to), from, to });

export const isEngine = (n: GraphNode): n is EngineNode => n.kind === 'engine';
export const nodeOp = (n: EngineNode) => `${n.engine}/${n.operation}`;

// ── diagnostics ─────────────────────────────────────────────────────────

/**
 * The compiler's own error codes. We emit the subset answerable offline so a
 * repair prompt reads the same whether the diagnosis came from here or from
 * the server.
 */
export type DiagnosticCode =
  | 'unknown_engine' | 'unknown_port' | 'bad_param' | 'param_and_wire'
  | 'port_overwired' | 'cycle' | 'fan_out_twice' | 'type_mismatch'
  | 'input_name' | 'output_node' | 'bad_edge' | 'port_unavailable'
  /** Local only: the shape is wrong, so the server would 400 before compiling. */
  | 'bad_node';

export interface Diagnostic {
  code: DiagnosticCode;
  node?: string;
  port?: string;
  edge?: string;
  message: string;
}

/** Type compatibility. `any` and `connection` match everything. */
function typesCompatible(outType: string, accepts: string[]): boolean {
  if (!accepts.length) return true;
  if (outType === 'any' || outType === 'connection') return true;
  if (accepts.includes('any') || accepts.includes('connection')) return true;
  return accepts.includes(outType);
}

interface FanInfo {
  /** Nodes that run once per item because something upstream fans out. */
  iterated: Set<string>;
  /** node id -> the in-ports it is iterated on (more than one is an error). */
  iteratedPorts: Map<string, Set<string>>;
}

/**
 * Propagate fan-out through the graph.
 *
 * An edge fans when its source carries many values and its destination takes
 * one. A source carries many values when its out port is a list port, or when
 * its own node is already being iterated. A `list: true` destination collects
 * instead, which stops the propagation there.
 */
export function analyseFanOut(g: Graph): FanInfo {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of g.edges) {
    const list = incoming.get(e.to.node) ?? [];
    list.push(e);
    incoming.set(e.to.node, list);
  }

  const iterated = new Set<string>();
  const iteratedPorts = new Map<string, Set<string>>();
  const state = new Map<string, 'visiting' | 'done'>();

  const multiOut = (nodeId: string, port: string): boolean => {
    const n = byId.get(nodeId);
    if (!n) return false;
    if (isEngine(n)) {
      const spec = getNode(nodeOp(n));
      if (spec) {
        const o = outPort(spec, port);
        if (o) {
          const isList = o.list === 'depends'
            ? safeFansOut(nodeOp(n), port, n.params)
            : o.list === true;
          if (isList) return true;
        }
      }
    }
    return visit(nodeId); // an iterated node makes every one of its outputs multi
  };

  function visit(nodeId: string): boolean {
    if (state.get(nodeId) === 'done') return iterated.has(nodeId);
    if (state.get(nodeId) === 'visiting') return false; // a cycle; reported separately
    state.set(nodeId, 'visiting');

    const ports = new Set<string>();
    for (const e of incoming.get(nodeId) ?? []) {
      const target = byId.get(nodeId);
      let collects = false;
      if (target && isEngine(target)) {
        const spec = getNode(nodeOp(target));
        const t = spec ? wireTarget(spec, e.to.port) : null;
        collects = t?.list === true;
      }
      if (!collects && multiOut(e.from.node, e.from.port)) ports.add(e.to.port);
    }

    state.set(nodeId, 'done');
    if (ports.size) {
      iterated.add(nodeId);
      iteratedPorts.set(nodeId, ports);
    }
    return ports.size > 0;
  }

  for (const n of g.nodes) visit(n.id);
  return { iterated, iteratedPorts };
}

function safeFansOut(key: string, port: string, params: Record<string, unknown>): boolean {
  try { return fansOut(key, port, params); } catch { return true; } // unknown: assume many
}

/** Nodes in dependency order, or the cycle that prevents one. */
export function topoSort(g: Graph): { order: string[] } | { cycle: string[] } {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const deps = new Map<string, Set<string>>(g.nodes.map((n) => [n.id, new Set<string>()]));
  for (const e of g.edges) {
    if (byId.has(e.from.node) && byId.has(e.to.node)) deps.get(e.to.node)!.add(e.from.node);
  }
  const order: string[] = [];
  const mark = new Map<string, 'grey' | 'black'>();
  const stack: string[] = [];

  const walk = (id: string): string[] | null => {
    if (mark.get(id) === 'black') return null;
    if (mark.get(id) === 'grey') return [...stack.slice(stack.indexOf(id)), id];
    mark.set(id, 'grey');
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      const c = walk(d);
      if (c) return c;
    }
    stack.pop();
    mark.set(id, 'black');
    order.push(id);
    return null;
  };

  for (const n of g.nodes) {
    const c = walk(n.id);
    if (c) return { cycle: c };
  }
  return { order };
}

/**
 * Everything we can decide about a graph offline.
 *
 * A clean result here is not a promise that the server will compile it,
 * `POST /v1/pipelines/validate` is still the authority, and some codes
 * (`port_unavailable`, capacity, engine-version mismatches) only it can
 * answer. A dirty result, though, is worth acting on without asking.
 */
/**
 * The structural pass.
 *
 * The server checks a graph in two stages: shape first (it answers 400,
 * "that is not a pipeline graph"), then compilation. Shape failures are the
 * ones that look most like a server bug from the outside, because they come
 * back before any of the useful diagnostics, so we check them here and say
 * exactly which field is missing. Both of these were found the hard way:
 * every node needs a `position`, and an input node needs a boolean
 * `required`.
 */
function structural(g: Graph): Diagnostic[] {
  const out: Diagnostic[] = [];
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

  g.nodes.forEach((n, i) => {
    const at = n?.id ?? `nodes[${i}]`;
    if (!n || typeof n.id !== 'string' || !n.id) {
      out.push({ code: 'bad_node', node: at, message: `nodes[${i}] has no id` });
      return;
    }
    if (!n.position || !num(n.position.x) || !num(n.position.y)) {
      out.push({ code: 'bad_node', node: at, message: `"${at}" has no position, every node needs one, even a generated graph` });
    }
    if (n.kind === 'input') {
      if (!n.name) out.push({ code: 'bad_node', node: at, message: `input "${at}" has no name` });
      if (!n.type) out.push({ code: 'bad_node', node: at, message: `input "${at}" has no type` });
      if (typeof n.required !== 'boolean') {
        out.push({ code: 'bad_node', node: at, message: `input "${at}" needs required: true or false, undefined is rejected` });
      }
    } else if (n.kind === 'output') {
      if (!Array.isArray(n.fields)) out.push({ code: 'bad_node', node: at, message: `output "${at}" needs a fields array` });
    } else if (n.kind === 'engine') {
      if (!n.engine || !n.operation) out.push({ code: 'bad_node', node: at, message: `"${at}" needs an engine and an operation` });
      if (n.params != null && typeof n.params !== 'object') {
        out.push({ code: 'bad_node', node: at, message: `"${at}" params must be an object` });
      }
    } else {
      out.push({ code: 'bad_node', node: at, message: `"${at}" has an unknown kind "${(n as { kind: string }).kind}"` });
    }
  });

  g.edges.forEach((e, i) => {
    if (!e?.from?.node || !e?.from?.port || !e?.to?.node || !e?.to?.port) {
      out.push({ code: 'bad_edge', edge: e?.id ?? `edges[${i}]`, message: `edges[${i}] needs from.node, from.port, to.node and to.port` });
    }
  });

  return out;
}

export function preflight(g: Graph): Diagnostic[] {
  // shape first: with a malformed node, every later check is noise
  const shape = structural(g);
  if (shape.length) return shape;

  const out: Diagnostic[] = [];
  const byId = new Map<string, GraphNode>();

  for (const n of g.nodes) {
    if (byId.has(n.id)) {
      out.push({ code: 'bad_edge', node: n.id, message: `duplicate node id "${n.id}"` });
    }
    byId.set(n.id, n);
  }

  // inputs must have distinct names, they become the request schema
  const inputNames = new Map<string, string>();
  for (const n of g.nodes) {
    if (n.kind !== 'input') continue;
    const prev = inputNames.get(n.name);
    if (prev) {
      out.push({
        code: 'input_name', node: n.id,
        message: `two inputs are both named "${n.name}" (${prev} and ${n.id})`,
      });
    }
    inputNames.set(n.name, n.id);
  }

  const outputs = g.nodes.filter((n) => n.kind === 'output');
  if (outputs.length === 0) {
    out.push({ code: 'output_node', message: 'the graph has no output node, so it produces nothing' });
  }

  // edges: endpoints exist, ports exist, types line up, no double-wiring
  const intoPort = new Map<string, GraphEdge[]>();
  for (const e of g.edges) {
    const src = byId.get(e.from.node);
    const dst = byId.get(e.to.node);
    if (!src || !dst) {
      out.push({
        code: 'bad_edge', edge: e.id,
        message: `edge ${e.id} references ${!src ? e.from.node : e.to.node}, which is not in the graph`,
      });
      continue;
    }

    let srcType: string | null = null;
    if (src.kind === 'input') {
      if (e.from.port !== 'value') {
        out.push({ code: 'unknown_port', node: src.id, port: e.from.port, edge: e.id,
          message: `input nodes have one output port, "value", not "${e.from.port}"` });
      }
      srcType = src.type;
    } else if (src.kind === 'engine') {
      const spec = getNode(nodeOp(src));
      const o = spec && outPort(spec, e.from.port);
      if (spec && !o) {
        out.push({ code: 'unknown_port', node: src.id, port: e.from.port, edge: e.id,
          message: `${nodeOp(src)} has no output "${e.from.port}" (it has ${spec.out.map((p) => p.name).join(', ')})` });
      }
      srcType = o?.type ?? null;
    } else {
      out.push({ code: 'bad_edge', edge: e.id, message: 'an output node cannot be a source' });
    }

    if (dst.kind === 'output') {
      if (!dst.fields.includes(e.to.port)) {
        out.push({ code: 'unknown_port', node: dst.id, port: e.to.port, edge: e.id,
          message: `output node "${dst.id}" has no field "${e.to.port}"` });
      }
    } else if (dst.kind === 'engine') {
      const spec = getNode(nodeOp(dst));
      if (spec) {
        const target = wireTarget(spec, e.to.port);
        if (!target) {
          const surface = [...portSurface(spec)].slice(0, 8).join(', ');
          out.push({ code: 'unknown_port', node: dst.id, port: e.to.port, edge: e.id,
            message: `${nodeOp(dst)} has no input or bindable param "${e.to.port}" (try: ${surface}…)` });
        } else if (srcType && !typesCompatible(srcType, target.accepts)) {
          out.push({ code: 'type_mismatch', edge: e.id, node: dst.id, port: e.to.port,
            message: `${e.from.node}.${e.from.port} is ${srcType}, but ${nodeOp(dst)}.${e.to.port} takes ${target.accepts.join(' | ')}` });
        }
      }
    } else {
      out.push({ code: 'bad_edge', edge: e.id, message: 'an input node cannot be a destination' });
    }

    const k = `${e.to.node}.${e.to.port}`;
    intoPort.set(k, [...(intoPort.get(k) ?? []), e]);
  }

  for (const [k, edges] of intoPort) {
    if (edges.length < 2) continue;
    const [nodeId, port] = k.split('.');
    const dst = byId.get(nodeId);
    // a list input is allowed to take many wires; that is what it is for
    if (dst && isEngine(dst)) {
      const spec = getNode(nodeOp(dst));
      if (spec && wireTarget(spec, port)?.list) continue;
    }
    if (dst?.kind === 'output') continue;
    out.push({ code: 'port_overwired', node: nodeId, port,
      message: `${edges.length} edges land on ${k}, which takes one` });
  }

  // Params come last, because a misspelled port makes the correctly-named
  // one look unsupplied. Reporting both "no port inpt" and "input is
  // required" gives a repair prompt two problems where there is one, so a
  // node that already has a port error gets no consequential param errors.
  const portBroken = new Set(out.filter((d) => d.code === 'unknown_port').map((d) => d.node));
  for (const n of g.nodes) {
    if (!isEngine(n)) continue;
    const key = nodeOp(n);
    const spec = getNode(key);
    if (!spec) {
      out.push({ code: 'unknown_engine', node: n.id, message: `no such operation "${key}"` });
      continue;
    }
    const wired = g.edges.filter((e) => e.to.node === n.id).map((e) => e.to.port);
    for (const err of validateParams(key, n.params ?? {}, wired)) {
      if (portBroken.has(n.id) && (err.code === 'missing' || err.code === 'unknown')) continue;
      out.push({
        code: err.code === 'both' ? 'param_and_wire' : 'bad_param',
        node: n.id, port: err.path, message: err.message,
      });
    }
  }

  const sorted = topoSort(g);
  if ('cycle' in sorted) {
    out.push({ code: 'cycle', message: `the graph loops: ${sorted.cycle.join(' -> ')}. Graphs are acyclic; iteration belongs in the executor.` });
    return out; // fan-out analysis is meaningless on a cyclic graph
  }

  const fan = analyseFanOut(g);
  for (const [nodeId, ports] of fan.iteratedPorts) {
    if (ports.size > 1) {
      out.push({
        code: 'fan_out_twice', node: nodeId,
        message: `"${nodeId}" is iterated on ${[...ports].map((p) => `"${p}"`).join(' and ')}. A node can be iterated on one port and there is no zip, unroll it, or move the pairing into the executor.`,
      });
    }
  }

  return out;
}

/** True when nothing offline objects. The server still has the last word. */
export const looksValid = (g: Graph): boolean => preflight(g).length === 0;

// ── building ────────────────────────────────────────────────────────────

/** Stable, readable, collision-resistant node ids: ffmpeg_trim_1, _2… */
export function makeIdFactory() {
  const used = new Map<string, number>();
  return (engine: string, operation: string): string => {
    const base = `${engine}_${operation}`.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return `${base}_${n}`;
  };
}

const COL = 260;
const ROW = 130;

/**
 * Layered left-to-right layout: a node sits one column right of its deepest
 * input. It is not a pretty graph-drawing algorithm, but it opens legibly on
 * their canvas, which is the bar, a generated pipeline someone has to read.
 */
export function layout(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const depth = new Map<string, number>();
  const sorted = topoSort({ version: 1, nodes, edges });
  const order = 'order' in sorted ? sorted.order : nodes.map((n) => n.id);
  const incoming = new Map<string, string[]>();
  for (const e of edges) incoming.set(e.to.node, [...(incoming.get(e.to.node) ?? []), e.from.node]);

  for (const id of order) {
    const parents = incoming.get(id) ?? [];
    depth.set(id, parents.length ? Math.max(...parents.map((p) => (depth.get(p) ?? 0) + 1)) : 0);
  }
  // outputs always sit in the last column, however shallow they are
  const maxDepth = Math.max(0, ...depth.values());
  for (const n of nodes) if (n.kind === 'output') depth.set(n.id, maxDepth);

  const perColumn = new Map<number, number>();
  return nodes.map((n) => {
    const d = depth.get(n.id) ?? 0;
    const row = perColumn.get(d) ?? 0;
    perColumn.set(d, row + 1);
    return { ...n, position: { x: d * COL, y: row * ROW } } as GraphNode;
  });
}

export class GraphBuilder {
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private nextId = makeIdFactory();

  input(name: string, type: string, required = true): string {
    const id = `in_${name}`;
    this.nodes.push({ id, kind: 'input', name, type, required, position: { x: 0, y: 0 } });
    return id;
  }

  op(engine: string, operation: string, params: Record<string, unknown> = {}): string {
    requireNode(`${engine}/${operation}`); // fail at the call site, not at compile
    const id = this.nextId(engine, operation);
    this.nodes.push({ id, kind: 'engine', engine, operation, params, position: { x: 0, y: 0 } });
    return id;
  }

  output(fields: string[], id = 'out1'): string {
    this.nodes.push({ id, kind: 'output', fields, position: { x: 0, y: 0 } });
    return id;
  }

  wire(fromNode: string, fromPort: string, toNode: string, toPort: string): this {
    this.edges.push(edge({ node: fromNode, port: fromPort }, { node: toNode, port: toPort }));
    return this;
  }

  build(version = 1): Graph {
    return { version, nodes: layout(this.nodes, this.edges), edges: this.edges };
  }
}
