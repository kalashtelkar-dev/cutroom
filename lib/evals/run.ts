/**
 * Running the suite.
 *
 * Pure and synchronous: retrieval is arithmetic over the intel cards, so a
 * full run is sub-millisecond and the workbench can re-run it on every
 * keystroke in the card editor.
 */
import { route, FRAGILE_MARGIN } from '../router/plan.ts';
import type { RetrieveConfig } from '../router/retrieve.ts';
import { getCard } from '../intel/index.ts';
import { paraphrase, type EvalCase } from './cases.ts';

export interface CaseResult {
  case: EvalCase;
  got: string | null;
  ok: boolean;
  /** Routed to the right card but at the wrong price. */
  wrongRung: boolean;
  rung: number | null;
  margin: number;
  fragile: boolean;
  runnerUp: string | null;
  matched: string[];
  declined: string | null;
}

export interface SuiteResult {
  results: CaseResult[];
  passed: number;
  total: number;
  /** Won by less than FRAGILE_MARGIN: a paraphrase may well go elsewhere. */
  fragile: number;
  declined: number;
  /**
   * What the suite would cost if every case actually ran.
   *
   * The failure mode this whole layer guards against is expensive-but-correct:
   * a router that always reaches for the dearest tool passes every test and
   * bankrupts you. Putting the number on screen makes that visible.
   */
  gpuSeconds: number;
}

/** "45s/min · gpu" and "2-8s · cpu" both mean something; read the first number. */
export function costSeconds(cost: string): number {
  const gpu = /gpu/i.test(cost);
  const m = cost.match(/(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const base = Number(m[1]);
  return gpu ? base : base * 0.25;   // cpu work is cheap; count it, lightly
}

export function runCase(c: EvalCase, cfg: RetrieveConfig = {}): CaseResult {
  const r = route(c.prompt, cfg);
  const got = r.plan?.cardId ?? null;
  const runnerUp = r.live[1]?.card.id ?? null;
  return {
    case: c,
    got,
    ok: got === c.expect,
    // a case that wanted silence and got it has no plan to read a rung off,
    // and `r.plan!` on that case is a crash rather than a failing test
    wrongRung: Boolean(r.plan) && got === c.expect && r.plan!.rung !== c.rung,
    rung: r.plan?.rung ?? null,
    margin: r.plan?.margin ?? 0,
    fragile: Boolean(r.plan?.fragile),
    runnerUp,
    matched: r.live[0]?.why ?? [],
    declined: r.declined ?? null,
  };
}

export function runSuite(cases: EvalCase[], cfg: RetrieveConfig = {}): SuiteResult {
  const results = cases.map((c) => runCase(c, cfg));
  return {
    results,
    total: results.length,
    passed: results.filter((r) => r.ok && !r.wrongRung).length,
    fragile: results.filter((r) => r.ok && r.fragile).length,
    declined: results.filter((r) => r.got === null).length,
    gpuSeconds: results.reduce((sum, r) => {
      const card = r.got ? getCard(r.got) : undefined;
      return sum + (card ? costSeconds(card.cost) : 0);
    }, 0),
  };
}

export interface RobustnessResult {
  prompt: string;
  routedTo: string | null;
  variants: { prompt: string; routedTo: string | null; same: boolean }[];
  /** How many rewordings land on the same tool. */
  agree: number;
  total: number;
}

export function checkRobustness(prompt: string, cfg: RetrieveConfig = {}): RobustnessResult {
  const base = route(prompt, cfg).plan?.cardId ?? null;
  const variants = paraphrase(prompt).map((p) => {
    const routedTo = route(p, cfg).plan?.cardId ?? null;
    return { prompt: p, routedTo, same: routedTo === base };
  });
  return {
    prompt,
    routedTo: base,
    variants,
    agree: variants.filter((v) => v.same).length,
    total: variants.length,
  };
}

export { FRAGILE_MARGIN };
