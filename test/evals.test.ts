/**
 * The eval suite, run against the cards that actually ship.
 *
 * `lib/evals/cases.ts` has always said it lives in lib rather than in a test
 * file "because two things need it: `npm test`, which fails the build on a
 * routing regression, and the workbench". Only the second half was true.
 * Nothing under `test/` imported `SEED_CASES`, so the suite ran when someone
 * had the workbench open and at no other time, and the sentence claiming
 * otherwise sat there being believed. This file is the first half.
 *
 * It is deliberately NOT `test/router.test.ts`. That file calls `useFixtures()`
 * in a `beforeEach`, which strips the shipped cards out of the registry and
 * puts its own corpus in: the right thing for testing how routing behaves,
 * and the exact wrong thing for asking what THESE cards answer. So this file
 * resets to what is on disk and never touches the fixtures.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { allCards, resetCards } from '../lib/intel/index.ts';
import { SEED_CASES, paraphrase } from '../lib/evals/cases.ts';
import { runCase, runSuite } from '../lib/evals/run.ts';

describe('the cards that ship answer the phrases they claim', () => {
  // the registry is module-level mutable state, and another file may have
  // left the fixtures in it
  beforeEach(() => { resetCards(); });

  test('there are cases, and cards for them to route to', () => {
    // a suite over an empty corpus passes every assertion below by doing
    // nothing at all, which is the failure this project keeps writing down
    assert.ok(SEED_CASES.length > 0, 'no cases, so nothing underneath this checked anything');
    assert.ok(allCards().length > 0, 'no cards, so every case would route to nothing');
  });

  test('every case routes where it says, at the price it says', () => {
    const r = runSuite(SEED_CASES);
    const wrong = r.results.filter((c) => !c.ok || c.wrongRung);
    assert.deepEqual(
      wrong.map((c) => `${c.case.prompt} -> ${c.got ?? 'nothing'} (wanted ${c.case.expect ?? 'nothing'})`),
      [],
    );
  });

  /**
   * The half of the suite that cannot pass by accident.
   *
   * A card wins by claiming a phrase, so the way this breaks is not a case
   * going to the wrong card, it is the one card left claiming words that were
   * never its own. With most of the shelf archived there is a lot of language
   * nothing should answer, and a suite made only of subtitle phrases would
   * call that a pass.
   */
  test('a prompt no card claims reaches nothing, rather than the nearest card', () => {
    const silent = SEED_CASES.filter((c) => c.expect === null);
    assert.ok(silent.length > 0, 'no negative cases, so over-claiming could not be seen');
    for (const c of silent) {
      assert.equal(runCase(c).got, null, `"${c.prompt}" should have reached nothing`);
    }
  });

  test('routing survives a rewording, or the phrasing was doing the work', () => {
    for (const c of SEED_CASES) {
      if (c.expect === null) continue;
      const variants = paraphrase(c.prompt);
      for (const v of variants) {
        assert.equal(
          runCase({ ...c, prompt: v }).got,
          c.expect,
          `"${c.prompt}" routes to ${c.expect} and "${v}" does not`,
        );
      }
    }
  });

  test('every card in play is something the suite actually exercises', () => {
    // a card nothing asks for is a card whose routing nobody is watching
    const asked = new Set(SEED_CASES.map((c) => c.expect).filter(Boolean));
    for (const card of allCards()) {
      assert.ok(asked.has(card.id), `${card.id} ships and no eval case routes to it`);
    }
  });
});
