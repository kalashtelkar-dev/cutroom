/**
 * Editing a pipeline graph by hand.
 *
 * The workbench could show a graph and check it; it could not build one. The
 * only ways in were a hand-written recipe in the source and a pasted blob of
 * JSON, which between them meant you could use the pipelines somebody else
 * wrote and no others.
 *
 * Everything here is pure: a graph in, a graph out. The rules that decide
 * whether a wire is allowed are the same rules `preflight()` enforces, which
 * is the point of putting them here rather than in a click handler. A port
 * that cannot accept a wire should say so before the wire is drawn, not after
 * a round trip to the compiler.
 */
import {
  edge, isEngine, nodeOp,
  type EdgeEnd, type Graph, type GraphNode,
} from './graph.ts';
import { getNode, outPort, wireTarget } from './catalogue.ts';

export interface Port {
  name: string;
  /** What may arrive here, empty meaning anything. */
  accepts: string[];
  type: string;
  /** A list port collects a fan-out instead of being run once per item. */
  list: boolean;
  required: boolean;
}

/** Where a wire can leave this node. */
export function outPorts(n: GraphNode): Port[] {
  if (n.kind === 'input') {
    return [{ name: 'value', accepts: [], type: n.type ?? 'any', list: false, required: false }];
  }
  if (n.kind === 'output') return [];
  const spec = getNode(nodeOp(n));
  if (!spec) return [];
  return spec.out.map((o) => ({
    name: o.name,
    accepts: [],
    type: o.type,
    list: o.list === true,
    required: false,
  }));
}

/** Where a wire can arrive. */
export function inPorts(n: GraphNode): Port[] {
  if (n.kind === 'input') return [];
  if (n.kind === 'output') {
    return (n.fields ?? []).map((f) => ({
      name: f, accepts: [], type: 'any', list: false, required: true,
    }));
  }
  const spec = getNode(nodeOp(n));
  if (!spec) return [];
  return spec.in.map((i) => ({
    name: i.name,
    accepts: i.accepts ?? [],
    type: (i.accepts ?? [])[0] ?? 'any',
    list: i.list === true,
    required: i.required === true,
  }));
}

export interface WireVerdict {
  ok: boolean;
  /** Why not, in words a person can act on. */
  why?: string;
}

/**
 * May this wire be drawn?
 *
 * The checks are the compiler's, in the order that gives the most useful
 * message: a wire into an input node is a different mistake from a type
 * mismatch, and being told the second when you made the first sends you
 * looking in the wrong place.
 */
export function canWire(g: Graph, from: EdgeEnd, to: EdgeEnd): WireVerdict {
  if (from.node === to.node) return { ok: false, why: 'a node cannot feed itself' };

  const src = g.nodes.find((n) => n.id === from.node);
  const dst = g.nodes.find((n) => n.id === to.node);
  if (!src || !dst) return { ok: false, why: 'one end of that wire is not in the graph' };
  if (src.kind === 'output') return { ok: false, why: 'an output node is the end of the line, nothing leaves it' };
  if (dst.kind === 'input') return { ok: false, why: 'an input node is where values come from, nothing arrives at it' };

  const sourcePort = outPorts(src).find((p) => p.name === from.port);
  const targetPort = inPorts(dst).find((p) => p.name === to.port);
  if (!sourcePort) return { ok: false, why: `${label(src)} has no output called "${from.port}"` };
  if (!targetPort) return { ok: false, why: `${label(dst)} has no input called "${to.port}"` };

  if (targetPort.accepts.length && !targetPort.accepts.includes(sourcePort.type)) {
    return {
      ok: false,
      why: `${to.port} takes ${targetPort.accepts.join(' or ')}, and ${from.port} carries ${sourcePort.type}`,
    };
  }

  /**
   * Order matters as much as the checks do.
   *
   * "that port already has a wire" sends you to disconnect something. If the
   * real problem is that the wire is a duplicate, or that it would close a
   * loop, disconnecting will not help and you learn that only after doing it.
   * So the reasons that make the wire impossible come before the reason that
   * merely makes the port busy.
   */
  if (g.edges.some((e) => e.from.node === from.node && e.from.port === from.port
    && e.to.node === to.node && e.to.port === to.port)) {
    return { ok: false, why: 'that wire is already there' };
  }

  if (reaches(g, to.node, from.node)) {
    return { ok: false, why: 'that would make a loop, and the graph is a strict DAG' };
  }

  // a scalar input takes one wire. Two would be a silent overwrite, and the
  // compiler answers `port_unavailable` for it after a round trip
  if (!targetPort.list && g.edges.some((e) => e.to.node === to.node && e.to.port === to.port)) {
    return { ok: false, why: `${to.port} already has a wire, and it takes one` };
  }

  return { ok: true };
}

/** Can `target` be reached from `start` by following wires forward? */
function reaches(g: Graph, start: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of g.edges) if (e.from.node === id) stack.push(e.to.node);
  }
  return false;
}

const label = (n: GraphNode): string =>
  n.kind === 'engine' ? nodeOp(n) : n.kind === 'input' ? n.name : 'the output';

export function wire(g: Graph, from: EdgeEnd, to: EdgeEnd): Graph {
  const verdict = canWire(g, from, to);
  if (!verdict.ok) throw new Error(verdict.why ?? 'that wire is not allowed');
  return { ...g, edges: [...g.edges, edge(from, to)] };
}

export const unwire = (g: Graph, edgeId: string): Graph =>
  ({ ...g, edges: g.edges.filter((e) => e.id !== edgeId) });

/** A node id nothing in the graph is using. */
export function freeId(g: Graph, base: string): string {
  const taken = new Set(g.nodes.map((n) => n.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

export interface Placement { x: number; y: number }

export function addOperation(g: Graph, key: string, at: Placement): Graph {
  const spec = getNode(key);
  if (!spec) throw new Error(`there is no operation called "${key}"`);
  const [engine, operation] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
  const id = freeId(g, `${engine}_${operation.replace(/-/g, '_')}`);
  const node: GraphNode = {
    id, kind: 'engine', engine, operation, params: {}, position: { x: at.x, y: at.y },
  };
  return { ...g, nodes: [...g.nodes, node] };
}

export function addInput(g: Graph, name: string, type: string, at: Placement): Graph {
  const clean = name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'source';
  const id = freeId(g, `in_${clean}`);
  // required: a boolean, not omitted. The server checks shape before it
  // compiles and answers 400 with no diagnostics when this is missing.
  const node: GraphNode = {
    id, kind: 'input', name: clean, type, required: true, position: { x: at.x, y: at.y },
  };
  return { ...g, nodes: [...g.nodes, node] };
}

export function addOutput(g: Graph, fields: string[], at: Placement): Graph {
  const clean = fields.map((f) => f.trim()).filter(Boolean);
  if (!clean.length) throw new Error('an output node with no fields returns nothing');
  const id = freeId(g, 'out1');
  const node: GraphNode = { id, kind: 'output', fields: clean, position: { x: at.x, y: at.y } };
  return { ...g, nodes: [...g.nodes, node] };
}

/** Remove a node and every wire that touched it. */
export const removeNode = (g: Graph, id: string): Graph => ({
  ...g,
  nodes: g.nodes.filter((n) => n.id !== id),
  edges: g.edges.filter((e) => e.from.node !== id && e.to.node !== id),
});

export const moveNode = (g: Graph, id: string, at: Placement): Graph => ({
  ...g,
  nodes: g.nodes.map((n) => (n.id === id ? { ...n, position: { x: at.x, y: at.y } } : n)),
});

export function setParams(g: Graph, id: string, params: Record<string, unknown>): Graph {
  return {
    ...g,
    nodes: g.nodes.map((n) => (n.id === id && isEngine(n) ? { ...n, params } : n)),
  };
}

export const emptyGraph = (): Graph => ({ version: 1, nodes: [], edges: [] });

/** Every operation in the catalogue, for the palette, ranked by a query. */
export function searchOperations(
  query: string,
  all: readonly { engine: string; operation: string; summary?: string }[],
): string[] {
  const q = query.trim().toLowerCase();
  const keyed = all.map((n) => ({
    key: `${n.engine}/${n.operation}`,
    hay: `${n.engine} ${n.operation} ${n.summary ?? ''}`.toLowerCase(),
  }));
  if (!q) return keyed.map((k) => k.key);
  return keyed
    .map((k) => {
      const exact = k.key.toLowerCase().includes(q) ? 2 : 0;
      const loose = k.hay.includes(q) ? 1 : 0;
      return { key: k.key, score: exact + loose };
    })
    .filter((k) => k.score > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .map((k) => k.key);
}
