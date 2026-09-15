/**
 * Queries over the node catalogue.
 *
 * Everything the router and the compiler need to know about what the server
 * can do is answered from here, offline. Two things in particular:
 *
 *  1. **The real port surface of a node is `in` ∪ every param key.** The API
 *     lets a param be driven by a wire, so a graph can legally address ports
 *     that never appear in `in[]`. Checking only `in[]` produces phantom
 *     `unknown_port` errors.
 *
 *  2. **Fan-out arity.** A multi-valued out port wired into a scalar in port
 *     is the only iteration the graph has, and a node may be iterated on at
 *     most one port, a second one is `fan_out_twice`, a hard compile error.
 *     We can detect that here rather than spending a round trip to find out.
 */
import type { BindablePort, InPort, JsonSchema, NodeSpec, OutPort } from './types.ts';
import { NODES, NODE_LIST, type NodeKey } from './catalogue.generated.ts';

export { NODES, NODE_LIST, PORT_TYPES, CATALOGUE, DEPENDS_NODES } from './catalogue.generated.ts';
export type { NodeKey, EngineName, PortType } from './catalogue.generated.ts';

export const nodeKey = (engine: string, operation: string) => `${engine}/${operation}` as NodeKey;

export function getNode(key: string): NodeSpec | undefined {
  return (NODES as Record<string, NodeSpec>)[key];
}

/** Throws rather than returning undefined, for call sites that cannot proceed. */
export function requireNode(key: string): NodeSpec {
  const n = getNode(key);
  if (!n) throw new Error(`unknown node "${key}", not in the catalogue`);
  return n;
}

export const paramKeys = (n: NodeSpec): string[] => Object.keys(n.params.properties ?? {});

/** Every port name a graph may legally address on this node. */
export function portSurface(n: NodeSpec): Set<string> {
  return new Set([...n.in.map((p) => p.name), ...paramKeys(n), ...n.bindable.map((b) => b.name)]);
}

export const outPort = (n: NodeSpec, name: string): OutPort | undefined =>
  n.out.find((o) => o.name === name);

export const inPort = (n: NodeSpec, name: string): InPort | undefined =>
  n.in.find((p) => p.name === name);

export const bindablePort = (n: NodeSpec, name: string): BindablePort | undefined =>
  n.bindable.find((b) => b.name === name);

/**
 * What a wire into `portName` will accept, whether it is a declared input or
 * a bindable param. Returns null if nothing on this node answers to the name.
 */
export function wireTarget(n: NodeSpec, portName: string): { accepts: string[]; list: boolean } | null {
  const p = inPort(n, portName);
  if (p) return { accepts: p.accepts, list: p.list === true };
  const b = bindablePort(n, portName);
  if (b) return { accepts: b.accepts, list: false };
  return null;
}

/**
 * Resolve a `"depends"` arity against real params.
 *
 * The catalogue says which ports are conditional but not what they depend on,
 * so each one needs a rule. A node listed in DEPENDS_NODES without a rule here
 * is a bug we want to hear about, not guess at, hence the throw.
 */
const DEPENDS_RESOLVERS: Record<string, (params: Record<string, unknown>) => boolean> = {
  // one still is a single file; more than one is a list
  'ffmpeg/thumbnail': (p) => Number(p.count ?? 1) > 1,
};

export function fansOut(key: string, portName: string, params: Record<string, unknown> = {}): boolean {
  const n = requireNode(key);
  const o = outPort(n, portName);
  if (!o) throw new Error(`node "${key}" has no out port "${portName}"`);
  if (o.list !== 'depends') return o.list;
  const rule = DEPENDS_RESOLVERS[key];
  if (!rule) {
    throw new Error(
      `"${key}.${portName}" arity depends on params but has no resolver in DEPENDS_RESOLVERS`,
    );
  }
  return rule(params);
}

/** Out ports that can ever carry many values. */
export const fanOutPorts = (n: NodeSpec): OutPort[] => n.out.filter((o) => o.list !== false);

// ── param validation ────────────────────────────────────────────────────
// Most tool-calling failures are param-shape failures. Catching them here
// costs nothing; catching them at the server costs a round trip, and
// catching them at run time costs GPU minutes.

export interface ParamError {
  path: string;
  code: 'missing' | 'unknown' | 'both' | 'type' | 'enum' | 'range' | 'length' | 'pattern';
  message: string;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(want: string, v: unknown): boolean {
  const got = typeOf(v);
  if (want === 'number') return got === 'number' || got === 'integer';
  if (want === 'integer') return got === 'integer';
  return got === want;
}

function checkValue(schema: JsonSchema, value: unknown, path: string, errs: ParamError[]): void {
  const types = schema.type == null ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some((t) => typeMatches(t, value))) {
    errs.push({ path, code: 'type', message: `expected ${types.join(' | ')}, got ${typeOf(value)}` });
    return; // every later check assumes the type held
  }
  if (schema.enum && !schema.enum.includes(value as never)) {
    errs.push({ path, code: 'enum', message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` });
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum)
      errs.push({ path, code: 'range', message: `must be >= ${schema.minimum}` });
    if (schema.maximum != null && value > schema.maximum)
      errs.push({ path, code: 'range', message: `must be <= ${schema.maximum}` });
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum)
      errs.push({ path, code: 'range', message: `must be > ${schema.exclusiveMinimum}` });
    if (schema.exclusiveMaximum != null && value >= schema.exclusiveMaximum)
      errs.push({ path, code: 'range', message: `must be < ${schema.exclusiveMaximum}` });
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength)
      errs.push({ path, code: 'length', message: `must be at least ${schema.minLength} characters` });
    if (schema.maxLength != null && value.length > schema.maxLength)
      errs.push({ path, code: 'length', message: `must be at most ${schema.maxLength} characters` });
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      errs.push({ path, code: 'pattern', message: `must match /${schema.pattern}/` });
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => checkValue(schema.items!, v, `${path}[${i}]`, errs));
  }
}

/**
 * Check params against the node's own schema.
 *
 * `wired` names params supplied by an edge rather than a literal: those are
 * present at run time but absent from the object, so they satisfy `required`
 * without having a value to check.
 */
export function validateParams(
  key: string,
  params: Record<string, unknown>,
  wired: readonly string[] = [],
): ParamError[] {
  const n = requireNode(key);
  const schema = n.params;
  const props = schema.properties ?? {};
  const errs: ParamError[] = [];
  const supplied = new Set([...Object.keys(params), ...wired]);

  for (const req of schema.required ?? []) {
    if (!supplied.has(req)) {
      errs.push({ path: req, code: 'missing', message: `"${req}" is required by ${key}` });
    }
  }
  for (const [name, value] of Object.entries(params)) {
    const sub = props[name];
    if (!sub) {
      if (schema.additionalProperties === false) {
        const near = nearest(name, Object.keys(props));
        errs.push({
          path: name,
          code: 'unknown',
          message: `${key} has no param "${name}"${near ? `, did you mean "${near}"?` : ''}`,
        });
      }
      continue;
    }
    if (value === undefined) continue;
    checkValue(sub, value, name, errs);
  }
  for (const w of wired) {
    const isInput = n.in.some((p) => p.name === w);
    const isBindable = n.bindable.some((b) => b.name === w);
    if (!isInput && !isBindable) {
      const why = props[w]
        ? `"${w}" on ${key} is a param but is not bindable, pass it as a literal`
        : `${key} has no port or param "${w}" to wire`;
      errs.push({ path: w, code: 'unknown', message: why });
    }
    if (w in params) {
      errs.push({
        path: w,
        code: 'both',
        message: `"${w}" is both wired and given a literal value`,
      });
    }
  }
  return errs;
}

/** Cheap edit-distance suggestion, for "did you mean". */
function nearest(word: string, pool: string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const cand of pool) {
    const d = distance(word.toLowerCase(), cand.toLowerCase());
    if (d < bestD) { bestD = d; best = cand; }
  }
  return bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// ── catalogue-wide queries the router uses ──────────────────────────────

export const enginesInUse = (): string[] => [...new Set(NODE_LIST.map((n) => n.engine))].sort();

export const nodesForEngine = (engine: string): NodeSpec[] =>
  NODE_LIST.filter((n) => n.engine === engine);

/** Nodes that will accept a value of this port type on some input. */
export function nodesAccepting(portType: string): NodeSpec[] {
  return NODE_LIST.filter((n) =>
    n.in.some((p) => p.accepts.length === 0 || p.accepts.includes(portType)),
  );
}

export const isGpu = (key: string): boolean => requireNode(key).gpu;
