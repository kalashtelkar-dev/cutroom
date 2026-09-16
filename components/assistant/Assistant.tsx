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
import { allCards } from '@/lib/intel/index.ts';
import type { Answer, Question, Step } from '@/lib/intel/index.ts';
import type { Plan, PlanProblem } from '@/lib/router/plan.ts';
// one place decides what a step is called, so the run card and the plan
// cannot disagree about it, and neither can name an engine
import { stepLabel } from '@/lib/executor/schedule.ts';
import type { RunState } from '@/lib/executor/types.ts';

/** Exactly what POST /api/route answers with. */
export interface RouteReply {
  prompt: string;
  plan: Plan | null;
  declined: string | null;
  reachedRung: number | null;
  problems: PlanProblem[];
  summary: string | null;
  /** Still to settle before this can run, in the order to ask. */
  pending: Question[];
  answers: Answer[];
  bindings: Record<string, string | boolean>;
  considered: { id: string; score: number; rung: number; cost: string; matched: string[] }[];
  vetoed: { id: string; by: string }[];
}

/** One answer on its way back to the router: the label, never the bindings. */
export interface PickedAnswer {
  questionId: string;
  label: string;
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
  /**
   * Run a plan that has nothing left to ask.
   *
   * `bindings` are what the answers settled, and they are what the steps'
   * `$name` references resolve against. The shell adds the ones only it knows,
   * the source key above all, and refuses the run if it cannot.
   */
  onRunPlan?: (plan: Plan, bindings: Record<string, string | boolean>) => void;
  /**
   * The shell's latest word, to be kept rather than flashed.
   *
   * What a run did was reported by a toast and by nothing else, so "14
   * captions on the timeline, in Hindi" was on screen for 2.6 seconds and
   * then gone, and the panel that had been asked to put subtitles on the cut
   * never said whether it had. A toast is right for "saved"; the answer to a
   * question belongs in the log with the question. The shell still raises
   * both, and this is the half that stays.
   *
   * Identified rather than compared by text, because two runs can honestly
   * report the same sentence and both are worth showing.
   */
  notice?: { id: number; text: string } | null;
  /** Overrides the chips, which otherwise come from the cards' own examples. */
  suggestions?: string[];
}

type EntryBody =
  | { kind: 'user'; text: string }
  | { kind: 'routed'; reply: RouteReply }
  /**
   * A question, and the answers that have accumulated under it.
   *
   * The whole conversation for one request lives in a single entry rather than
   * one per round trip, so answering does not push three cards into the log
   * for what a person experiences as one exchange. `asked` is the question on
   * screen; when it is null the exchange is settled and the entry is a record
   * of what was chosen.
   */
  | { kind: 'ask'; prompt: string; reply: RouteReply; asked: Question | null; picked: PickedAnswer[] }
  | { kind: 'note'; text: string };

type Entry = EntryBody & { id: number };

/**
 * The chips are the cards' own quoted examples, not a hand-written list.
 * A suggestion that does not route is worse than no suggestion, and the only
 * phrases guaranteed to route are the ones the cards claim.
 *
 * Read off the cards in play rather than a list of ids, which is what the
 * paragraph above always claimed and was not quite true: the ids were named
 * here, so archiving those cards left four chips that silently resolved to
 * nothing and a row that rendered empty. Taking whatever is on the shelf
 * means the row follows the cards without anyone remembering to come here.
 *
 * Two per card before a second from any, so one talkative card cannot fill
 * the row while another goes unmentioned.
 */
const CHIP_LIMIT = 4;

/**
 * What a card is called on screen.
 *
 * `subtitle-burn` is an id, and an id is for the router and the repo. The
 * card names itself in its front matter; failing that, its id reads as words.
 */
function toolName(cardId: string): string {
  const card = allCards().find((c) => c.id === cardId);
  const named = card?.meta.name ?? card?.meta.tool_name;
  if (named) return named;
  return cardId.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function exampleChips(): string[] {
  const cards = allCards();
  const out: string[] = [];
  for (let round = 0; round < 2; round++) {
    for (const card of cards) {
      const example = card.examples[round];
      if (!example || out.length >= CHIP_LIMIT) continue;
      out.push(example.charAt(0).toUpperCase() + example.slice(1));
    }
  }
  return out;
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
  notice = null,
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

  /**
   * The next entry id, taken NOW rather than when React gets round to it.
   *
   * `push` used to read `seq.current` from inside the updater, which is not
   * where it was incremented. An updater runs at render, so anything that
   * bumped the counter in between was the value it saw: pushing the user's
   * line and then allocating an id for the reply handed BOTH entries the same
   * number. Two entries with one id is a duplicate React key, and the update
   * that rewrites "the router is thinking" into the answer matched them both,
   * so the panel showed the question twice and the sentence that had been
   * typed not at all.
   */
  const nextId = useCallback(() => {
    seq.current += 1;
    return seq.current;
  }, []);

  const push = useCallback((e: EntryBody) => {
    const id = nextId();
    setEntries((prev) => [...prev, { ...e, id }]);
  }, [nextId]);

  /**
   * The shell's notices, into the log, in the order they arrived.
   *
   * Keyed on the notice's own id: the shell clears it to null when its toast
   * has faded, and the same sentence can be said twice by two honest runs.
   */
  const lastNotice = useRef<number | null>(null);
  useEffect(() => {
    if (!notice || notice.id === lastNotice.current) return;
    lastNotice.current = notice.id;
    push({ kind: 'note', text: notice.text });
  }, [notice, push]);

  /**
   * Ask the router, with whatever has been settled so far.
   *
   * One request serves both halves of the exchange: the first ask and every
   * answer after it. The router is arithmetic over the cards, so asking it
   * again after each answer costs nothing and keeps one place deciding what
   * a set of answers means.
   */
  const ask = useCallback(
    async (prompt: string, picked: PickedAnswer[]): Promise<RouteReply> => {
      abort.current?.abort();
      const ctl = new AbortController();
      abort.current = ctl;
      const res = await fetch('/api/route', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, answers: picked }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`router answered ${res.status}`);
      return (await res.json()) as RouteReply;
    },
    [],
  );

  /**
   * Where an exchange lands: another question, or the run.
   *
   * Nothing waits on a second button once the questions are answered. The
   * chip the person clicked was the confirmation, and it was shown beside
   * the cost; making them click Run after it is a second confirmation of the
   * same decision. A prompt that answered everything by itself runs straight
   * away, which is what "put hindi subtitles on this" asked for.
   */
  const settle = useCallback(
    (entryId: number, prompt: string, reply: RouteReply, picked: PickedAnswer[]) => {
      if (!reply.plan) {
        setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, kind: 'routed', reply } as Entry : e)));
        return;
      }
      const asked = reply.pending[0] ?? null;
      setEntries((prev) =>
        prev.map((e) => (e.id === entryId ? { id: e.id, kind: 'ask', prompt, reply, asked, picked } : e)),
      );
      if (!asked && !reply.problems.length) onRunPlan?.(reply.plan, reply.bindings);
    },
    [onRunPlan],
  );

  /** The exchange still waiting on an answer, if there is one. */
  const open = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.kind === 'ask' && e.asked) return e;
      if (e.kind === 'ask' || e.kind === 'routed') return null;
    }
    return null;
  }, [entries]);

  const answer = useCallback(
    async (entry: Entry & { kind: 'ask' }, questionId: string, label: string) => {
      if (routing || !entry.asked) return;
      // answering again replaces the earlier answer rather than stacking on it
      const picked = [...entry.picked.filter((p) => p.questionId !== questionId), { questionId, label }];
      setRouting(true);
      try {
        settle(entry.id, entry.prompt, await ask(entry.prompt, picked), picked);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        push({ kind: 'note', text: `Could not reach the router, ${(err as Error).message}.` });
      } finally {
        setRouting(false);
      }
    },
    [routing, ask, settle, push],
  );

  const send = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed || routing) return;

      /**
       * Typing while a question is open answers it.
       *
       * The composer is the only text input on the panel, and a question with
       * an "Other…" chip has nowhere else to put the answer. Treating the
       * next sentence as a new request instead would route "marathi" on its
       * own, which no card claims, and the question would still be sitting
       * there unanswered underneath the refusal.
       */
      if (open?.asked) {
        setText('');
        push({ kind: 'user', text: trimmed });
        await answer(open, open.asked.id, trimmed);
        return;
      }

      push({ kind: 'user', text: trimmed });
      setText('');
      setRouting(true);
      const entryId = nextId();
      setEntries((prev) => [...prev, { id: entryId, kind: 'note', text: 'Routing…' }]);
      try {
        const reply = await ask(trimmed, []);
        settle(entryId, trimmed, reply, []);
        onRouted?.(trimmed, reply);
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          setEntries((prev) => prev.filter((e) => e.id !== entryId));
          return;
        }
        setEntries((prev) =>
          prev.map((e) =>
            e.id === entryId
              ? { id: e.id, kind: 'note', text: `Could not reach the router, ${(err as Error).message}.` }
              : e),
        );
      } finally {
        setRouting(false);
      }
    },
    [routing, push, nextId, onRouted, open, answer, ask, settle],
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
            ) : e.kind === 'ask' ? (
              <AskBlock
                key={e.id}
                entry={e}
                busy={busy || routing}
                onAnswer={(questionId, label) => void answer(e, questionId, label)}
              />
            ) : (
              <PlanBlock key={e.id} reply={e.reply} />
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
            <label className="cr-sr" htmlFor="cr-chat-input">
              {open?.asked ? open.asked.ask : 'Tell the editor what to do'}
            </label>
            <textarea
              id="cr-chat-input"
              value={text}
              spellCheck={false}
              placeholder={open?.asked ? `${open.asked.ask} Or type one.` : 'Tell the editor what to do…'}
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

/**
 * A plan, and whatever the exchange still needs under it.
 *
 * Showing the plan has not stopped mattering now that answering runs it: what
 * changed is that the confirmation moved onto the answer. The card still says
 * which tool won, what its phrases were, what it costs and what it is about
 * to do, above the chips that set it going.
 */
function PlanBlock({ reply, footer }: { reply: RouteReply; footer?: React.ReactNode }) {
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
        <b>{toolName(p.cardId)}</b>
        <span className="cr-plancost">{p.cost}</span>
      </div>
      {reply.summary ? <p className="cr-plansum">{reply.summary}</p> : null}
      <ol className="cr-steps">
        {p.steps.map((s, i) => <StepRow key={i} step={s} />)}
      </ol>
      {reply.problems.length ? (
        <ul className="cr-planprob">
          {reply.problems.map((pr, i) => (
            <li key={i}><span>{pr.code}</span> {pr.message}</li>
          ))}
        </ul>
      ) : null}
      {footer}
    </div>
  );
}

/**
 * The plan, plus the question it is waiting on.
 *
 * One entry holds the whole exchange, so answering rewrites this card rather
 * than pushing another one under it. When nothing is left to ask, the same
 * card becomes the record of what was chosen, which is the thing you want to
 * read afterwards when the subtitles came out in the wrong language.
 */
function AskBlock({
  entry,
  busy,
  onAnswer,
}: {
  entry: Entry & { kind: 'ask' };
  busy: boolean;
  onAnswer: (questionId: string, label: string) => void;
}) {
  const { reply, asked } = entry;
  const settled = reply.answers.filter((a) => !asked || a.questionId !== asked.id);

  return (
    <PlanBlock
      reply={reply}
      footer={
        <div className="cr-askfoot">
          {settled.length ? (
            <ul className="cr-askdone">
              {settled.map((a) => (
                <li key={a.questionId}>
                  <span>{a.short}</span>
                  {a.label}
                  {a.fromPrompt ? <i> from what you typed</i> : null}
                  {a.assumed ? <i> assumed, say so to change it</i> : null}
                </li>
              ))}
            </ul>
          ) : null}

          {asked ? (
            <>
              <p className="cr-askq">{asked.ask}</p>
              <div className="cr-askchips">
                {asked.choices.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    className="cr-askchip"
                    disabled={busy}
                    onClick={() => onAnswer(asked.id, c.label)}
                  >
                    {c.label}
                  </button>
                ))}
                {asked.free ? <span className="cr-askfree">or type another below</span> : null}
              </div>
            </>
          ) : (
            <p className="cr-askgo">
              {reply.problems.length
                ? 'Nothing ran: the plan has a problem above.'
                : 'Nothing left to ask, so it is running.'}
            </p>
          )}
        </div>
      }
    />
  );
}

/**
 * One step, in the words the card wrote for it.
 *
 * It used to show the step's KIND and then `whisperx/subtitle`, `vllm/
 * translate`, `pipeline tpl_cdvkzzJeZylk`. Which engine does the work, which
 * operation of it, and under which saved id, are ours: a panel naming them
 * hands whoever is reading it the list of models this is built on. The card
 * gives every step a label and `describeStep` falls back to a generic phrase,
 * so there is nowhere for one to come through.
 */
function StepRow({ step, depth = 0 }: { step: Step; depth?: number }) {
  const children = [
    ...(Array.isArray(step.body) ? (step.body as Step[]) : []),
    ...(Array.isArray(step.then) ? (step.then as Step[]) : []),
    ...(Array.isArray(step.else) ? (step.else as Step[]) : []),
  ];
  return (
    <>
      <li style={{ paddingLeft: depth * 12 }}>
        <span className="cr-stepwhat">{stepLabel(step)}</span>
      </li>
      {children.map((child, i) => <StepRow key={i} step={child} depth={depth + 1} />)}
    </>
  );
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
.cr-askfoot{
  padding:8px 10px;border-top:1px solid var(--edge);background:var(--head);
  display:flex;flex-direction:column;gap:7px;
}
.cr-askdone{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.cr-askdone li{font-size:11px;color:var(--t2);line-height:1.45}
.cr-askdone span{
  font-family:var(--mono);font-size:9.5px;color:var(--t3);margin-right:6px;
}
.cr-askdone i{color:var(--t3);font-style:normal;font-size:10px;margin-left:5px}
.cr-askq{margin:0;font-size:11.5px;color:var(--t1);line-height:1.45}
.cr-askchips{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.cr-askchip{
  font-size:11px;color:var(--t1);border:1px solid var(--edge-soft);
  padding:3px 9px;border-radius:4px;background:var(--panel);cursor:pointer;
  font-family:inherit;transition:border-color .12s,color .12s;
}
.cr-askchip:hover:not(:disabled){border-color:var(--orange)}
.cr-askchip:disabled{opacity:.45;cursor:not-allowed}
.cr-askfree{font-size:10px;color:var(--t3)}
.cr-askgo{margin:0;font-size:11px;color:var(--t3);line-height:1.45}

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
