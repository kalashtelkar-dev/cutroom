'use client';

/**
 * The assistant panel.
 *
 * A peer of the media pool rather than a drawer over the editor: the two
 * things you point at footage with (your hands and a sentence) belong in
 * the same column.
 *
 * This is the one component allowed to fetch, and it calls exactly one route:
 * POST /api/route, which is arithmetic over the intel cards and costs nothing.
 * What comes back is a *plan*, not an edit, and the panel shows the plan,
 * which card won, which of its phrases fired, what it beat and by how much,
 * before anything is executed. When no card claims a phrase in the prompt the
 * router declines, and the panel says so rather than inventing an action:
 * silence is the right answer more often than a confident guess.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RunCard } from './RunCard.tsx';
import { ToolRunCard, type ToolRunArgs } from './ToolRunCard.tsx';
import type { Tool } from '../rail/tools.ts';
import { getCard } from '@/lib/intel/index.ts';
import type { Step } from '@/lib/intel/index.ts';
import type { Plan, PlanProblem } from '@/lib/router/plan.ts';
import type { RunState } from '@/lib/executor/types.ts';

/** Exactly what POST /api/route answers with. */
export interface RouteReply {
  prompt: string;
  plan: Plan | null;
  declined: string | null;
  reachedRung: number | null;
  problems: PlanProblem[];
  summary: string | null;
  considered: { id: string; score: number; rung: number; cost: string; matched: string[] }[];
  vetoed: { id: string; by: string }[];
}

export interface AssistantProps {
  runs: RunState[];
  /** Run id → the phrase the run is for. */
  runTitles?: Record<string, string>;
  /** The tool the rail armed, waiting on its run card. */
  armed: Tool | null;
  armedTargets: string[];
  disabledTargets?: number[];
  busy?: boolean;
  onArmedRun: (tool: Tool, args: ToolRunArgs) => void;
  onArmedCancel: () => void;
  /** A plan arrived. The shell decides whether to execute it. */
  onRouted?: (prompt: string, reply: RouteReply) => void;
  /** Execute a plan that won routing. */
  onRunPlan?: (plan: Plan) => void;
  /** Overrides the chips, which otherwise come from the cards' own examples. */
  suggestions?: string[];
}

type EntryBody =
  | { kind: 'user'; text: string }
  | { kind: 'routed'; reply: RouteReply }
  | { kind: 'note'; text: string };

type Entry = EntryBody & { id: number };

/**
 * The chips are the cards' own quoted examples, not a hand-written list.
 * A suggestion that does not route is worse than no suggestion, and the only
 * phrases guaranteed to route are the ones the cards claim.
 */
function exampleChips(): string[] {
  const wanted = ['auto-broll-weave', 'tighten-cut', 'timeline-punch', 'timeline-blade'];
  return wanted
    .map((id) => getCard(id)?.examples[0])
    .filter((s): s is string => !!s)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
}

export function Assistant({
  runs,
  runTitles = {},
  armed,
  armedTargets,
  disabledTargets,
  busy = false,
  onArmedRun,
  onArmedCancel,
  onRouted,
  onRunPlan,
  suggestions,
}: AssistantProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState('');
  const [routing, setRouting] = useState(false);
  const log = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);
  const abort = useRef<AbortController | null>(null);

  const chips = useMemo(() => suggestions ?? exampleChips(), [suggestions]);

  useEffect(() => () => abort.current?.abort(), []);

  // pin to the bottom whenever anything lands, which is what a log is for
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, runs, armed]);

  const push = useCallback((e: EntryBody) => {
    seq.current += 1;
    setEntries((prev) => [...prev, { ...e, id: seq.current }]);
  }, []);

  const send = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed || routing) return;
      push({ kind: 'user', text: trimmed });
      setText('');
      setRouting(true);
      abort.current?.abort();
      const ctl = new AbortController();
      abort.current = ctl;
      try {
        const res = await fetch('/api/route', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: trimmed }),
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`router answered ${res.status}`);
        const reply = (await res.json()) as RouteReply;
        push({ kind: 'routed', reply });
        onRouted?.(trimmed, reply);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        push({ kind: 'note', text: `Could not reach the router, ${(err as Error).message}.` });
      } finally {
        setRouting(false);
      }
    },
    [routing, push, onRouted],
  );

  return (
    <>
      <style href="cutroom-assistant" precedence="medium">{CSS}</style>
      <div className="cr-chat">
        <div className="cr-chatlog" ref={log} role="log" aria-label="Assistant log" aria-live="polite">
          {entries.length === 0 ? (
            <p className="cr-chatempty">
              Say what you want done. The router picks the tool whose card claims
              your words, and shows you the plan before anything runs.
            </p>
          ) : null}

          {entries.map((e) =>
            e.kind === 'user' ? (
              <p className="cr-msg-u" key={e.id}>{e.text}</p>
            ) : e.kind === 'note' ? (
              <p className="cr-msg-a" key={e.id}>{e.text}</p>
            ) : (
              <PlanBlock key={e.id} reply={e.reply} onRunPlan={onRunPlan} busy={busy} />
            ),
          )}

          {runs.map((run) => (
            <RunCard key={run.runId} run={run} title={runTitles[run.runId]} />
          ))}

          {armed ? (
            <ToolRunCard
              tool={armed}
              targets={armedTargets}
              disabledTargets={disabledTargets}
              busy={busy}
              onRun={onArmedRun}
              onCancel={onArmedCancel}
            />
          ) : null}
        </div>

        <div className="cr-composer">
          <div className="cr-hints">
            {chips.map((c) => (
              <button
                key={c}
                type="button"
                className="cr-hint"
                disabled={routing || busy}
                onClick={() => void send(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); void send(text); }}
          >
            <label className="cr-sr" htmlFor="cr-chat-input">Tell the editor what to do</label>
            <textarea
              id="cr-chat-input"
              value={text}
              spellCheck={false}
              placeholder="Tell the editor what to do…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter is a newline, as every chat does
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); }
              }}
            />
            <button type="submit" disabled={routing || busy || !text.trim()}>
              {routing ? 'Routing…' : 'Run'}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}

// ── the plan, shown before it is executed ──────────────────────────────

function PlanBlock({
  reply,
  onRunPlan,
  busy = false,
}: {
  reply: RouteReply;
  onRunPlan?: (plan: Plan) => void;
  busy?: boolean;
}) {
  if (!reply.plan) {
    return (
      <div className="cr-declined">
        <b>No tool claims that.</b>
        <span>{reply.declined ?? 'Nothing matched.'}</span>
      </div>
    );
  }
  const p = reply.plan;
  return (
    <div className="cr-plan">
      <div className="cr-planhd">
        <b>{p.cardId}</b>
        <span className="cr-planrung" data-tier={p.rung <= 1 ? 0 : p.rung === 2 ? 1 : 2}>
          rung {p.rung}
        </span>
        <span className="cr-plancost">{p.cost}</span>
      </div>
      {reply.summary ? <p className="cr-plansum">{reply.summary}</p> : null}
      <p className="cr-planwhy">{p.rationale}</p>
      <ol className="cr-steps">
        {p.steps.map((s, i) => <StepRow key={i} step={s} />)}
      </ol>
      {p.fragile ? (
        <p className="cr-planwarn">
          Won by {p.margin.toFixed(1)}, a fragile choice. Another card is nearly as good,
          so a slightly different phrasing would route somewhere else.
        </p>
      ) : null}
      {reply.problems.length ? (
        <ul className="cr-planprob">
          {reply.problems.map((pr, i) => (
            <li key={i}><span>{pr.code}</span> {pr.message}</li>
          ))}
        </ul>
      ) : null}
      {reply.reachedRung !== null && reply.reachedRung > p.rung ? (
        <p className="cr-planwarn">
          The steps reach rung {reply.reachedRung}, above the rung {p.rung} the card claims.
        </p>
      ) : null}
      <div className="cr-planfoot">
        <button
          type="button"
          className="cr-planbtn"
          disabled={busy || reply.problems.length > 0}
          onClick={() => onRunPlan?.(p)}
        >
          {busy ? 'Running...' : `Run ${p.cardId}`}
        </button>
      </div>
    </div>
  );
}

function StepRow({ step, depth = 0 }: { step: Step; depth?: number }) {
  const body = Array.isArray(step.body) ? (step.body as Step[]) : null;
  return (
    <>
      <li style={{ paddingLeft: depth * 12 }}>
        <span className="cr-stepkind">{step.kind}</span>
        <span className="cr-stepwhat">{stepLabel(step)}</span>
      </li>
      {body?.map((child, i) => <StepRow key={i} step={child} depth={depth + 1} />)}
    </>
  );
}

/** A step in one line. Unknown fields are simply not shown, never guessed at. */
function stepLabel(step: Step): string {
  const s = (k: string): string => (step[k] == null ? '' : String(step[k]));
  switch (step.kind) {
    case 'timeline-op':
      return [s('op'), s('track') && `→ ${s('track')}`, s('target')].filter(Boolean).join(' ');
    case 'operation':
      return `${s('engine')}/${s('operation')}`;
    case 'pipeline':
      return s('pipelineId');
    case 'graph':
      return s('note') || 'ad-hoc graph';
    case 'fanout':
      return `over ${s('over')}${step.maxParallel ? ` · ${s('maxParallel')} at a time` : ''}`;
    case 'branch':
      return s('on') || 'conditional';
    default:
      return '';
  }
}

const CSS = `
.cr-sr{
  position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip-path:inset(50%);white-space:nowrap;border:0;
}
.cr-chat{display:flex;flex-direction:column;height:100%;min-height:0;font-family:var(--ui)}
.cr-chatlog{
  flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:12px;min-height:0;
}
.cr-chatempty{margin:0;font-size:12px;line-height:1.55;color:var(--t3)}
.cr-msg-u{
  margin:0;background:var(--panel-2);border-left:2px solid var(--orange);
  padding:8px 10px;border-radius:0 2px 2px 0;color:var(--t1);
  font-size:12.5px;line-height:1.5;white-space:pre-wrap;
}
.cr-msg-a{margin:0;color:var(--t2);font-size:12.5px;line-height:1.5}

.cr-declined{
  border:1px solid var(--edge-soft);border-left:2px solid var(--yellow);
  border-radius:0 4px 4px 0;padding:8px 10px;display:flex;flex-direction:column;gap:4px;
}
.cr-declined b{font-size:11.5px;color:var(--t1)}
.cr-declined span{font-size:11.5px;color:var(--t2);line-height:1.5}

.cr-plan{border:1px solid var(--edge-soft);border-radius:4px;background:var(--panel);overflow:hidden}
.cr-planhd{
  display:flex;align-items:center;gap:7px;padding:7px 10px;
  background:var(--panel-2);border-bottom:1px solid var(--edge-soft);
}
.cr-planhd b{font-family:var(--mono);font-size:11px;color:var(--t1);flex:1;min-width:0}
.cr-planrung{
  font-family:var(--mono);font-size:9px;padding:1px 5px;border-radius:4px;flex:none;
  background:var(--edge);color:var(--t2);
}
.cr-planrung[data-tier="1"]{color:var(--yellow)}
.cr-planrung[data-tier="2"]{color:var(--orange)}
.cr-plancost{font-family:var(--mono);font-size:9.5px;color:var(--t3);flex:none}
.cr-plansum{margin:0;padding:8px 10px 0;font-size:11.5px;color:var(--t2);line-height:1.5}
.cr-planwhy{margin:0;padding:5px 10px 8px;font-size:11px;color:var(--t3);line-height:1.5}
.cr-steps{list-style:none;margin:0;padding:0 10px 9px;display:flex;flex-direction:column;gap:3px}
.cr-steps li{display:flex;gap:8px;align-items:baseline;font-family:var(--mono);font-size:10px}
.cr-stepkind{color:var(--t3);width:82px;flex:none}
.cr-stepwhat{color:var(--t2);flex:1;min-width:0;word-break:break-word}
.cr-planwarn{
  margin:0;padding:7px 10px;border-top:1px solid var(--edge);
  font-size:11px;color:var(--yellow);line-height:1.45;
}
.cr-planprob{
  list-style:none;margin:0;padding:7px 10px;border-top:1px solid var(--edge);
  display:flex;flex-direction:column;gap:3px;
}
.cr-planprob li{font-size:11px;color:var(--t2);line-height:1.45}
.cr-planprob span{font-family:var(--mono);font-size:10px;color:var(--red);margin-right:5px}
.cr-planfoot{
  padding:8px 10px;border-top:1px solid var(--edge);background:var(--head);
  display:flex;justify-content:flex-end;gap:8px;align-items:center;
}
.cr-planbtn{
  background:var(--orange);color:var(--on-accent);font-weight:600;font-size:11.5px;
  padding:5px 12px;border-radius:4px;border:0;cursor:pointer;font-family:inherit;
  transition:filter .12s,background .12s;
}
.cr-planbtn:hover:not(:disabled){filter:brightness(1.1)}
.cr-planbtn:disabled{background:var(--ctl-off);color:var(--t3);cursor:not-allowed}

.cr-composer{flex:none;border-top:1px solid var(--edge);background:var(--panel-2);padding:9px}
.cr-hints{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
.cr-hint{
  font-size:10.5px;color:var(--t2);border:1px solid var(--edge-soft);
  padding:3px 7px;border-radius:4px;background:var(--panel);cursor:pointer;font-family:inherit;
}
.cr-hint:hover:not(:disabled){border-color:var(--orange);color:var(--t1)}
.cr-hint:disabled{opacity:.45;cursor:not-allowed}
.cr-composer form{display:flex;gap:7px;align-items:flex-end}
.cr-composer textarea{
  flex:1;background:var(--app);border:1px solid var(--edge-soft);border-radius:4px;
  color:var(--t1);font-family:var(--ui);font-size:12.5px;padding:7px 9px;resize:none;
  height:56px;line-height:1.4;
}
.cr-composer textarea:focus{outline:none;border-color:var(--orange)}
.cr-composer form button{
  background:var(--orange);color:var(--t1);font-weight:700;font-size:11.5px;
  padding:8px 13px;border-radius:4px;letter-spacing:.02em;border:0;cursor:pointer;
  font-family:inherit;
}
.cr-composer form button:disabled{background:var(--ctl-off);color:var(--t3);cursor:not-allowed}
`;
