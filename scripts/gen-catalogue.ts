/**
 * Regenerate the node catalogue from the live editor API.
 *
 *   npm run catalogue
 *
 * The catalogue is 116 nodes of ports, arities and full param schemas. We
 * commit the generated file so the router, the validator and the compiler
 * can be built and tested with no network, and regenerate when the server
 * gains operations.
 *
 * The data is emitted as a JS string literal that is JSON.parse'd at load.
 * Emitting it as an object literal instead would hand TypeScript a 250KB
 * literal to infer on every typecheck, for no benefit, the useful types
 * are the string-literal unions below, and those are cheap.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Catalogue, NodeSpec } from '../lib/editor-api/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'lib', 'editor-api', 'catalogue.generated.ts');

function env(name: string): string {
  const v = process.env[name];
  if (v) return v;
  // read .env.local directly, this script runs outside Next's env loading
  try {
    const text = readFileSync(join(HERE, '..', '.env.local'), 'utf8');
    const m = text.match(new RegExp('^' + name + '=(.*)$', 'm'));
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  throw new Error(`${name} is not set, copy .env.example to .env.local`);
}

const ident = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);

async function main() {
  const base = env('EDITOR_API_URL').replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/pipelines/nodes`, {
    headers: { Authorization: `Bearer ${env('EDITOR_API_KEY')}` },
  });
  if (!res.ok) throw new Error(`GET /v1/pipelines/nodes -> ${res.status} ${res.statusText}`);
  const cat = (await res.json()) as Catalogue;

  if (!Array.isArray(cat.nodes) || !cat.nodes.length) throw new Error('catalogue came back empty');

  const nodes = [...cat.nodes].sort((a, b) =>
    (a.engine + '/' + a.operation).localeCompare(b.engine + '/' + b.operation));
  const keys = nodes.map((n) => `${n.engine}/${n.operation}`);
  const engines = [...new Set(nodes.map((n) => n.engine))].sort();

  // Nodes whose output arity is decided by a param. Every one of these needs
  // an entry in DEPENDS_RESOLVERS in catalogue.ts or the compiler has to
  // guess, so the generator reports them loudly.
  const depends = nodes
    .filter((n) => n.out.some((o) => o.list === 'depends'))
    .map((n) => `${n.engine}/${n.operation}`);

  const payload = JSON.stringify({ portTypes: cat.portTypes, nodes } satisfies
    { portTypes: string[]; nodes: NodeSpec[] });

  const src = `// GENERATED FILE. Do not edit by hand. Run: npm run catalogue
// Source: GET /v1/pipelines/nodes  ·  ${nodes.length} nodes across ${engines.length} engines

import type { Catalogue, NodeSpec } from './types.ts';

export const PORT_TYPES = [
${cat.portTypes.map((t) => `  ${JSON.stringify(t)},`).join('\n')}
] as const;
export type PortType = (typeof PORT_TYPES)[number];

export type EngineName =
${engines.map((e) => `  | ${JSON.stringify(e)}`).join('\n')};

/** Every node the server can compile, as "engine/operation". */
export type NodeKey =
${keys.map((k) => `  | ${JSON.stringify(k)}`).join('\n')};

/** Nodes whose output arity is decided by their params. */
export const DEPENDS_NODES = [
${depends.map((k) => `  ${JSON.stringify(k)},`).join('\n')}
] as const;

const RAW = ${JSON.stringify(payload)};

const parsed = JSON.parse(RAW) as { portTypes: string[]; nodes: NodeSpec[] };

export const NODE_LIST: readonly NodeSpec[] = parsed.nodes;

export const NODES: Readonly<Record<NodeKey, NodeSpec>> = Object.freeze(
  Object.fromEntries(parsed.nodes.map((n) => [\`\${n.engine}/\${n.operation}\`, n])),
) as Record<NodeKey, NodeSpec>;

export const CATALOGUE: Catalogue = {
  portTypes: parsed.portTypes,
  count: parsed.nodes.length,
  nodes: parsed.nodes,
};
`;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, src);

  console.log(`catalogue: ${nodes.length} nodes, ${engines.length} engines -> ${OUT}`);
  console.log(`engines: ${engines.map((e) => `${e}(${nodes.filter((n) => n.engine === e).length})`).join(' ')}`);
  const lists = nodes.flatMap((n) => n.out.filter((o) => o.list === true));
  console.log(`fan-out capable ports: ${lists.length}`);
  console.log(`arity depends on params: ${depends.length ? depends.join(', ') : 'none'}`);
  const unident = keys.filter((k) => !ident(k.split('/')[1]));
  if (unident.length) console.log(`note: operations needing quoting: ${unident.join(', ')}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
