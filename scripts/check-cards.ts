/**
 * Every card, checked against the account it claims to run on.
 *
 * A card can name a pipeline that does not exist, or bind an input that
 * pipeline does not have, and nothing notices until someone presses the
 * button and waits for the round trip to fail. That is how `auto-broll-weave`
 * shipped sending `{input: "<key>"}` to a pipeline whose only input node is
 * called `video`, and how `subtitle-burn` and `tighten-cut` shipped naming
 * `tpl_subs` and `tpl_words`, which are not ids, they are placeholders that
 * were never replaced.
 *
 *   npm run cards
 *
 * Free: it only reads. `GET /v1/pipelines/{id}` stores nothing and costs
 * nothing, which is exactly why there was no excuse for not asking.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCard } from '../lib/intel/parse.ts';
import { checkFileValue, filePorts } from '../lib/executor/bindingCheck.ts';
import { getNode } from '../lib/editor-api/catalogue.ts';

const catalogueNode = (engine: string, operation: string) => getNode(`${engine}/${operation}`);

const env = readFileSync('.env.local', 'utf8');
const KEY = env.match(/^EDITOR_API_KEY=(.*)$/m)![1].trim();
const URL_ = env.match(/^EDITOR_API_URL=(.*)$/m)![1].trim();

const CARDS = 'lib/intel/cards';

interface PipelineHead {
  id: string;
  name: string;
  published: boolean;
  compiles: boolean;
  graph?: { nodes?: { kind?: string; name?: string; required?: boolean; fields?: string[] }[] };
}

const cache = new Map<string, PipelineHead | null>();

async function head(id: string): Promise<PipelineHead | null> {
  if (cache.has(id)) return cache.get(id) ?? null;
  const r = await fetch(`${URL_}/v1/pipelines/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const got = r.ok ? (await r.json()) as PipelineHead : null;
  cache.set(id, got);
  return got;
}

/** The input node NAMES a run body must be keyed by. */
function inputNames(p: PipelineHead): { required: string[]; optional: string[] } {
  const nodes = (p.graph?.nodes ?? []).filter((n) => n.kind === 'input');
  return {
    required: nodes.filter((n) => n.required !== false).map((n) => String(n.name)),
    optional: nodes.filter((n) => n.required === false).map((n) => String(n.name)),
  };
}

/**
 * What a pipeline step would actually post.
 *
 * `input` as a bare string becomes `{input: value}`, which is the bug: it
 * names the key `input` rather than whatever the pipeline calls it. `params`
 * is an object and its keys are used as written, which is what the one
 * correct card in the repo does.
 */
function boundKeys(step: unknown): { keys: string[]; how: string } {
  const s = step as unknown as { params?: Record<string, unknown>; input?: unknown };
  if (s.params && typeof s.params === 'object') {
    return { keys: Object.keys(s.params), how: 'params' };
  }
  if (typeof s.input === 'string') return { keys: ['input'], how: 'a bare `input:` string' };
  if (s.input && typeof s.input === 'object') {
    return { keys: Object.keys(s.input as object), how: 'input object' };
  }
  return { keys: [], how: 'nothing' };
}

const problems: string[] = [];
const rows: string[] = [];

/**
 * The bindings the editor actually sets before a plan runs.
 *
 * Read off `executePlan` in app/edit/page.tsx. A card asking for anything
 * else gets the literal `$name` posted to the API, which is how `$program`
 * and `$audio` reached it and came back `input_unreachable`.
 *
 * `source` is the only one that is an object key, and it is the only one a
 * file port should ever be bound to: the editor resolves the tool's target
 * and checks the key is readable before any of this starts.
 */
const PROVIDED = new Set(['source', 'sourceMediaKey', 'selection', 'playhead', 'timeline', 'item', 'index']);
const FILE_BINDING = 'source';

/** Every `$name` a plan reads, at any depth. */
function bindingsUsed(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string' && value.startsWith('$')) into.add(value.slice(1).split('.')[0]);
  else if (Array.isArray(value)) for (const v of value) bindingsUsed(v, into);
  else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) bindingsUsed(v, into);
  }
  return into;
}

const files = readdirSync(CARDS).filter((f) => f.endsWith('.md'));
/**
 * A comparison of nothing passes, so this refuses to report a clean run over
 * an empty directory.
 *
 * It used to refuse fewer than five, which was a proxy for "the directory
 * moved" and stopped being true the moment eight cards were archived on
 * purpose: a correct shelf failed the build. What it can honestly ask is
 * whether it found anything and whether it then read everything it found,
 * which is the question the threshold was standing in for.
 */
if (!files.length) {
  console.error(`no cards in ${CARDS}, so this checked nothing. Has the directory moved?`);
  process.exit(1);
}

let pipelineSteps = 0;
let cardsRead = 0;

for (const file of files.sort()) {
  const card = parseCard(readFileSync(join(CARDS, file), 'utf8'), file.replace(/\.md$/, ''));
  cardsRead += 1;
  /**
   * Every binding a card reads must be one the editor sets, and every file
   * port must read `$source`.
   *
   * Four cards failed this when it was written: `$program` and `$audio` were
   * never bound by anything, and `$selection` is a clip id, which resolves to
   * a real string that is not a file. All four reached the live API.
   */
  {
    const have = new Set(PROVIDED);
    const missing: string[] = [];

    /** Walk in order: a step may read what the steps before it produced. */
    const scan = async (list: readonly unknown[]): Promise<void> => {
      for (const raw of list) {
        const st = raw as Record<string, unknown>;

        // what this step READS has to be available by now
        const reads = new Set<string>();
        for (const [k, v] of Object.entries(st)) {
          // `as` names what the step WRITES, so reading it as a read makes
          // every step that publishes a binding look like it depends on one
          if (k === 'body' || k === 'then' || k === 'else' || k === 'as') continue;
          bindingsUsed(v, reads);
        }
        for (const name of reads) if (!have.has(name)) missing.push(name);

        // what it PRODUCES is available to everything after it
        const as = typeof st.as === 'string' ? st.as.replace(/^\$/, '') : null;
        if (as) have.add(as);
        if (st.kind === 'pipeline') {
          const pid = String(st.pipelineId ?? '');
          const p = await head(pid);
          for (const n of p?.graph?.nodes ?? []) {
            if ((n as { kind?: string }).kind !== 'output') continue;
            for (const f of ((n as { fields?: string[] }).fields ?? [])) have.add(String(f));
          }
        }
        if (st.kind === 'operation') {
          const node = catalogueNode(String(st.engine ?? ''), String(st.operation ?? ''));
          for (const o of node?.out ?? []) have.add(String(o.name));
        }
        if (st.kind === 'read-json') {
          // a read binds whatever is in the file, which cannot be known here.
          // `as` covers the object itself; its fields are the author's claim.
          if (as) have.add(as);
        }

        if (Array.isArray(st.body)) {
          // a fanout binds one item at a time
          have.add('item');
          have.add('index');
          await scan(st.body as unknown[]);
        }
        for (const key of ['then', 'else']) {
          if (Array.isArray(st[key])) await scan(st[key] as unknown[]);
        }
      }
    };
    await scan(card.steps);

    for (const name of [...new Set(missing)]) {
      rows.push(`  FAIL  ${card.id.padEnd(20)} rung ${card.rung}  reads $${name}, which nothing binds`);
      problems.push(`${card.id}: reads $${name}, and no earlier step produces it`);
    }
  }

  const walk = (list: readonly unknown[]): void => {
    for (const raw of list) {
      const st = raw as Record<string, unknown>;
      if (st.kind === 'operation') {
        const ports = filePorts(String(st.engine ?? ''), String(st.operation ?? ''));
        const params = { ...(st.params as Record<string, unknown> ?? {}) };
        if (st.input !== undefined) params.input = st.input;
        for (const port of ports) {
          if (!(port in params)) continue;
          const v = params[port];
          // `$item` is bound per iteration inside a fanout, so it is the one
          // binding this cannot judge from the outside
          if (typeof v === 'string' && v.startsWith('$item')) continue;
          const bad = typeof v === 'string' && v.startsWith('$')
            ? (v.slice(1) === FILE_BINDING ? null : { reason: `reads ${v}, but a file port takes $${FILE_BINDING}` })
            : checkFileValue(port, v);
          if (bad) {
            rows.push(`  FAIL  ${card.id.padEnd(20)} rung ${card.rung}  ${st.engine}/${st.operation}.${port}`);
            problems.push(`${card.id}: ${st.engine}/${st.operation}.${port} ${bad.reason}`);
          }
        }
      }
      for (const key of ['body', 'then', 'else']) {
        if (Array.isArray(st[key])) walk(st[key] as unknown[]);
      }
    }
  };
  walk(card.steps);

  const steps = card.steps.filter((s) => s.kind === 'pipeline');

  if (!steps.length) {
    rows.push(`  ok    ${card.id.padEnd(20)} rung ${card.rung}  no pipeline to check`);
    continue;
  }

  for (const step of steps) {
    pipelineSteps += 1;
    const id = String((step as unknown as { pipelineId?: string }).pipelineId ?? '');
    const p = await head(id);

    if (!p) {
      rows.push(`  FAIL  ${card.id.padEnd(20)} rung ${card.rung}  ${id} is not on this account`);
      problems.push(`${card.id}: names ${id}, which does not exist`);
      continue;
    }
    if (!p.published) {
      rows.push(`  FAIL  ${card.id.padEnd(20)} rung ${card.rung}  ${id} exists but is a draft`);
      problems.push(`${card.id}: ${id} ("${p.name}") is not published, so a run refuses it`);
      continue;
    }

    const { required, optional } = inputNames(p);
    const { keys, how } = boundKeys(step);
    const missing = required.filter((n) => !keys.includes(n));
    const unknown = keys.filter((n) => !required.includes(n) && !optional.includes(n));

    if (missing.length || unknown.length) {
      rows.push(`  FAIL  ${card.id.padEnd(20)} rung ${card.rung}  ${id} "${p.name}"`);
      const wants = required.length ? required.join(', ') : '(none)';
      problems.push(
        `${card.id}: ${id} takes ${wants}; the plan binds ${keys.join(', ') || '(nothing)'} via ${how}`
        + (missing.length ? `. Missing: ${missing.join(', ')}` : '')
        + (unknown.length ? `. Not an input: ${unknown.join(', ')}` : ''),
      );
      continue;
    }

    const values = (step as unknown as { params?: Record<string, unknown> }).params ?? {};
    const badValue = Object.entries(values)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => {
        const str = v as string;
        if (str.startsWith('$')) {
          return str.slice(1) === FILE_BINDING
            ? null
            : `${k} reads ${str}, but a pipeline input takes $${FILE_BINDING}`;
        }
        const problem = checkFileValue(k, str);
        return problem ? `${k} ${problem.reason}` : null;
      })
      .filter((x): x is string => x !== null);

    if (badValue.length) {
      rows.push(`  FAIL  ${card.id.padEnd(20)} rung ${card.rung}  ${id} "${p.name}" is bound wrongly`);
      for (const b of badValue) problems.push(`${card.id}: ${b}`);
      continue;
    }

    rows.push(`  ok    ${card.id.padEnd(20)} rung ${card.rung}  ${id} takes ${required.join(', ') || '(none)'}`);
  }
}

console.log(`\n${files.length} cards, ${pipelineSteps} pipeline step(s)\n`);
for (const r of rows) console.log(r);

// the other half of "a comparison of nothing passes": a card skipped by a
// `continue` somewhere above would otherwise leave a clean run behind it
if (cardsRead !== files.length) {
  console.error(`\nread ${cardsRead} of ${files.length} cards, so some were never checked\n`);
  process.exit(1);
}

if (problems.length) {
  console.log(`\n${problems.length} card(s) would fail when run:\n`);
  for (const p of problems) console.log(`  ${p}`);
  console.log('');
  process.exit(1);
}
console.log('\nevery card that names a pipeline can actually run it\n');
