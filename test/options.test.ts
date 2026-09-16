/**
 * The questions a card asks, and the bindings its answers set.
 *
 * Two things are worth testing here and they are not the parser.
 *
 * The first is the DRIFT between the questions and the plan. A card holds
 * both, and the whole reason they live in one file is that they are one
 * description: every `$name` the plan reads is a name some answer sets, or
 * the plan is asking for something nobody can supply and the run fails at the
 * API with the literal text `$name` where a value belonged. That has happened
 * three times on this project (`$program`, `tpl_subs`, `$selection`) and the
 * only reason it kept happening is that nothing compared the two lists.
 *
 * The second is that a prompt answering a question must be a prompt that
 * CLAIMED it. "Put hindi subtitles on this" names one language and there are
 * two questions it could belong to, and guessing wrong is a GPU minute and a
 * timeline full of subtitles in a language nobody asked for.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { allCards, getCard } from '../lib/intel/index.ts';
import {
  answerByLabel, answersInPrompt, bindingsFrom, bindingsSet,
  defaultAnswer, parseOptions, pendingQuestions, withAssumed,
} from '../lib/intel/options.ts';
import type { Step } from '../lib/intel/types.ts';
import { getNode } from '../lib/editor-api/catalogue.ts';
import { SHELL_BINDINGS } from '../lib/router/bindings.ts';
import { languageIn, languageName, LANGUAGES } from '../lib/subtitles/languages.ts';

/**
 * Bindings the shell supplies, which no card question sets.
 *
 * Named in one place and imported, rather than inferred from what the plans
 * happen to reference: inferring them is how a typo becomes a rule, and
 * keeping a second copy here is how `npm run cards` and this file would come
 * to disagree about which names are legitimate.
 */
const FROM_SHELL = SHELL_BINDINGS;

/**
 * What an earlier step leaves behind for a later one.
 *
 * `publish` spreads a job's RESULT over the bindings, so the names available
 * are the result's own fields. The catalogue knows them: an out port whose
 * `select` is a bare field name reads that field off the result, which is
 * exactly the name that binds. A port selecting `outputs[].key` is a file and
 * arrives under the step's id or its `as`, not as a result field, so it is
 * not in this set.
 *
 * Taking them from the catalogue rather than listing them here is the point:
 * `$segmnets` fails this test, and so does a plan that reads a field off a
 * node that does not answer with one.
 */
function publishedBy(step: Step): string[] {
  const out: string[] = [];
  const as = typeof step.as === 'string' ? step.as.replace(/^\$/, '') : '';
  if (as) out.push(as);
  if (step.kind !== 'operation') return out;
  const node = getNode(`${String(step.engine ?? '')}/${String(step.operation ?? '')}`);
  for (const port of node?.out ?? []) {
    const select = String(port.select ?? '');
    if (/^[A-Za-z_]\w*$/.test(select)) out.push(select);
  }
  return out;
}

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

/** Every `$name` a plan reads, at any depth, with the optional `?` stripped. */
function bindingsRead(steps: readonly Step[]): Set<string> {
  const out = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('$') && value.length > 1) {
        out.add(value.slice(1).replace(/\?$/, '').split('.')[0]);
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(steps);
  return out;
}

describe('a card and its questions are one description', () => {
  test('every binding a plan reads is one somebody can set', () => {
    const cards = allCards();
    assert.ok(cards.length > 0, 'nothing to compare is not a pass');

    let checked = 0;
    for (const card of cards) {
      const settable = bindingsSet(card.questions);
      const published = new Set(flatten(card.steps).flatMap(publishedBy));
      for (const name of bindingsRead(card.steps)) {
        checked += 1;
        assert.ok(
          FROM_SHELL.has(name) || settable.has(name) || published.has(name),
          `card "${card.id}" reads $${name}, and nothing sets it: `
          + `the shell supplies ${[...FROM_SHELL].join(', ')}, the card's questions set `
          + `${[...settable].join(', ') || 'nothing'}, and its own steps answer with `
          + `${[...published].join(', ') || 'nothing'}`,
        );
      }
    }
    assert.ok(checked > 0, 'a comparison of nothing passes; no plan referenced any binding');
  });

  test('every question can be answered, and its default is a real choice', () => {
    for (const card of allCards()) {
      for (const q of card.questions) {
        assert.ok(q.ask.trim(), `${card.id}/${q.id} asks nothing`);
        assert.ok(q.choices.length >= 2, `${card.id}/${q.id} offers ${q.choices.length} choice(s)`);
        const first = defaultAnswer(q);
        assert.equal(first.label, q.choices[0].label);
        assert.ok(answerByLabel(q, q.choices[0].label), 'the default must resolve back');
      }
    }
  });

  test('a claim phrase that names no language can never fire', () => {
    for (const card of allCards()) {
      for (const q of card.questions) {
        for (const claim of q.claims) {
          assert.ok(
            claim.includes('{language}'),
            `${card.id}/${q.id} claims "${claim}", which has no hole to read an answer out of`,
          );
        }
      }
    }
  });
});

describe('subtitle-burn asks the two questions it has', () => {
  const card = getCard('subtitle-burn')!;

  test('the card carries them at all', () => {
    assert.deepEqual(card.questions.map((q) => q.id), ['spoken', 'target']);
  });

  test('a prompt that says nothing is asked only what it cannot guess', () => {
    const found = answersInPrompt(card.questions, 'put subtitles on this');
    assert.deepEqual(found, [], 'nothing in that sentence answers anything');

    // the spoken language is detected, so asking would be a click that buys
    // nothing; what to WRITE is the user's alone and is asked
    const answers = withAssumed(card.questions, found);
    assert.deepEqual(pendingQuestions(card.questions, answers).map((q) => q.id), ['target']);
    assert.deepEqual(answers.map((a) => [a.questionId, a.assumed]), [['spoken', true]]);
  });

  test('an assumed question still loses to the prompt', () => {
    const answers = withAssumed(card.questions, answersInPrompt(card.questions, 'the audio is tamil'));
    const spoken = answers.find((a) => a.questionId === 'spoken')!;
    assert.equal(spoken.sets.spoken, 'ta', 'saying it must beat assuming it');
    assert.notEqual(spoken.assumed, true);
  });

  test('what was assumed is on the answer, so the panel can say so', () => {
    // a detection that went wrong has to be visible; a question that quietly
    // took its default and said nothing is the dropdown-wired-to-nothing bug
    const assumed = withAssumed(card.questions, []).find((a) => a.questionId === 'spoken')!;
    assert.equal(assumed.assumed, true);
    assert.equal(assumed.label, 'Detect it');
  });

  test('a language in the prompt answers the question that claimed it', () => {
    const answers = answersInPrompt(card.questions, 'put hindi subtitles on this');
    assert.deepEqual(answers.map((a) => a.questionId), ['target']);
    assert.deepEqual(bindingsFrom(answers), { rewrite: true, target: 'hindi' });
    // and the other one is still asked rather than assumed
    assert.deepEqual(pendingQuestions(card.questions, answers).map((q) => q.id), ['spoken'],
      'answered by hand or not, an assumed question is only skipped once it has a default');
  });

  test('two languages for two questions do not collide', () => {
    const answers = answersInPrompt(card.questions, 'translate this from hindi to english');
    assert.deepEqual(bindingsFrom(answers), { spoken: 'hi', rewrite: true, target: 'english' });
    assert.deepEqual(pendingQuestions(card.questions, answers), []);
  });

  test('a claim consumes its words, so the same language is not read twice', () => {
    // Without consuming the span, "from hindi" would answer `spoken` and then
    // the same word would answer `target`, and the run would translate Hindi
    // into Hindi at full price.
    const answers = answersInPrompt(card.questions, 'the speech is in hindi');
    assert.deepEqual(answers.map((a) => a.questionId), ['spoken']);
    assert.equal(bindingsFrom(answers).rewrite, undefined);
  });

  test('same as the speech asks for no translation at all', () => {
    const target = card.questions.find((q) => q.id === 'target')!;
    const answer = answerByLabel(target, 'Same as the speech')!;
    assert.equal(answer.sets.rewrite, false, 'a string "false" is truthy and would run the translate step');
    assert.equal(answer.sets.target, undefined);
  });

  test('detect it sets nothing, which is what the optional binding is for', () => {
    const spoken = card.questions.find((q) => q.id === 'spoken')!;
    assert.deepEqual(answerByLabel(spoken, 'Detect it')!.sets, {});
  });

  test('a language nobody listed still answers, in the words it was typed in', () => {
    const target = card.questions.find((q) => q.id === 'target')!;
    const answer = answerByLabel(target, 'brazilian portuguese')!;
    // vllm/translate is asked in words, so the words survive: the table only
    // knows "portuguese" and reducing it to that would lose the request
    assert.deepEqual(answer.sets, { rewrite: true, target: 'brazilian portuguese' });
  });

  test('something that is not a language is not an answer', () => {
    const target = card.questions.find((q) => q.id === 'target')!;
    assert.equal(answerByLabel(target, 'klingon'), null);
    assert.equal(answerByLabel(target, ''), null);
  });

  test('a listed choice is preferred to the free recogniser', () => {
    const target = card.questions.find((q) => q.id === 'target')!;
    // "English" is on the list and the free path would reach the same place,
    // but the chip that lights up should be the one a person would have used
    assert.equal(answerByLabel(target, 'English')!.label, 'English');
  });
});

describe('parsing', () => {
  test('a question with no choices is not a question', () => {
    assert.deepEqual(parseOptions('### x\nask: anything?\n'), []);
    assert.deepEqual(parseOptions('### x\n- One: a=1\n'), [], 'and one with nothing to ask is not either');
  });

  test('true and false are booleans, everything else is text', () => {
    const [q] = parseOptions('### x\nask: which?\n- A: on=true, off=false, name=hindi\n- B: on=false');
    assert.deepEqual(q.choices[0].sets, { on: true, off: false, name: 'hindi' });
  });

  test('an empty section is no questions, not a throw', () => {
    assert.deepEqual(parseOptions(''), []);
    assert.deepEqual(parseOptions('   \n\n'), []);
  });
});

describe('languages', () => {
  test('the longest name wins, so an alias is not eaten by a shorter one', () => {
    assert.equal(languageIn('make it castellano')?.code, 'es');
    assert.equal(languageIn('in mandarin please')?.code, 'zh');
  });

  test('a name inside another word is not a mention', () => {
    // "Romanian" contains "man"; no language is called "man", but the guard
    // this asserts is the one that keeps it that way as the list grows
    assert.equal(languageIn('thairestaurant'), null);
    assert.equal(languageIn('thai restaurant')?.code, 'th');
  });

  test('a code comes back as its own name, and an unknown one as itself', () => {
    assert.equal(languageName('hi'), 'Hindi');
    assert.equal(languageName('xx'), 'xx', 'a code is more use to a reader than silence');
  });

  test('every entry is distinct, in code and in name', () => {
    assert.equal(new Set(LANGUAGES.map((l) => l.code)).size, LANGUAGES.length);
    assert.equal(new Set(LANGUAGES.map((l) => l.name.toLowerCase())).size, LANGUAGES.length);
  });
});
