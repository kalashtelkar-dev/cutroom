'use client';

/**
 * Bench: one sentence, explained.
 *
 * The point of this tab is that a wrong answer should be boring to diagnose.
 * Every number the router used is on screen: which card won, which of its own
 * phrases fired, what it beat and by how much, which cards were vetoed and by
 * which word, and what the plan would cost. A routing decision you cannot
 * explain is a routing decision you cannot fix.
 *
 * Routing runs here, in the browser, rather than through POST /api/route.
 * That is deliberate: the intel cards are module state, and the copy the
 * server holds is the copy on disk. After an edit in the Intel tab, the
 * server would answer with the old vocabulary, and the live loop the
 * workbench exists for would be a lie.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FRAGILE_MARGIN, actualRung, route, validatePlan,
  type PlanProblem, type RoutingResult, type Rung,
} from '@/lib/router/plan.ts';
import { rank, type Hit, type Ranking, type RetrieveConfig } from '@/lib/router/retrieve.ts';
import { checkRobustness, type RobustnessResult } from '@/lib/evals/run.ts';
import { blurb, getCard, type Step } from '@/lib/intel/index.ts';
import type { WorkbenchStore } from './useWorkbench.ts';

/** One config's answer to one prompt, with everything checkable checked. */
interface Side {
  ranking: Ranking;
  result: RoutingResult;
  problems: PlanProblem[];
  /** What the steps actually reach, which can be above what the card claims. */
  reached: Rung | null;
}

interface Run {
  prompt: string;
  a: Side;
  b: Side;
}

const STRICT: RetrieveConfig = { strictLadder: true };

function evaluate(prompt: string, cfg: RetrieveConfig): Side {
  const result = route(prompt, cfg);
  return {
    ranking: rank(prompt, cfg),
    result,
    problems: result.plan ? validatePlan(result.plan.steps) : [],
    reached: result.plan ? actualRung(result.plan.steps) : null,
  };
}

const makeRun = (prompt: string): Run => ({
  prompt,
  a: evaluate(prompt, {}),
  b: evaluate(prompt, STRICT),
});

const RUNGS: [Rung, string, string][] = [
  [1, 'timeline-op', 'about 20ms, local'],
  [2, 'operation', 'seconds'],
  [3, 'pipeline', '30s to 5m'],
  [4, 'graph', 'ad-hoc, variable'],
];

export function Bench({ wb }: { wb: WorkbenchStore }) {
  /**
   * The prompt that has been asked, as opposed to the prompt being typed.
   *
   * Routing on every keystroke would make the ranking flicker and the rate
   * bar meaningless, so Bench routes on submit. A prompt arriving from Evals
   * or from the Intel tab counts as a submit, which is what `promptToken` is
   * for: it changes only when someone asked for this prompt to be routed.
   */
  const [asked, setAsked] = useState(() => ({ token: wb.promptToken, prompt: wb.prompt.trim() }));
  const [showPara, setShowPara] = useState(false);
  const [showServer, setShowServer] = useState(false);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverData, setServerData] = useState<any>(null);
  if (asked.token !== wb.promptToken) setAsked({ token: wb.promptToken, prompt: wb.prompt.trim() });

  useEffect(() => {
    if (!showServer || !asked.prompt) {
      setServerData(null);
      return;
    }
    let cancelled = false;
    setServerLoading(true);
    fetch('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: asked.prompt, strictLadder: wb.strictLadder }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          setServerData(data);
          setServerLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setServerData(null);
          setServerLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [showServer, asked.prompt, wb.strictLadder]);

  /**
   * Re-routed whenever a card changes, so the answer on screen is never the
   * answer from before the edit in the Intel tab.
   */
  const run: Run = useMemo(() => {
    void wb.revision;   // the cards are module state; this is the signal they moved
    return makeRun(asked.prompt);
  }, [asked.prompt, wb.revision]);

  /**
   * The paraphrase check is derived rather than stored, so it follows the
   * prompt and the cards instead of going stale the moment either changes.
   */
  const para: RobustnessResult | null = useMemo(() => {
    void wb.revision;
    return showPara ? checkRobustness(asked.prompt, wb.strictLadder ? STRICT : {}) : null;
  }, [showPara, asked.prompt, wb.revision, wb.strictLadder]);

  const go = useCallback((prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      wb.notify('Type a prompt first');
      return;
    }
    setAsked({ token: wb.promptToken, prompt: trimmed });
  }, [wb]);

  const side = run.a;
  const plan = side.result.plan;
  const winnerCard = plan ? getCard(plan.cardId) : undefined;
  const disagree = useMemo(() => {
    const a = run.a.result.plan;
    const b = run.b.result.plan;
    if (!a && !b) return null;
    if (!a || !b) return `one config routes to ${(a ?? b)!.cardId} and the other declines`;
    if (a.cardId !== b.cardId) return `default picks ${a.cardId}, strict ladder picks ${b.cardId}`;
    if (a.rung !== b.rung) return `same card, rung ${a.rung} against rung ${b.rung}`;
    return null;
  }, [run]);

  return (
    <>
      <style href="cutroom-wb-bench" precedence="medium">{CSS}</style>

      <div className="wb-col wbb-ask">
        <div className="wb-sec">Prompt</div>
        <form
          className="wbb-form"
          onSubmit={(e) => { e.preventDefault(); go(wb.prompt); }}
        >
          <label className="wbb-sr" htmlFor="wbb-prompt">A prompt a user might say</label>
          <textarea
            id="wbb-prompt"
            className="wbb-ta"
            spellCheck={false}
            value={wb.prompt}
            placeholder="What would someone ask the editor?"
            onChange={(e) => wb.setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(wb.prompt); }
            }}
          />
          <div className="wbb-row">
            <button type="submit" className="wb-btn pri">Route</button>
            <button
              type="button"
              className="wb-btn"
              aria-pressed={showPara}
              onClick={() => setShowPara((on) => !on)}
            >
              Paraphrases
            </button>
            <label className="wb-chk">
              <input
                type="checkbox"
                checked={wb.strictLadder}
                onChange={(e) => wb.setStrictLadder(e.target.checked)}
              />
              A/B strict ladder
            </label>
            <label className="wb-chk">
              <input
                type="checkbox"
                checked={showServer}
                onChange={(e) => setShowServer(e.target.checked)}
              />
              Compare with server
            </label>
          </div>
        </form>
        <p className="wb-note">
          Retrieval runs in this tab, not through <b>/api/route</b>. The server holds
          the cards as they are on disk, so a card you just edited in Intel would not
          be the card that answered.
        </p>
      </div>

      <div className="wb-col wbb-main">
        <div className="wb-sec">
          Decision<span className="wb-grow" />
          <b>{`${side.ranking.live.length} live, ${side.ranking.hits.filter((h) => h.vetoed).length} vetoed`}</b>
        </div>

        <div className="wb-scroll">
          {plan ? (
            <div className="wbb-win">
              <div className="wbb-winhd">
                <b>{plan.cardId}</b>
                <span className="wb-chip on">rung {plan.rung}</span>
                <span className="wbb-cost">{plan.cost}</span>
              </div>
              <p className="wbb-blurb">{winnerCard ? blurb(winnerCard) : ''}</p>
              {/* a card that claims nothing cannot win, so a winner always has phrases */}
              <div className="wbb-fired">
                <span className="wbb-lbl">fired</span>
                {(side.ranking.winner?.why ?? []).map((w) => <span key={w} className="wbb-phrase">{w}</span>)}
              </div>
              <p className={plan.fragile ? 'wbb-margin tight' : 'wbb-margin'}>
                {side.ranking.runnerUp
                  ? `margin ${plan.margin.toFixed(2)} over ${side.ranking.runnerUp.card.id}`
                  : `margin ${plan.margin.toFixed(2)}, nothing else cleared the threshold`}
                {plan.fragile
                  ? `, under ${FRAGILE_MARGIN} and therefore fragile: a reword may well go elsewhere`
                  : ''}
              </p>
            </div>
          ) : (
            <p className="wb-note bad">
              <b>Declined.</b> {side.result.declined}
            </p>
          )}

          <Ladder rung={plan?.rung ?? null} reached={side.reached} />

          <div className="wb-sec">Ranking<span className="wb-grow" /><b>every card, scored</b></div>
          <HitList hits={side.ranking.hits} winner={plan?.cardId ?? null} wb={wb} />

          <div className="wb-sec">Plan<span className="wb-grow" /><b>typed, and checked before it runs</b></div>
          {plan ? (
            <>
              <p className="wbb-why">{plan.rationale}</p>
              <JsonBlock value={plan.steps} />
              {side.reached !== null && side.reached > plan.rung ? (
                <p className="wb-note warn">
                  <b>The steps reach rung {side.reached}</b>, above the rung {plan.rung} this
                  card claims. The ladder is there to be justified, not drifted up.
                </p>
              ) : null}
              {side.problems.length ? (
                <ul className="wbb-probs">
                  {side.problems.map((p, i) => (
                    <li key={i}><span>{p.code}</span>{p.message}</li>
                  ))}
                </ul>
              ) : (
                <p className="wbb-clean">validatePlan found nothing: every step kind is known, every param fits its schema.</p>
              )}
            </>
          ) : (
            <p className="wb-empty">No plan to check. The router would ask what was meant.</p>
          )}

          {para ? <Paraphrases result={para} /> : null}
        </div>

        <RateBar run={run} wb={wb} />
      </div>

      {wb.strictLadder ? (
        <div className="wb-col wbb-ab">
          <div className="wb-sec">B: strict ladder<span className="wb-grow" /><b>penalty 2.2 per rung</b></div>
          {disagree ? (
            <p className="wb-note warn"><b>The configs disagree:</b> {disagree}</p>
          ) : (
            <p className="wb-note wbb"><b>Both configs agree.</b> The ladder penalty changes nothing here.</p>
          )}
          <div className="wb-scroll">
            <HitList hits={run.b.ranking.hits} winner={run.b.result.plan?.cardId ?? null} wb={wb} />
            {run.b.result.plan ? (
              <>
                <div className="wb-sec">Plan B</div>
                <JsonBlock value={run.b.result.plan.steps} />
              </>
            ) : (
              <p className="wb-note bad"><b>Declined.</b> {run.b.result.declined}</p>
            )}
          </div>
        </div>
      ) : null}

      {showServer ? (
        <div className="wb-col wbb-ab">
          <div className="wb-sec">
            Server: POST /api/route<span className="wb-grow" />
            <b>{serverLoading ? 'Querying...' : serverData?.plan?.cardId ?? (serverData?.declined ? 'Declined' : 'No reply')}</b>
          </div>
          {serverLoading ? (
            <p className="wb-note">Asking the server router...</p>
          ) : serverData ? (
            <>
              {serverData.plan?.cardId === plan?.cardId ? (
                <p className="wb-note wbb"><b>Server agrees with local router.</b> Both chose {serverData.plan?.cardId ?? 'none'}.</p>
              ) : (
                <p className="wb-note warn">
                  <b>Server and local disagree:</b> local chose {plan?.cardId ?? 'none'}, server chose {serverData.plan?.cardId ?? 'none'}.
                </p>
              )}
              <div className="wb-scroll">
                {serverData.plan ? (
                  <>
                    <div className="wb-sec">Server Plan: {serverData.plan.cardId}</div>
                    <p className="wbb-why">{serverData.summary}</p>
                    <JsonBlock value={serverData.plan.steps} />
                  </>
                ) : (
                  <p className="wb-note bad"><b>Server declined:</b> {serverData.declined}</p>
                )}
                <div className="wb-sec">Server considered</div>
                <ul className="wbb-hits">
                  {serverData.considered?.map((c: any) => (
                    <li key={c.id}>
                      <span className="wbb-hit">
                        <span className="sc">{typeof c.score === 'number' ? c.score.toFixed(1) : ''}</span>
                        <span className="nm">{c.id}</span>
                        <span className="wb-chip">R{c.rung}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <p className="wb-note bad">Could not reach /api/route</p>
          )}
        </div>
      ) : null}
    </>
  );
}

// ── pieces ─────────────────────────────────────────────────────────────

function Ladder({ rung, reached }: { rung: Rung | null; reached: Rung | null }) {
  return (
    <div className="wbb-ladder">
      {RUNGS.map(([n, label, cost]) => (
        <div key={n} className={`wbb-rung${rung === n ? ' on' : ''}${reached === n && rung !== n ? ' reached' : ''}`}>
          <span className="n">rung {n}</span>
          <span className="l">{label}</span>
          <span className="c">{cost}</span>
        </div>
      ))}
    </div>
  );
}

function HitList({ hits, winner, wb }: { hits: Hit[]; winner: string | null; wb: WorkbenchStore }) {
  const top = Math.max(1, ...hits.map((h) => h.adj));
  return (
    <ul className="wbb-hits">
      {hits.map((h) => (
        <li key={h.card.id}>
          <button
            type="button"
            className={`wbb-hit${h.card.id === winner ? ' win' : ''}${h.vetoed ? ' veto' : ''}`}
            onClick={() => wb.openCard(h.card.id)}
            title={`Open ${h.card.id} in Intel`}
          >
            <span className="sc">{h.adj.toFixed(1)}</span>
            <span className="bar"><i style={{ width: `${Math.round((Math.max(0, h.adj) / top) * 100)}%` }} /></span>
            <span className="nm">{h.card.id}</span>
            {h.vetoed
              ? <span className="vt">veto {h.vetoedBy}</span>
              : <span className="wb-chip">R{h.card.rung}</span>}
            {h.why.length ? (
              <span className="why">{h.why.join(', ')}</span>
            ) : (
              <span className="why dim">claims nothing here, free text only</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Paraphrases({ result }: { result: RobustnessResult }) {
  const shaky = result.agree < result.total;
  return (
    <>
      <div className="wb-sec">
        Paraphrases<span className="wb-grow" />
        <b>{`${result.agree} of ${result.total} route to ${result.routedTo ?? 'nothing'}`}</b>
      </div>
      {shaky ? (
        <p className="wb-note warn">
          <b>Routing that only works on one phrasing will break.</b> The suite keeps
          passing, because the suite uses the phrasing that works.
        </p>
      ) : null}
      <ul className="wbb-paras">
        {result.variants.map((v) => (
          <li key={v.prompt}>
            <span className="p">{v.prompt}</span>
            <span className={v.same ? 'r same' : 'r diff'}>{v.same ? 'same' : `to ${v.routedTo ?? 'declined'}`}</span>
          </li>
        ))}
        {result.variants.length === 0 ? (
          <li><span className="p">No rewording rule in lib/evals/cases.ts matches this prompt.</span></li>
        ) : null}
      </ul>
    </>
  );
}

/**
 * The suite grows from real use rather than from someone imagining prompts.
 *
 * Whichever button is pressed, the case lands in the Evals suite straight
 * away: "yes" records what it chose, the picker records what it should have
 * chosen. A failing case is worth more than a missing one.
 */
function RateBar({ run, wb }: { run: Run; wb: WorkbenchStore }) {
  const got = run.a.result.plan?.cardId ?? null;
  const already = wb.cases.find((c) => c.prompt.toLowerCase() === run.prompt.toLowerCase());

  // the picker follows what the router chose until someone moves it
  const [pick, setPick] = useState(() => ({ got, value: got ?? wb.cards[0]?.id ?? '' }));
  if (pick.got !== got) setPick({ got, value: got ?? pick.value });

  if (already) {
    const ok = already.expect === got;
    return (
      <div className="wbb-rate">
        <span className="q">Already a case, expecting <b>{already.expect ?? 'nothing'}</b></span>
        <span className="wb-grow" />
        <span className={ok ? 'wbb-ok' : 'wbb-bad'}>{ok ? 'passing' : `failing, it routes to ${got ?? 'nothing'}`}</span>
      </div>
    );
  }

  return (
    <div className="wbb-rate">
      <span className="q">Right call?</span>
      {got ? (
        <button type="button" className="wb-btn" onClick={() => wb.addCase(run.prompt, got)}>
          Yes, add as a case
        </button>
      ) : null}
      <label className="q" htmlFor="wbb-expect">or expected</label>
      <select
        id="wbb-expect"
        className="wb-sel"
        value={pick.value}
        onChange={(e) => setPick({ got, value: e.target.value })}
      >
        {wb.cards.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
      </select>
      <button type="button" className="wb-btn" onClick={() => wb.addCase(run.prompt, pick.value)}>Add</button>
      <span className="wb-grow" />
      <span className="wb-mono wbb-count">{wb.cases.length} cases</span>
    </div>
  );
}

/**
 * A plan, coloured.
 *
 * The steps are the thing a reviewer actually reads, and unhighlighted JSON
 * at 11px is a wall. React escapes every piece, so the tokeniser cannot
 * inject anything a card's author wrote.
 */
const JSON_TOKENS = /("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|\btrue\b|\bfalse\b|\bnull\b)/g;

function JsonBlock({ value }: { value: Step[] }) {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  const parts = text.split(JSON_TOKENS);
  return (
    <pre className="wbb-json">
      {parts.map((p, i) => {
        if (!p) return null;
        const cls = p.endsWith(':') ? 'k'
          : p.startsWith('"') ? 's'
          : /^-?\d/.test(p) ? 'n'
          : /^(true|false|null)$/.test(p) ? 'b'
          : '';
        return cls ? <span key={i} className={`j-${cls}`}>{p}</span> : <span key={i}>{p}</span>;
      })}
    </pre>
  );
}

const CSS = `
.wbb-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.wbb-ask{width:330px;flex:none}
.wbb-main{flex:1}
.wbb-ab{width:310px;flex:none}

.wbb-form{padding:11px 12px;border-bottom:1px solid var(--edge);flex:none}
.wbb-ta{
  width:100%;height:62px;resize:none;background:var(--app);border:1px solid var(--edge-soft);
  border-radius:4px;color:var(--t1);font-family:var(--ui);font-size:13px;padding:8px 9px;line-height:1.45;
}
.wbb-ta:focus{outline:none;border-color:var(--wb)}
.wbb-row{display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap}

.wbb-win{padding:11px 12px;border-bottom:1px solid var(--edge)}
.wbb-winhd{display:flex;align-items:center;gap:8px}
.wbb-winhd b{font-family:var(--mono);font-size:13px;color:var(--wb)}
.wbb-cost{font-family:var(--mono);font-size:10px;color:var(--t3);margin-left:auto}
.wbb-blurb{margin:6px 0 0;font-size:11.5px;line-height:1.5;color:var(--t2)}
.wbb-fired{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:9px}
.wbb-lbl{
  font-family:var(--mono);font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--t3);
}
.wbb-phrase{
  font-family:var(--mono);font-size:10px;padding:1px 6px;border-radius:4px;
  background:var(--wb-wash);border:1px solid var(--wb-dim);color:var(--t1);
}
.wbb-margin{margin:9px 0 0;font-family:var(--mono);font-size:10.5px;color:var(--green)}
.wbb-margin.tight{color:var(--yellow)}
.wbb-why{margin:0;padding:8px 12px 0;font-size:11.5px;color:var(--t2);line-height:1.5}

.wbb-ladder{display:flex;gap:2px;padding:10px 12px;border-bottom:1px solid var(--edge)}
.wbb-rung{
  flex:1;padding:7px 4px;border-radius:4px;text-align:center;
  background:var(--panel-2);border:1px solid var(--edge);
}
.wbb-rung.on{background:var(--wb-wash);border-color:var(--wb)}
.wbb-rung.reached{border-color:var(--yellow)}
.wbb-rung .n{display:block;font-family:var(--mono);font-size:9px;color:var(--t3)}
.wbb-rung .l{display:block;font-size:10.5px;font-weight:600;color:var(--t2);margin-top:2px}
.wbb-rung.on .l{color:var(--wb)}
.wbb-rung .c{display:block;font-family:var(--mono);font-size:9px;color:var(--t3);margin-top:1px}

.wbb-hits{list-style:none;margin:0;padding:0}
.wbb-hit{
  display:flex;align-items:center;gap:8px;width:100%;padding:6px 12px;border:0;
  border-bottom:1px solid var(--edge);background:none;cursor:pointer;font-family:inherit;text-align:left;
}
.wbb-hit:hover{background:var(--panel-2)}
.wbb-hit.win{background:var(--wb-wash)}
.wbb-hit .sc{
  width:34px;flex:none;font-family:var(--mono);font-size:10.5px;color:var(--t2);
  font-variant-numeric:tabular-nums;
}
.wbb-hit.win .sc{color:var(--wb)}
.wbb-hit .bar{width:54px;height:3px;flex:none;background:var(--app);border-radius:4px;overflow:hidden}
.wbb-hit .bar i{display:block;height:100%;background:var(--wb-dim)}
.wbb-hit.win .bar i{background:var(--wb)}
.wbb-hit .nm{
  font-family:var(--mono);font-size:11px;color:var(--t1);flex:none;max-width:150px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.wbb-hit.veto .nm{color:var(--t3);text-decoration:line-through}
.wbb-hit .vt{font-family:var(--mono);font-size:9px;color:var(--red);flex:none}
.wbb-hit .why{
  font-size:10.5px;color:var(--t2);flex:1;min-width:0;text-align:right;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.wbb-hit .why.dim{color:var(--t3)}

.wbb-json{
  margin:0;padding:10px 12px;font-family:var(--mono);font-size:10.5px;line-height:1.6;
  color:var(--t2);white-space:pre-wrap;word-break:break-word;
}
.wbb-json .j-k{color:var(--wb)}
.wbb-json .j-s{color:var(--green)}
.wbb-json .j-n{color:var(--yellow)}
.wbb-json .j-b{color:var(--yellow)}
.wbb-probs{list-style:none;margin:0;padding:0 12px 10px;display:flex;flex-direction:column;gap:4px}
.wbb-probs li{font-size:11px;color:var(--t2);line-height:1.45}
.wbb-probs span{font-family:var(--mono);font-size:10px;color:var(--red);margin-right:6px}
.wbb-clean{margin:0;padding:0 12px 11px;font-size:11px;color:var(--t3)}

.wbb-paras{list-style:none;margin:0;padding:0}
.wbb-paras li{
  display:flex;gap:8px;align-items:center;padding:5px 12px;border-bottom:1px solid var(--edge);
  font-size:11.5px;
}
.wbb-paras .p{flex:1;min-width:0;color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbb-paras .r{font-family:var(--mono);font-size:10px;flex:none}
.wbb-paras .r.same{color:var(--green)}
.wbb-paras .r.diff{color:var(--red)}

.wbb-rate{
  flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 12px;
  border-top:1px solid var(--edge);background:var(--app);
}
.wbb-rate .q{font-size:11.5px;color:var(--t2);flex:none}
.wbb-rate .q b{color:var(--wb);font-family:var(--mono);font-size:11px}
.wbb-ok{font-family:var(--mono);font-size:10.5px;color:var(--green)}
.wbb-bad{font-family:var(--mono);font-size:10.5px;color:var(--red)}
.wbb-count{color:var(--t3)}
`;
