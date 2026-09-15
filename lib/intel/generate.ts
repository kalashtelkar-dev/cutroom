/**
 * A graph becomes an intel card.
 *
 * Everything a graph can answer is read off the graph: operations, engines,
 * ports, cost, rung, the plan. Everything it cannot is asked for, and the
 * card is refused without it.
 *
 * The first version wrote "WRITE THIS" into `## When NOT to use it` and
 * shipped. That is worse than leaving the section out: the card went live,
 * started winning prompts, and the instruction to fix it was sitting inside
 * the thing it was meant to fix. A placeholder in a generator is a
 * placeholder in production. So this refuses instead.
 *
 * `## When NOT to use it` is where the routing accuracy lives. A card that
 * only says what it is for wins prompts belonging to something cheaper or to
 * something else entirely, and nothing in a graph can tell you what it is
 * wrong for.
 */
import { isEngine, type Graph } from '../editor-api/graph.ts';
import { getNode } from '../editor-api/catalogue.ts';

export interface CardDraft {
  id: string;
  name: string;
  /** Phrases the card claims. Without at least one it can never win. */
  match: string[];
  markdown: string;
}

/**
 * The parts of a card no graph can supply.
 *
 * Required, not optional with a default: a default here is a placeholder, and
 * a placeholder is what this exists to prevent.
 */
export interface CardAuthoring {
  /** Why someone would reach for this, in their words. */
  whenToUse: string;
  /** The cases that look like this one and are not. */
  whenNotToUse: string;
  /** Phrases that must never let this card win, however well it scores. */
  veto?: string[];
  /** Sentences a person would really say. Each is a claim, so each must be new. */
  examples?: string[];
}

export class CardIncomplete extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`a card cannot be written without: ${missing.join(', ')}`);
    this.name = 'CardIncomplete';
    this.missing = missing;
  }
}

/** Enough words to be a real answer rather than a gesture at one. */
const MIN_PROSE = 25;

export const cardId = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 49);

const operationsOf = (g: Graph): string[] =>
  g.nodes.filter(isEngine).map((n) => `${n.engine}/${n.operation}`);

export function generateCard(
  graph: Graph,
  title: string,
  match: string[],
  authoring: CardAuthoring,
  pipelineId?: string,
): CardDraft {
  const missing: string[] = [];
  if (!match.some((m) => m.trim())) missing.push('at least one phrase to claim');
  if ((authoring.whenToUse ?? '').trim().length < MIN_PROSE) missing.push('When to use it');
  if ((authoring.whenNotToUse ?? '').trim().length < MIN_PROSE) missing.push('When NOT to use it');
  if (missing.length) throw new CardIncomplete(missing);

  /**
   * Examples belong in "When to use it", because that is where a claim lives.
   *
   * The parser reads quoted phrases out of that section and nowhere else, so
   * an example written under "## Worked examples" is read by a person and by
   * nothing else. This generator put them there at first, and the sentence
   * never became a claim: the card looked like it answered to a phrase it
   * had no hold on.
   *
   * An example that repeats something already in `match:` is dropped: it
   * scores nothing, and makes the card look like it claims more than it does.
   */
  const claimed = new Set(match.map((m) => m.toLowerCase().trim()));
  const examples = (authoring.examples ?? [])
    .map((e) => e.trim())
    .filter((e) => e && !claimed.has(e.toLowerCase()));

  const ops = operationsOf(graph);
  const engines = [...new Set(graph.nodes.filter(isEngine).map((n) => n.engine))];
  const gpu = ops.some((key) => getNode(key)?.gpu);
  const steps = ops.length;
  const cost = gpu
    ? `${Math.max(20, steps * 9)}-${Math.max(60, steps * 22)}s · gpu`
    : `${Math.max(3, steps * 3)}-${Math.max(12, steps * 8)}s · cpu`;
  /**
   * The rung is what the plan actually reaches, not a guess from the size.
   *
   * A graph that is one operation wide does not need a pipeline behind it:
   * the escalation ladder says take the cheapest rung that does the job, and
   * `run_operation` is a rung below `run_pipeline`. Declaring rung 2 while
   * emitting a pipeline step is a card that lies about its own cost, which
   * the suite catches and which would mislead the router besides.
   */
  const single = steps === 1 ? ops[0] : null;
  const rung = single ? 2 : 3;
  const id = cardId(title);

  const inputs = graph.nodes
    .filter((n) => n.kind === 'input')
    .map((n) => ({ name: n.name ?? 'input', type: n.type ?? 'any' }));
  const outputs = graph.nodes
    .filter((n) => n.kind === 'output')
    .flatMap((n) => n.fields ?? []);

  const step = single
    ? {
        kind: 'operation',
        engine: single.split('/')[0],
        operation: single.split('/')[1],
        input: `$${inputs[0]?.name ?? 'selection'}`,
      }
    : {
        kind: 'pipeline',
        ...(pipelineId ? { pipelineId } : {}),
        input: `$${inputs[0]?.name ?? 'selection'}`,
      };
  const plan = JSON.stringify([step], null, 2);

  const markdown = `---
id: ${id}
kind: pipeline
rung: ${rung}
cost: ${cost}
match: ${match.join(', ')}
${(authoring.veto ?? []).length ? `veto: ${(authoring.veto ?? []).join(', ')}\n` : ''}---

## What it does
${describe(ops, inputs, outputs)}

## When to use it
${authoring.whenToUse.trim()}${examples.length ? `\n\n${examples.map((e) => `"${e}"`).join(', ')}.` : ''}

## When NOT to use it
${authoring.whenNotToUse.trim()}

## Parameters
${inputs.map((i) => `- \`${i.name}\` (${i.type}), required`).join('\n') || '- none'}

## Chaining
Returns ${outputs.length ? outputs.map((o) => `\`${o}\``).join(', ') : 'nothing'}.
${engines.length ? `Runs on ${engines.join(', ')}.` : ''}

## Failure modes
- A source it cannot read fails the whole run, because the graph is one step wide.
${gpu ? '- GPU work queues behind whatever else is running.' : ''}

## Worked examples
${examples.length
  ? examples.map((e) => `> "${e}"`).join('\n')
  : `> "${match[0]}"`}
${single ? `{ kind: 'operation', engine: '${single.split('/')[0]}', operation: '${single.split('/')[1]}' }`
  : `{ kind: 'pipeline'${pipelineId ? `, pipelineId: '${pipelineId}'` : ''} }`}

## Plan
What the router emits when this card wins. Steps are typed; the validator
checks them before anything runs.

\`\`\`json
${plan}
\`\`\`
`;

  return { id, name: title, match, markdown };
}

function describe(
  ops: string[],
  inputs: { name: string; type: string }[],
  outputs: string[],
): string {
  const summaries = ops.map((key) => getNode(key)?.summary).filter(Boolean);
  const chain = summaries.length ? summaries.join(', then ') : ops.join(', then ');
  const takes = inputs.length ? inputs.map((i) => `${i.name} (${i.type})`).join(' and ') : 'nothing';
  const gives = outputs.length ? outputs.join(', ') : 'nothing';
  return `Takes ${takes}. ${chain}. Returns ${gives}.`;
}
