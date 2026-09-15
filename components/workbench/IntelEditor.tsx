'use client';

/**
 * Intel: the vocabulary, and what changing it costs.
 *
 * The reason a tool's vocabulary lives in a Markdown card instead of in the
 * code is this loop: edit the card, and the router really changes, in the
 * same second, with the eval suite re-run against whatever the card now says.
 * An edit that fixes one phrase and breaks two others should be visible
 * before it is committed, not after a user reports it.
 *
 * `putCard` throws when the plan fence stops parsing, because a plan that
 * does not parse would be executed as nothing, and silently doing nothing is
 * worse than failing. The throw is caught here: the message goes on screen
 * and the text you typed stays in the box.
 */

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { runSuite, type CaseResult, type SuiteResult } from '@/lib/evals/run.ts';
import { getCard } from '@/lib/intel/index.ts';
import { claimsOf, type WorkbenchStore } from './useWorkbench.ts';

export function IntelEditor({ wb }: { wb: WorkbenchStore }) {
  const card = wb.cards.find((c) => c.id === wb.cardId) ?? wb.cards[0];
  const suite = useMemo(() => {
    void wb.revision;   // the cards are module state; this is the signal they moved
    return runSuite(wb.cases);
  }, [wb.cases, wb.revision]);

  /**
   * Opening a card, or reverting it, is the only thing that reseeds the
   * editor. A keystroke must not: an edit whose plan fence does not parse is
   * rejected by `putCard`, and reseeding from the card would then throw away
   * the very text you need to fix.
   */
  const openedAs = `${wb.cardId}:${wb.resetToken}`;
  const [draft, setDraft] = useState(() => ({ key: openedAs, text: card?.md ?? '', error: null as string | null }));
  if (draft.key !== openedAs) setDraft({ key: openedAs, text: getCard(wb.cardId)?.md ?? '', error: null });

  /**
   * The delta is measured from the moment this card was opened, which is the
   * question a person actually has: what did MY edit do.
   */
  const [base, setBase] = useState<{ key: string; suite: SuiteResult }>(() => ({ key: openedAs, suite }));
  if (base.key !== openedAs) setBase({ key: openedAs, suite });

  const text = draft.text;
  const error = draft.error;

  const changes = useMemo(() => {
    const before = new Map(base.suite.results.map((r) => [r.case.prompt, r]));
    const broke: CaseResult[] = [];
    const fixed: CaseResult[] = [];
    for (const now of suite.results) {
      const was = before.get(now.case.prompt);
      if (!was) continue;
      const okNow = now.ok && !now.wrongRung;
      const okWas = was.ok && !was.wrongRung;
      if (okWas && !okNow) broke.push(now);
      else if (!okWas && okNow) fixed.push(now);
    }
    return { broke, fixed };
  }, [suite, base]);

  const delta = suite.passed - base.suite.passed;

  return (
    <>
      <style href="cutroom-wb-intel" precedence="medium">{CSS}</style>

      <div className="wb-col wbi-list">
        <div className="wb-sec">
          Cards<span className="wb-grow" />
          <button
            type="button"
            className="wb-btn sm"
            onClick={() => {
              const name = window.prompt('New tool card name:');
              if (name?.trim()) {
                const err = wb.createCard(name.trim(), name.trim());
                if (err) alert(err);
              }
            }}
          >
            + New
          </button>
          <b>{wb.cards.length}</b>
        </div>
        <div className="wb-scroll">
          {wb.cards.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`wbi-item${c.id === wb.cardId ? ' on' : ''}`}
              aria-current={c.id === wb.cardId}
              onClick={() => wb.openCard(c.id)}
            >
              <span className="id">
                {c.id}
                {wb.dirty.has(c.id) ? <i className="wbi-dot" title="edited in this session" /> : null}
              </span>
              <span className="k">{c.meta.kind || 'tool'}, rung {c.rung}, {c.cost}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="wb-col wbi-edit">
        <div className="wb-sec">
          Card source<span className="wb-grow" />
          <b>lib/intel/cards/{card?.id}.md</b>
          {card ? (
            <>
              <button
                type="button"
                className="wb-btn sm"
                onClick={() => {
                  const next = window.prompt('Rename card id:', card.id);
                  if (next && next.trim() !== card.id) {
                    const err = wb.renameCard(card.id, next.trim());
                    if (err) alert(err);
                  }
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className="wb-btn sm"
                style={{ color: 'var(--red)' }}
                onClick={() => {
                  if (window.confirm(`Delete card "${card.id}"?`)) {
                    wb.deleteCard(card.id);
                  }
                }}
              >
                Delete
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="wb-btn sm"
            disabled={!card || !wb.dirty.has(card.id)}
            onClick={() => card && wb.revertCard(card.id)}
          >
            Revert
          </button>
        </div>
        {error ? (
          <p className="wb-note bad"><b>Not applied.</b> {error}</p>
        ) : (
          <p className="wb-note wbb">
            <b>Every keystroke that parses is live.</b> putCard replaces the card the
            router reads, and the suite on the right re-runs against it.
          </p>
        )}
        <label className="wbi-sr" htmlFor="wbi-md">Card Markdown</label>
        <textarea
          id="wbi-md"
          className="wbi-ta"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            const next = e.target.value;
            setDraft({ key: openedAs, text: next, error: card ? wb.editCard(card.id, next) : 'no card open' });
          }}
        />
      </div>

      <div className="wb-col wbi-side">
        <div className="wb-sec">
          Suite, live<span className="wb-grow" />
          <b>{`${suite.passed}/${suite.total}`}</b>
        </div>
        <div className="wbi-delta">
          <span className="wbi-big">{base.suite.passed}/{base.suite.total}</span>
          <span className="wbi-arrow">to</span>
          <span className={`wbi-big${delta < 0 ? ' bad' : delta > 0 ? ' good' : ''}`}>
            {suite.passed}/{suite.total}
          </span>
          <span className="wb-grow" />
          <span className="wb-mono wbi-since">since you opened this card</span>
        </div>

        {changes.broke.length ? (
          <div className="wb-note bad">
            <b>{changes.broke.length} case{changes.broke.length === 1 ? '' : 's'} broke.</b>
            <ul className="wbi-cases">
              {changes.broke.map((r) => (
                <li key={r.case.prompt}>
                  <button type="button" className="wb-linkbtn" onClick={() => wb.inspect(r.case.prompt)}>
                    <span className="p">{r.case.prompt}</span>
                    <span className="m">wanted {r.case.expect}, got {r.got ?? 'nothing'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {changes.fixed.length ? (
          <div className="wb-note wbb">
            <b>{changes.fixed.length} case{changes.fixed.length === 1 ? '' : 's'} fixed.</b>
            <ul className="wbi-cases">
              {changes.fixed.map((r) => (
                <li key={r.case.prompt}>
                  <button type="button" className="wb-linkbtn" onClick={() => wb.inspect(r.case.prompt)}>
                    <span className="p">{r.case.prompt}</span>
                    <span className="m">now {r.got}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {!changes.broke.length && !changes.fixed.length ? (
          <p className="wb-note"><b>Nothing has moved.</b> {suite.fragile} of the passing cases win by less than the fragile margin.</p>
        ) : null}

        <div className="wb-sec">What this card claims</div>
        <div className="wb-scroll wbi-claims">
          {card ? <Claims wb={wb} cardId={card.id} /> : null}
        </div>
      </div>
    </>
  );
}

/**
 * A card's claim on the language: its `match:` phrases and the quoted
 * examples in `## When to use it`.
 *
 * A phrase two cards both claim is not automatically wrong, but it is
 * automatically worth knowing about: it is where a margin goes thin and a
 * paraphrase starts flipping between two tools.
 */
function Claims({ wb, cardId }: { wb: WorkbenchStore; cardId: string }) {
  const card = wb.cards.find((c) => c.id === cardId);
  if (!card) return <p className="wb-empty">No card.</p>;
  const shared = (phrase: string) => (wb.claimants.get(phrase) ?? []).filter((id) => id !== cardId);

  return (
    <>
      <Group title="match" empty="This card claims nothing, so it can never win a prompt.">
        {card.match.map((m) => {
          const others = shared(m);
          return (
            <span key={m} className={others.length ? 'wbi-claim clash' : 'wbi-claim'}>
              {m}
              {others.length ? <i>also {others.join(', ')}</i> : null}
            </span>
          );
        })}
      </Group>
      <Group title="quoted examples" empty="No quoted example in When to use it.">
        {card.examples.map((e) => {
          const others = shared(e);
          return (
            <span key={e} className={others.length ? 'wbi-claim clash' : 'wbi-claim'}>
              {e}
              {others.length ? <i>also {others.join(', ')}</i> : null}
            </span>
          );
        })}
      </Group>
      <Group title="veto" empty="Nothing disqualifies this card.">
        {card.veto.map((v) => <span key={v} className="wbi-claim veto">{v}</span>)}
      </Group>
      <p className="wbi-foot">
        {claimsOf(card).length} phrase{claimsOf(card).length === 1 ? '' : 's'} claimed.
        A longer phrase scores higher than a short one, which is why
        &quot;close the gap&quot; beats &quot;gap&quot;.
      </p>
    </>
  );
}

function Group({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <div className="wbi-group">
      <span className="wbi-gt">{title}</span>
      <div className="wbi-gl">
        {children.length ? children : <span className="wbi-none">{empty}</span>}
      </div>
    </div>
  );
}

const CSS = `
.wbi-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.wbi-list{width:214px;flex:none}
.wbi-edit{flex:1}
.wbi-side{width:330px;flex:none}

.wbi-item{
  display:block;width:100%;text-align:left;border:0;border-bottom:1px solid var(--edge);
  background:none;padding:7px 11px;cursor:pointer;font-family:inherit;
}
.wbi-item:hover{background:var(--panel-2)}
.wbi-item.on{background:var(--panel-2);box-shadow:inset 2px 0 0 var(--wb)}
.wbi-item .id{
  display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;color:var(--t1);
}
.wbi-dot{width:5px;height:5px;border-radius:50%;background:var(--wb);display:block;flex:none}
.wbi-item .k{display:block;font-family:var(--mono);font-size:9px;color:var(--t3);margin-top:2px}

.wbi-ta{
  flex:1;min-height:0;width:100%;border:0;resize:none;background:var(--panel-2);color:var(--t2);
  font-family:var(--mono);font-size:11.5px;line-height:1.65;padding:12px;
}
.wbi-ta:focus{outline:none;box-shadow:inset 2px 0 0 var(--wb)}

.wbi-delta{
  display:flex;align-items:baseline;gap:8px;padding:11px 12px;border-bottom:1px solid var(--edge);
}
.wbi-big{font-family:var(--mono);font-size:19px;font-weight:700;color:var(--t2);font-variant-numeric:tabular-nums}
.wbi-big.bad{color:var(--red)}
.wbi-big.good{color:var(--green)}
.wbi-arrow{font-family:var(--mono);font-size:10px;color:var(--t3)}
.wbi-since{color:var(--t3);font-size:9.5px}
.wbi-cases{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:5px}
.wbi-cases .p{display:block;font-size:11px;color:var(--t1)}
.wbi-cases .m{display:block;font-family:var(--mono);font-size:10px;color:var(--t2);margin-top:1px}

.wbi-claims{padding-bottom:10px}
.wbi-group{padding:9px 12px;border-bottom:1px solid var(--edge)}
.wbi-gt{
  display:block;font-family:var(--mono);font-size:9px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--t3);margin-bottom:6px;
}
.wbi-gl{display:flex;flex-wrap:wrap;gap:5px}
.wbi-claim{
  font-family:var(--mono);font-size:10px;padding:2px 6px;border-radius:4px;
  background:var(--panel-2);border:1px solid var(--edge-soft);color:var(--t2);
}
.wbi-claim i{font-style:normal;color:var(--yellow);margin-left:6px}
.wbi-claim.clash{border-color:var(--yellow)}
.wbi-claim.veto{border-color:color-mix(in srgb, var(--red) 45%, transparent);color:var(--red)}
.wbi-none{font-size:11px;color:var(--t3);line-height:1.5}
.wbi-foot{margin:0;padding:9px 12px;font-size:11px;color:var(--t3);line-height:1.5}
`;
