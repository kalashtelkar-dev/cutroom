/**
 * Turning a plan into batches of work.
 *
 * The graph cannot loop, so every form of iteration lands here: a `fanout`
 * step is a gate that expands into one child chain per item, and the step
 * after the gate waits for all of them. That is the whole reason the executor
 * exists as a separate layer from the compiler.
 *
 * Two scheduling rules carry the weight:
 *
 *  - **An engine we have no capacity number for gets a cap of one.** The
 *    failure this prevents is fifty GPU jobs accepted against two workers:
 *    everything queues, nothing reports progress, and cancelling has to
 *    unwind fifty server-side runs. A starved tier degrading to sequential is
 *    slower and always recoverable.
 *  - **Plan steps are sequential unless they say otherwise.** A card's plan
 *    is authored as a pipeline, step two consumes `$candidates` from step
 *    one, and nothing in the step shape declares that. Assuming independence
 *    would run a trim before its source exists. A step that really is
 *    independent says so with an explicit `needs: []`.
 */
import type { Step } from '../intel/types.ts';
import type { ExecutorLimits } from './types.ts';
import { getNode } from '../editor-api/catalogue.ts';
import { actualRung } from '../router/plan.ts';

export type Tier = 'cpu' | 'gpu' | 'any';

/** Steps that never reach an engine: a local patch, a fanout gate, a branch. */
export const LOCAL_ENGINE = 'local';

export interface ScheduledStep {
  id: string;
  step: Step;
  /** ids that must be complete before this runs. */
  needs: string[];
  /** Position in the plan. Children share their gate's, so the UI nests them. */
  index: number;
  engine: string;
  tier: Tier;
  label: string;
  rung: number;
  /** Set on an expanded child: the gate it came from. */
  parent?: string;
  /** Set on a fanout child: which item of the list it is. */
  itemIndex?: number;
  /** On a gate: how many of its children may run at once. */
  maxParallel?: number;
}

export interface ScheduleOptions {
  /**
   * Item counts for fanout gates, by gate id.
   *
   * A fanout's width is only known once the step producing the list has run,
   * so the executor expands gates as it reaches them. A standalone schedule
   * passes the counts in; a gate with no count and no literal list schedules
   * as a gate with no children.
   */
  fanoutSizes?: Record<string, number>;
  /** Which side of each branch is taken, by gate id. */
  branches?: Record<string, 'then' | 'else'>;
  /** Prefix for generated ids. */
  idPrefix?: string;
  /** ids the first step must wait for, when splicing a sub-plan in. */
  after?: string[];
}

export const DEFAULT_LIMITS: ExecutorLimits = {
  maxParallelPerEngine: {},
  maxParallel: 4,
  maxRepairRounds: 2,
  maxRetriesPerStep: 3,
};

export const withDefaults = (limits: Partial<ExecutorLimits> = {}): ExecutorLimits => ({
  ...DEFAULT_LIMITS,
  ...limits,
  maxParallelPerEngine: { ...DEFAULT_LIMITS.maxParallelPerEngine, ...limits.maxParallelPerEngine },
});

const NO_IDS: ReadonlySet<string> = new Set();

export class ScheduleError extends Error {
  readonly cycle: string[] | undefined;
  /**
   * The step the bad edge belongs to, when there is one.
   *
   * The executor turns a schedule failure into a `step.failed` event, and an
   * event has to name a row or the UI marks the wrong step. Only the thrower
   * knows which step that is.
   */
  readonly stepId: string | undefined;
  constructor(message: string, about: { cycle?: string[]; stepId?: string } = {}) {
    super(message);
    this.name = 'ScheduleError';
    this.cycle = about.cycle;
    this.stepId = about.stepId;
  }
}

// ── describing one step ─────────────────────────────────────────────────

export interface StepFacts {
  engine: string;
  tier: Tier;
  label: string;
  rung: number;
  maxParallel?: number;
}

/**
 * What a step costs and who runs it.
 *
 * The tier comes from the catalogue's `gpu` flag rather than the engine name,
 * because the flag is per node and the engine name is not a promise:
 * `ffmpeg/trim` is gpu while `imagemagick/blur` is cpu, and nothing stops a
 * later catalogue from giving one engine nodes of both kinds. A node we have
 * no entry for is `any` rather than a guess, which lets it run anywhere.
 */
export function describeStep(step: Step): StepFacts {
  const rung = actualRung([step]);
  switch (step.kind) {
    case 'operation': {
      const engine = String(step.engine ?? 'unknown');
      const key = `${engine}/${String(step.operation ?? '')}`;
      const node = getNode(key);
      return { engine, tier: node ? (node.gpu ? 'gpu' : 'cpu') : 'any', label: key, rung };
    }
    case 'pipeline':
      return { engine: 'pipeline', tier: 'any', label: `pipeline ${String(step.pipelineId ?? '?')}`, rung };
    case 'graph':
      return { engine: 'graph', tier: 'any', label: 'ad-hoc graph', rung };
    case 'timeline-op':
      return { engine: LOCAL_ENGINE, tier: 'any', label: `timeline ${String(step.op ?? '?')}`, rung };
    case 'read-json':
      return {
        engine: LOCAL_ENGINE,
        tier: 'any',
        label: `read ${String((step as { pick?: unknown }).pick ?? 'output')}`,
        rung,
      };
    case 'fanout': {
      const n = Number(step.maxParallel);
      return {
        engine: LOCAL_ENGINE,
        tier: 'any',
        label: `for each ${String(step.over ?? 'item')}`,
        rung,
        ...(Number.isFinite(n) && n >= 1 ? { maxParallel: Math.floor(n) } : {}),
      };
    }
    case 'branch':
      return { engine: LOCAL_ENGINE, tier: 'any', label: `branch on ${String(step.when ?? step.cond ?? '?')}`, rung };
    default:
      return { engine: LOCAL_ENGINE, tier: 'any', label: String(step.kind), rung };
  }
}

export const stepLabel = (step: Step): string => describeStep(step).label;

/** A step may name itself; otherwise its position in the plan names it. */
export function stepIdOf(step: Step, index: number, prefix = 's'): string {
  const explicit = step.id;
  return typeof explicit === 'string' && explicit.length > 0 ? explicit : `${prefix}${index}`;
}

const literalSize = (step: Step): number | null =>
  Array.isArray(step.over) ? (step.over as unknown[]).length : null;

// ── flattening a plan ───────────────────────────────────────────────────

export function planSteps(steps: readonly Step[], opts: ScheduleOptions = {}): ScheduledStep[] {
  const prefix = opts.idPrefix ?? 's';
  const out: ScheduledStep[] = [];
  let prev: string[] = opts.after ? [...opts.after] : [];

  steps.forEach((step, i) => {
    const id = stepIdOf(step, i, prefix);
    const declared = Array.isArray(step.needs)
      ? (step.needs as unknown[]).filter((n): n is string => typeof n === 'string')
      : null;
    const facts = describeStep(step);
    const node: ScheduledStep = {
      id,
      step,
      needs: declared ?? prev,
      index: i,
      engine: facts.engine,
      tier: facts.tier,
      label: facts.label,
      rung: facts.rung,
      ...(facts.maxParallel !== undefined ? { maxParallel: facts.maxParallel } : {}),
    };
    out.push(node);
    prev = [id];

    if (step.kind === 'fanout') {
      const n = opts.fanoutSizes?.[id] ?? literalSize(step);
      if (n !== null) out.push(...expandFanout(node, n, opts));
    } else if (step.kind === 'branch') {
      const side = opts.branches?.[id];
      if (side) out.push(...expandBranch(node, side, opts));
    }
  });

  return out;
}

/** One child chain per item. Called again at run time once the width is known. */
export function expandFanout(gate: ScheduledStep, count: number, opts: ScheduleOptions = {}): ScheduledStep[] {
  const body = Array.isArray(gate.step.body) ? (gate.step.body as Step[]) : [];
  const out: ScheduledStep[] = [];
  for (let k = 0; k < Math.max(0, Math.floor(count)); k++) {
    out.push(...childrenOf(gate, body, `${gate.id}#${k}`, k, opts));
  }
  return out;
}

export function expandBranch(gate: ScheduledStep, side: 'then' | 'else', opts: ScheduleOptions = {}): ScheduledStep[] {
  const body = Array.isArray(gate.step[side]) ? (gate.step[side] as Step[]) : [];
  return childrenOf(gate, body, `${gate.id}.${side}`, null, opts);
}

function childrenOf(
  gate: ScheduledStep,
  body: readonly Step[],
  prefix: string,
  itemIndex: number | null,
  opts: ScheduleOptions,
): ScheduledStep[] {
  const out: ScheduledStep[] = [];
  let prev: string[] = [gate.id];

  body.forEach((step, j) => {
    // A child never takes the step's own `id`: the same body is instantiated
    // once per item and the ids would collide across items.
    const id = `${prefix}.${j}`;
    const facts = describeStep(step);
    const node: ScheduledStep = {
      id,
      step,
      needs: prev,
      index: gate.index,
      parent: gate.id,
      engine: facts.engine,
      tier: facts.tier,
      label: itemIndex === null ? facts.label : `${facts.label} [${itemIndex}]`,
      rung: facts.rung,
      ...(itemIndex === null ? {} : { itemIndex }),
      ...(facts.maxParallel !== undefined ? { maxParallel: facts.maxParallel } : {}),
    };
    out.push(node);
    prev = [id];

    if (step.kind === 'fanout') {
      const n = opts.fanoutSizes?.[id] ?? literalSize(step);
      if (n !== null) out.push(...expandFanout(node, n, opts));
    }
  });

  return out;
}

// ── ordering ────────────────────────────────────────────────────────────

/** Dependency order, with the two things that would otherwise deadlock. */
export function topoOrder(all: readonly ScheduledStep[]): ScheduledStep[] {
  const byId = new Map(all.map((s) => [s.id, s]));
  const colour = new Map<string, 'grey' | 'black'>();
  const stack: string[] = [];
  const order: ScheduledStep[] = [];

  const walk = (s: ScheduledStep): void => {
    if (colour.get(s.id) === 'black') return;
    if (colour.get(s.id) === 'grey') {
      const cycle = [...stack.slice(stack.indexOf(s.id)), s.id];
      throw new ScheduleError(
        `plan steps loop: ${cycle.join(' -> ')}. Steps form a DAG; repeating work is a fanout, not a back edge.`,
        { cycle, stepId: s.id },
      );
    }
    colour.set(s.id, 'grey');
    stack.push(s.id);
    for (const n of s.needs) {
      const dep = byId.get(n);
      if (!dep) {
        throw new ScheduleError(`step "${s.id}" needs "${n}", which is not in the plan`, { stepId: s.id });
      }
      walk(dep);
    }
    stack.pop();
    colour.set(s.id, 'black');
    order.push(s);
  };

  for (const s of all) walk(s);
  return order;
}

const childIndex = (all: readonly ScheduledStep[]): Map<string, ScheduledStep[]> => {
  const kids = new Map<string, ScheduledStep[]>();
  for (const s of all) {
    if (!s.parent) continue;
    const list = kids.get(s.parent);
    if (list) list.push(s);
    else kids.set(s.parent, [s]);
  }
  return kids;
};

/**
 * How many jobs of one engine may be in flight.
 *
 * No number means one, not `maxParallel`, see the header. `local` is exempt
 * because a timeline patch is a 20ms in-process call that occupies no worker.
 */
export function engineCap(engine: string, limits: ExecutorLimits): number {
  if (engine === LOCAL_ENGINE) return limits.maxParallel;
  const n = limits.maxParallelPerEngine[engine];
  if (n == null || !Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), limits.maxParallel);
}

/**
 * The next set of ids that may run at once.
 *
 * `done` holds ids that have finished. A gate counts as finished for the step
 * *after* it only once its whole subtree has finished, but for its own
 * children it counts as soon as it has expanded, which is what lets them
 * start at all.
 *
 * `skip` holds ids that have finished *failing*. They cannot go in `done`,
 * because `done` is also what satisfies a downstream `needs` and nothing
 * downstream of a failed step may run, and they cannot be left out of both,
 * because then every call hands the caller the same dead step again. Skipping
 * them here rather than filtering the returned batch is what keeps the
 * parallelism caps accounted for: a dead step must not eat a slot.
 */
export function nextBatch(
  all: readonly ScheduledStep[],
  done: ReadonlySet<string>,
  limits: ExecutorLimits = DEFAULT_LIMITS,
  skip: ReadonlySet<string> = NO_IDS,
): string[] {
  const byId = new Map(all.map((s) => [s.id, s]));
  const kids = childIndex(all);

  const subtreeDone = (id: string): boolean => {
    if (!done.has(id)) return false;
    const list = kids.get(id);
    return !list || list.every((c) => subtreeDone(c.id));
  };

  const insideOf = (s: ScheduledStep, gateId: string): boolean => {
    let cur: ScheduledStep | undefined = s;
    while (cur?.parent) {
      if (cur.parent === gateId) return true;
      cur = byId.get(cur.parent);
    }
    return false;
  };

  const batch: string[] = [];
  const perEngine = new Map<string, number>();
  const perGate = new Map<string, number>();

  for (const s of topoOrder(all)) {
    if (batch.length >= limits.maxParallel) break;
    if (done.has(s.id) || skip.has(s.id)) continue;
    if (!s.needs.every((n) => (insideOf(s, n) ? done.has(n) : subtreeDone(n)))) continue;

    const used = perEngine.get(s.engine) ?? 0;
    if (used >= engineCap(s.engine, limits)) continue;

    if (s.parent) {
      const gate = byId.get(s.parent);
      const cap = Math.max(1, gate?.maxParallel ?? limits.maxParallel);
      const running = perGate.get(s.parent) ?? 0;
      if (running >= cap) continue;
      perGate.set(s.parent, running + 1);
    }

    perEngine.set(s.engine, used + 1);
    batch.push(s.id);
  }

  return batch;
}

/**
 * Every batch, front to back. The executor does not use this, it re-derives
 * one batch at a time because a fanout's width is discovered mid-run, but it
 * is what you read, and test, to see what a plan will actually do.
 */
export function scheduleSteps(
  steps: readonly Step[],
  limits: Partial<ExecutorLimits> = {},
  opts: ScheduleOptions = {},
): string[][] {
  const all = planSteps(steps, opts);
  const full = withDefaults(limits);
  const done = new Set<string>();
  const batches: string[][] = [];

  while (done.size < all.length) {
    const batch = nextBatch(all, done, full);
    if (batch.length === 0) {
      const stuck = all.filter((s) => !done.has(s.id)).map((s) => s.id);
      throw new ScheduleError(`schedule stalled with ${stuck.length} steps unreachable: ${stuck.join(', ')}`);
    }
    batches.push(batch);
    for (const id of batch) done.add(id);
  }

  return batches;
}
