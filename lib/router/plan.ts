/**
 * Stage 1: planning.
 *
 * The router emits a typed Plan, never prose. A plan is checkable before it
 * is expensive: params go through the node schemas, graphs go through
 * preflight, and only then does anything run.
 *
 * Iteration is an executor concern and it says so in the type. `fanout` is a
 * plan step, not a graph node, because the graph cannot loop, a plan that
 * assumes otherwise is rejected here rather than by a compiler error minutes
 * later.
 */
import type { Step } from '../intel/index.ts';
import { getNode, validateParams } from '../editor-api/catalogue.ts';
import { preflight, type Graph } from '../editor-api/graph.ts';
import { rank, type Hit, type RetrieveConfig } from './retrieve.ts';

export type Rung = 1 | 2 | 3 | 4;

export interface Plan {
  /** The card that won, so every plan is traceable to a description. */
  cardId: string;
  intent: string;
  /** Which of the card's phrases fired, in its own words. */
  rationale: string;
  rung: Rung;
  cost: string;
  steps: Step[];
  /** Gap to the runner-up. Under 2 the choice is fragile. */
  margin: number;
  fragile: boolean;
}

export interface RoutingResult {
  prompt: string;
  hits: Hit[];
  live: Hit[];
  plan: Plan | null;
  /** Set when nothing cleared the threshold, or everything was vetoed. */
  declined?: string;
}

export const FRAGILE_MARGIN = 2;

export function route(prompt: string, cfg: RetrieveConfig = {}): RoutingResult {
  const { hits, live, winner, margin } = rank(prompt, cfg);

  if (!winner) {
    const vetoed = hits.filter((h) => h.vetoed);
    const declined = vetoed.length
      ? `every candidate was vetoed, ${vetoed
          .slice(0, 3)
          .map((h) => `${h.card.id} by "${h.vetoedBy}"`)
          .join(', ')}`
      : 'no card claims any phrase in this prompt; ask the user what they meant '
        + 'rather than guessing from word overlap';
    return { prompt, hits, live, plan: null, declined };
  }

  const card = winner.card;
  return {
    prompt,
    hits,
    live,
    plan: {
      cardId: card.id,
      /**
       * What the run is CALLED, which is not its id.
       *
       * It was the id with the hyphens taken out, so every message about a
       * subtitle run began "subtitle burn:". An id is for the router and the
       * repo; the card names itself for everywhere else.
       */
      intent: card.meta.name ?? card.meta.tool_name ?? card.id.replace(/-/g, ' '),
      rationale: winner.why.length
        ? `matched ${winner.why.map((w) => `“${w}”`).join(', ')}`
        : 'best free-text overlap with the card body, no phrase fired, so this is a weak match',
      rung: Math.min(4, Math.max(1, card.rung)) as Rung,
      cost: card.cost,
      steps: card.steps,
      margin,
      fragile: margin < FRAGILE_MARGIN,
    },
  };
}

// ── validation ──────────────────────────────────────────────────────────

export interface PlanProblem {
  step: number;
  code: 'unknown_step' | 'unknown_operation' | 'bad_param' | 'bad_graph' | 'graph_loop';
  message: string;
}

const KNOWN: ReadonlySet<string> =
  new Set(['timeline-op', 'operation', 'pipeline', 'graph', 'fanout', 'branch', 'read-json']);

/**
 * Check a plan without running it.
 *
 * Most tool-calling failures are param-shape failures, and they are free to
 * catch here. Ad-hoc graphs go through the same offline preflight the graph
 * editor uses, so a `fan_out_twice` surfaces as a plan problem rather than as
 * a compile error after the model has already committed to the approach.
 */
export function validatePlan(steps: Step[], path = ''): PlanProblem[] {
  const out: PlanProblem[] = [];

  steps.forEach((step, i) => {
    const where = path ? `${path}.${i}` : String(i);
    const at = Number(where.split('.')[0]);

    if (!KNOWN.has(step.kind)) {
      out.push({ step: at, code: 'unknown_step', message: `step ${where}: no such step kind "${step.kind}"` });
      return;
    }

    if (step.kind === 'read-json') {
      /**
       * A read is free and local, so the only thing worth checking is that
       * it says where to read from. Without `from` it would read the last
       * step's outputs by accident, which is the kind of default that works
       * until a plan grows a step in the middle.
       */
      const from = (step as { from?: unknown }).from;
      if (typeof from !== 'string' || !from.trim()) {
        out.push({
          step: at,
          code: 'bad_param',
          message: `step ${where}: read-json needs "from", the binding holding the step whose output to read`,
        });
      }
      return;
    }

    if (step.kind === 'operation') {
      const key = `${step.engine}/${step.operation}`;
      if (!getNode(key)) {
        out.push({ step: at, code: 'unknown_operation', message: `step ${where}: no such operation "${key}"` });
        return;
      }
      // params starting with $ are executor bindings, resolved at run time
      const params = (step.params ?? {}) as Record<string, unknown>;
      const literal = Object.fromEntries(
        Object.entries(params).filter(([, v]) => typeof v !== 'string' || !v.startsWith('$')),
      );
      const bound = Object.keys(params).filter((k) => !(k in literal));
      const inputIsBinding = typeof step.input === 'string' && step.input.startsWith('$');
      for (const e of validateParams(key, literal, inputIsBinding ? [...bound, 'input'] : bound)) {
        out.push({ step: at, code: 'bad_param', message: `step ${where}: ${e.message}` });
      }
    }

    if (step.kind === 'graph' && step.graph) {
      for (const d of preflight(step.graph as Graph)) {
        out.push({
          step: at,
          code: d.code === 'cycle' || d.code === 'fan_out_twice' ? 'graph_loop' : 'bad_graph',
          message: `step ${where}: ${d.code}, ${d.message}`,
        });
      }
    }

    if (step.kind === 'fanout' && Array.isArray(step.body)) {
      out.push(...validatePlan(step.body as Step[], where));
    }
    if (step.kind === 'branch') {
      for (const k of ['then', 'else'] as const) {
        if (Array.isArray(step[k])) out.push(...validatePlan(step[k] as Step[], `${where}.${k}`));
      }
    }
  });

  return out;
}

/** The rung a plan actually reaches, which may exceed the card's own claim. */
export function actualRung(steps: Step[]): Rung {
  let max: Rung = 1;
  const walk = (list: Step[]) => {
    for (const s of list) {
      const r: Rung =
        s.kind === 'timeline-op' ? 1 : s.kind === 'operation' ? 2 : s.kind === 'pipeline' ? 3 : s.kind === 'graph' ? 4 : 1;
      if (r > max) max = r;
      if (Array.isArray(s.body)) walk(s.body as Step[]);
      if (Array.isArray(s.then)) walk(s.then as Step[]);
      if (Array.isArray(s.else)) walk(s.else as Step[]);
    }
  };
  walk(steps);
  return max;
}
