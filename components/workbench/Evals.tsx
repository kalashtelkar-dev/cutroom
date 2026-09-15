'use client';

/**
 * Evals: the same question, fifteen times, in both configs.
 *
 * The suite is things a person would actually say, each paired with the tool
 * that should answer and the rung it should cost. Routing to the right card
 * at the wrong price is still wrong, which is why the rung is checked and why
 * the total cost of the run is on screen: the failure mode this layer guards
 * against is expensive-but-correct. A router that reaches for the dearest
 * tool every time passes a pass/fail suite and bankrupts you.
 *
 * Everything here is arithmetic over the intel cards, so a full run is
 * sub-millisecond and both ladder configs can be shown side by side rather
 * than one after the other.
 */

import { useMemo, useState } from 'react';
import { runSuite, type CaseResult, type SuiteResult } from '@/lib/evals/run.ts';
import { FRAGILE_MARGIN } from '@/lib/router/plan.ts';
import type { WorkbenchStore } from './useWorkbench.ts';

const passed = (r: CaseResult) => r.ok && !r.wrongRung;

/** GPU seconds, read at a glance. */
const spend = (s: number) => (s >= 60 ? `${(s / 60).toFixed(1)}m` : `${Math.round(s)}s`);

export function Evals({ wb }: { wb: WorkbenchStore }) {
  /**
   * Nothing runs until it is asked to.
   *
   * These cases are the router's committed regression suite, the same one
   * `npm test` runs. They are not a document and they are not anyone's
   * project, but running them on open put fifteen invented sentences and
   * their verdicts on screen at rest, which reads exactly like sample data
   * pretending to be state.
   */
  const [nonce, setNonce] = useState(0);

  // the cards are module state, so `revision` is the signal that they moved,
  // and `nonce` is a person asking for the answer
  const a = useMemo(() => {
    void wb.revision;
    return nonce ? runSuite(wb.cases) : null;
  }, [wb.cases, wb.revision, nonce]);
  const b = useMemo(() => {
    void wb.revision;
    return nonce ? runSuite(wb.cases, { strictLadder: true }) : null;
  }, [wb.cases, wb.revision, nonce]);

  const added = wb.cases.filter((c) => c.source !== 'seed').length;

  return (
    <>
      <style href="cutroom-wb-evals" precedence="medium">{CSS}</style>

      <div className="wb-col wbe-main">
        <div className="wb-sec">
          Routing suite<span className="wb-grow" />
          <b>{`${wb.cases.length} committed${added ? `, ${added} added from the bench` : ''}`}</b>
          <button type="button" className="wb-btn sm" onClick={() => setNonce((n) => n + 1)}>
            {nonce ? 'Run again' : 'Run'}
          </button>
        </div>

        {!a || !b ? (
          <p className="wb-note">
            The committed regression suite for the router: {wb.cases.length} sentences a
            person would actually say, each with the card that should answer it. This is
            the same suite <b>npm test</b> runs. Nothing here is your project. Press Run.
          </p>
        ) : (
          <>
        <Summary label="default" suite={a} />
        <Summary label="strict ladder" suite={b} />

        <p className="wb-note">
          <b>gpu if it all ran</b> is what the suite would spend end to end, cpu work
          counted lightly. It is here because a router that is right and dear passes
          every pass/fail test there is.
        </p>

        <div className="wb-scroll">
          <table className="wbe-table">
            <thead>
              <tr>
                <th className="st" scope="col"><span className="wbe-sr">result</span></th>
                <th scope="col">Prompt</th>
                <th scope="col">Expected</th>
                <th scope="col">Default</th>
                <th scope="col">Strict ladder</th>
                <th scope="col">Margin</th>
              </tr>
            </thead>
            <tbody>
              {a.results.map((r, i) => {
                const other = b.results[i];
                const ok = passed(r);
                return (
                  <Row key={r.case.prompt} r={r} other={other} ok={ok} wb={wb} />
                );
              })}
            </tbody>
          </table>
        </div>
          </>
        )}
      </div>
    </>
  );
}

function Row({ r, other, ok, wb }: { r: CaseResult; other: CaseResult; ok: boolean; wb: WorkbenchStore }) {
  return (
    <>
      <tr className={ok ? 'pass' : 'fail'}>
        <td className="st"><i /></td>
        <td>
          <button type="button" className="wb-linkbtn" onClick={() => wb.inspect(r.case.prompt)}>
            {r.case.prompt}
          </button>
          {r.case.source !== 'seed' ? <span className="wbe-src">{r.case.source}</span> : null}
        </td>
        <td className="mono dim">{r.case.expect}</td>
        <td className={`mono ${ok ? 'good' : 'bad'}`}>
          {r.got ?? 'declined'}
          <span className="wbe-rung">{r.rung === null ? '' : r.rung === r.case.rung ? `R${r.rung}` : `R${r.rung}, wanted R${r.case.rung}`}</span>
        </td>
        <td className={`mono ${passed(other) ? 'good' : 'bad'}`}>
          {other.got ?? 'declined'}
          <span className="wbe-rung">{other.rung === null ? '' : `R${other.rung}`}</span>
        </td>
        <td className="mono" style={{ color: r.fragile ? 'var(--yellow)' : 'var(--t3)' }}>
          {r.margin.toFixed(1)}{r.fragile ? ' fragile' : ''}
        </td>
      </tr>
      {ok ? null : (
        <tr className="wbe-why">
          <td />
          <td colSpan={5}>
            {r.got
              ? <>routed to <b>{r.got}</b>{r.matched.length ? <> because it claims {r.matched.map((m) => <em key={m}>{m}</em>)}</> : <> on free-text overlap alone</>}{r.runnerUp ? <>, ahead of {r.runnerUp}</> : null}</>
              : <>declined: {r.declined}</>}
            {r.ok && r.wrongRung ? <> Right card, wrong price: it costs rung {r.rung} where the case wants rung {r.case.rung}.</> : null}
          </td>
        </tr>
      )}
    </>
  );
}

function Summary({ label, suite }: { label: string; suite: SuiteResult }) {
  const failed = suite.total - suite.passed;
  return (
    <div className="wbe-sum">
      <span className="wbe-label">{label}</span>
      <Stat value={`${suite.passed}`} of={`of ${suite.total}`} note="passing" tone={failed ? 'warn' : 'good'} />
      <Stat value={`${failed}`} note="failing" tone={failed ? 'bad' : 'flat'} />
      <Stat value={`${suite.fragile}`} note={`fragile, under ${FRAGILE_MARGIN}`} tone={suite.fragile ? 'warn' : 'flat'} />
      <Stat value={`${suite.declined}`} note="declined" tone="flat" />
      <Stat value={spend(suite.gpuSeconds)} note="gpu if it all ran" tone="accent" />
    </div>
  );
}

function Stat({ value, of, note, tone }: { value: string; of?: string; note: string; tone: string }) {
  return (
    <div className="wbe-stat">
      <b data-tone={tone}>{value}{of ? <span className="wbe-of">{of}</span> : null}</b>
      <span>{note}</span>
    </div>
  );
}

const CSS = `
.wbe-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.wbe-main{flex:1}
.wbe-sum{display:flex;align-items:stretch;border-bottom:1px solid var(--edge);flex:none}
.wbe-label{
  width:104px;flex:none;display:flex;align-items:center;padding:0 12px;
  font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--t3);border-right:1px solid var(--edge);
}
.wbe-stat{flex:1;padding:10px 13px;border-right:1px solid var(--edge)}
.wbe-stat:last-child{border-right:0}
.wbe-stat b{
  display:block;font-size:20px;font-weight:700;line-height:1.1;color:var(--t1);
  font-variant-numeric:tabular-nums;
}
.wbe-stat b[data-tone="good"]{color:var(--green)}
.wbe-stat b[data-tone="bad"]{color:var(--red)}
.wbe-stat b[data-tone="warn"]{color:var(--yellow)}
.wbe-stat b[data-tone="accent"]{color:var(--wb)}
.wbe-of{font-family:var(--mono);font-size:10px;font-weight:400;color:var(--t3);margin-left:5px}
.wbe-stat span{
  display:block;font-family:var(--mono);font-size:9px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--t3);margin-top:4px;
}

.wbe-table{width:100%;border-collapse:collapse;font-size:11.5px}
.wbe-table th{
  position:sticky;top:0;z-index:2;text-align:left;font-weight:500;padding:7px 11px;
  font-family:var(--mono);font-size:9px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--t3);background:var(--app);border-bottom:1px solid var(--edge);
}
.wbe-table td{padding:6px 11px;border-bottom:1px solid var(--edge);color:var(--t2);vertical-align:top}
.wbe-table tr.fail td{background:color-mix(in srgb, var(--red) 6%, transparent)}
.wbe-table .st{width:20px}
.wbe-table .st i{display:block;width:9px;height:9px;border-radius:50%;background:var(--ctl-off)}
.wbe-table tr.pass .st i{background:var(--green)}
.wbe-table tr.fail .st i{background:var(--red)}
.wbe-table .mono{font-family:var(--mono);font-size:10.5px;white-space:nowrap}
.wbe-table .dim{color:var(--t3)}
.wbe-table .good{color:var(--green)}
.wbe-table .bad{color:var(--red)}
.wbe-rung{display:block;font-size:9px;color:var(--t3);margin-top:2px}
.wbe-src{
  margin-left:7px;font-family:var(--mono);font-size:9px;color:var(--wb);
  border:1px solid var(--wb-dim);border-radius:4px;padding:0 4px;
}
.wbe-why td{
  font-size:11px;color:var(--t2);line-height:1.5;padding-top:0;
  background:color-mix(in srgb, var(--red) 6%, transparent);
}
.wbe-why b{color:var(--red);font-family:var(--mono);font-size:10.5px}
.wbe-why em{
  font-style:normal;font-family:var(--mono);font-size:10px;color:var(--t1);
  background:var(--edge);border-radius:4px;padding:1px 5px;margin:0 3px;
}
`;
