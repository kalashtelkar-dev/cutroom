/**
 * Nothing on screen names what this is built on.
 *
 * Which engine transcribes, which operation of it, and which saved pipeline
 * id it runs under, are ours. A run card reading `whisperx/subtitle` or a plan
 * listing `pipeline tpl_cdvkzzJeZylk` hands whoever is watching a progress bar
 * the list of models behind the product, and they did not ask for it.
 *
 * A grep over JSX would be the obvious test and it is the wrong one: the names
 * never appeared in the markup, they arrived as DATA, out of `describeStep`
 * and out of the cards. So this tests the data. Every string the panel is
 * handed to display is asked whether it names an engine, and the engine list
 * comes from the catalogue rather than from a list here, so an engine the
 * server gains is covered on the day it is added.
 *
 * The workbench is deliberately not in scope. It is where cards and graphs are
 * built, its whole job is naming operations, and it is not the editor.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { allCards, blurb, type Card } from '../lib/intel/index.ts';
import { enginesInUse } from '../lib/editor-api/catalogue.ts';
import { NODE_LIST } from '../lib/editor-api/catalogue.generated.ts';
import { describeStep, stepLabel } from '../lib/executor/schedule.ts';
import type { Step } from '../lib/intel/types.ts';

/**
 * Every engine name, plus the `tpl_` a saved pipeline's id starts with.
 *
 * Whole words: "vad" must not fire on "invade", and `ffmpeg` has to fire on
 * `ffmpeg/concat`, so a slash counts as a boundary and a letter does not.
 */
const ENGINES = enginesInUse();
const FORBIDDEN = new RegExp(
  `(^|[^\\p{L}])(${ENGINES.join('|')})([^\\p{L}]|$)|\\btpl_[A-Za-z0-9]+`,
  'iu',
);

const names = (text: string): string | null => {
  const m = text.match(FORBIDDEN);
  return m ? m[0].trim() : null;
};

/** Every step in a plan, including the ones inside a fanout or a branch. */
function flatten(steps: readonly Step[]): Step[] {
  const out: Step[] = [];
  for (const step of steps) {
    out.push(step);
    for (const side of ['body', 'then', 'else'] as const) {
      if (Array.isArray(step[side])) out.push(...flatten(step[side] as Step[]));
    }
  }
  return out;
}

describe('the editor never names its own engines', () => {
  test('the forbidden list is not empty, or this test asserts nothing', () => {
    assert.ok(ENGINES.length >= 5, `${ENGINES.length} engines in the catalogue`);
    assert.ok(NODE_LIST.length > 100, `${NODE_LIST.length} nodes in the catalogue`);
    // and it does catch what it is for
    assert.equal(names('whisperx/subtitle'), 'whisperx/');
    assert.equal(names('pipeline tpl_cdvkzzJeZylk'), 'tpl_cdvkzzJeZylk');
    assert.equal(names('Listening to the speech'), null);
  });

  test('every step a card ships is labelled in words', () => {
    let checked = 0;
    for (const card of allCards()) {
      for (const step of flatten(card.steps)) {
        checked += 1;
        const label = stepLabel(step);
        assert.equal(names(label), null, `card "${card.id}" shows a step as "${label}"`);
        assert.ok(label.trim().length > 0, `card "${card.id}" has a step with no label at all`);
      }
    }
    assert.ok(checked > 0, 'no card had a step, so this compared nothing');
  });

  test('a step that forgot its label falls back to a phrase, not to its engine', () => {
    const bare: Step = { kind: 'operation', engine: 'whisperx', operation: 'subtitle', params: {} };
    const facts = describeStep(bare);
    assert.equal(names(facts.label), null, `an unlabelled step shows as "${facts.label}"`);
    // the engine is still there, because capacity is keyed on it; it is the
    // LABEL that reaches the screen
    assert.equal(facts.engine, 'whisperx');
  });

  test('a pipeline step never shows its id', () => {
    const step: Step = { kind: 'pipeline', pipelineId: 'tpl_cdvkzzJeZylk', params: {} };
    assert.equal(names(describeStep(step).label), null);
  });

  test('a branch never shows the binding it turns on', () => {
    // `branch on $rewrite` named a binding out of the card, which is the same
    // leak one level up: it tells the reader how the plan is wired
    const step: Step = { kind: 'branch', when: '$rewrite', then: [], else: [] };
    assert.doesNotMatch(describeStep(step).label, /\$/);
  });

  test('the sentence the assistant shows above a plan names nothing either', () => {
    let checked = 0;
    for (const card of allCards()) {
      checked += 1;
      const said = blurb(card);
      assert.equal(names(said), null, `card "${card.id}" summarises itself as "${said}"`);
      assert.ok(said.length > 0, `card "${card.id}" summarises itself as nothing`);
    }
    assert.ok(checked > 0, 'no cards, so this compared nothing');
  });

  test('and neither do the questions it asks or the answers it offers', () => {
    let checked = 0;
    for (const card of allCards()) {
      for (const q of card.questions) {
        checked += 1;
        assert.equal(names(q.ask), null, `${card.id}/${q.id} asks "${q.ask}"`);
        for (const c of q.choices) {
          assert.equal(names(c.label), null, `${card.id}/${q.id} offers "${c.label}"`);
        }
      }
    }
    assert.ok(checked > 0, 'no questions, so this compared nothing');
  });

  /**
   * The rest of the card is not scrubbed, and should not be.
   *
   * `## How it is built` names the engines on purpose: it is the document that
   * says what this runs, for whoever maintains it. The rule is about what the
   * UI READS, which is the card's first section, its questions and its step
   * labels, and this asserts the separation is real rather than a coincidence
   * of the current wording.
   */
  test('the card still says what it is built on, somewhere nothing renders', () => {
    const card = allCards().find((c) => c.id === 'subtitle-burn') as Card;
    assert.ok(card, 'subtitle-burn is the card this was written against');
    assert.ok(names(card.md), 'the card should name its engines in full, for whoever maintains it');
    assert.equal(names(card.whatItDoes), null, 'but not in the section the assistant reads out');
  });
});
