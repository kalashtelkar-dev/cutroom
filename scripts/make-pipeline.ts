/**
 * Build a pipeline, check it, and put it on the account.
 *
 *   npm run pipeline -- "<name>" <recipe>
 *
 * MUTATES: `POST /v1/pipelines/import` creates a pipeline. Validation before
 * it is free and stores nothing, so a graph is never uploaded without having
 * been compiled first, both here and on the server.
 *
 * A pipeline cannot be created by PUT: that endpoint demands the etag of a
 * version you edited, even for an id that does not exist yet. Import is the
 * only way in.
 */
import { readFileSync } from 'node:fs';
import { preflight, type Graph } from '../lib/editor-api/graph.ts';
import { extractAudioGraph, EXTRACT_AUDIO_DESCRIPTION } from '../lib/pipelines/extract-audio.ts';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const i = line.indexOf('=');
  if (i < 0 || line.trim().startsWith('#')) continue;
  const k = line.slice(0, i).trim();
  if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}

const BASE = process.env.EDITOR_API_URL as string;
const KEY = process.env.EDITOR_API_KEY as string;

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep the text */ }
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(body).slice(0, 400)}`);
  return body as T;
}

const RECIPES: Record<string, () => Graph> = {
  'extract-audio': extractAudioGraph,
};

async function main() {
  const [name, recipe = 'extract-audio'] = process.argv.slice(2);
  if (!name) {
    console.error('usage: npm run pipeline -- "<name>" [recipe]\nrecipes: ' + Object.keys(RECIPES).join(', '));
    process.exitCode = 1;
    return;
  }
  const build = RECIPES[recipe];
  if (!build) throw new Error(`no recipe "${recipe}". Known: ${Object.keys(RECIPES).join(', ')}`);

  const graph = build();
  console.log(`\n${recipe} -> "${name}"`);
  console.log(`  ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
  for (const n of graph.nodes) {
    const what = n.kind === 'engine' ? `${n.engine}/${n.operation}` : n.kind;
    console.log(`    ${n.id.padEnd(22)} ${what}`);
  }

  const local = preflight(graph);
  if (local.length) {
    console.error('\npreflight refused it:');
    for (const d of local) console.error(`  ${d.code}: ${d.message}`);
    process.exitCode = 1;
    return;
  }
  console.log('\n  preflight clean');

  const checked = await api<{ compiles: boolean; errors: unknown[]; unfinished: unknown[];
                             requestSchema?: unknown; responseSchema?: unknown }>(
    '/v1/pipelines/validate', { method: 'POST', body: JSON.stringify(graph) });
  if (!checked.compiles) {
    console.error('\nthe server refused it:', JSON.stringify(checked.errors ?? checked.unfinished));
    process.exitCode = 1;
    return;
  }
  console.log('  the server compiles it');
  console.log('  takes  :', JSON.stringify(checked.requestSchema));
  console.log('  returns:', JSON.stringify(checked.responseSchema));

  const imported = await api<{ imported: { id: string; name: string; compiles: boolean }[];
                              rejected: { file: string; reason?: string }[] }>(
    '/v1/pipelines/import',
    {
      method: 'POST',
      body: JSON.stringify({
        kind: 'editor-api/pipeline',
        formatVersion: 1,
        name,
        description: EXTRACT_AUDIO_DESCRIPTION,
        graph,
      }),
    });

  const made = imported.imported?.[0];
  if (!made) throw new Error(`rejected: ${JSON.stringify(imported.rejected)}`);
  console.log(`\nCREATED  ${made.id}  "${made.name}"  compiles=${made.compiles}`);

  const head = await api<{ id: string; name: string; published: boolean; version: number }>(
    `/v1/pipelines/${made.id}`);
  console.log(`READ BACK ${head.id}  "${head.name}"  version ${head.version}  published=${head.published}`);
  console.log('\nIt is a draft. Publish it before /v1/run will execute it.\n');
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
