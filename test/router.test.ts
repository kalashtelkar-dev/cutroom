import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { allCards, getCard, putCard, resetCards, blurb, type Card } from '../lib/intel/index.ts';
import { scoreCard } from '../lib/router/retrieve.ts';
import { route, validatePlan, actualRung, FRAGILE_MARGIN } from '../lib/router/plan.ts';
import { runSuite, checkRobustness } from '../lib/evals/run.ts';
import { FIXTURE_CASES, FIXTURE_IDS, useFixtures } from './fixtures/cards.ts';
import type { EvalCase } from '../lib/evals/cases.ts';

/**
 * The corpus under test is the fixture corpus, installed before every test.
 *
 * `lib/intel/cards/` belongs to whoever is using the workbench and can be
 * empty, full, or full of something else entirely. A router test that reads
 * it is a test of their data, which is why clearing the directory used to
 * break thirteen tests about scoring.
 */
const CASES = FIXTURE_CASES.map((c) => ({ prompt: c.prompt, id: c.expect, rung: c.rung }));
const SUITE: EvalCase[] = FIXTURE_CASES.map((c) => ({ ...c, source: 'seed' as const }));

beforeEach(() => { useFixtures(); });


describe('intel cards', () => {
  test('every card loads, parses and carries a plan', () => {
    const cards = allCards();
    // the fixtures are installed by beforeEach, so this compares something
    assert.equal(cards.length, FIXTURE_IDS.length, 'the fixture corpus did not install');
    for (const c of cards) {
      assert.ok(c.match.length, `${c.id} claims no phrases, so it can never be routed to`);
      assert.ok(c.steps.length, `${c.id} has no plan`);
      assert.ok(c.whatItDoes, `${c.id} does not say what it does`);
      assert.ok(c.rung >= 1 && c.rung <= 4, `${c.id} rung out of range`);
    }
  });

  test('a card blurb is one readable sentence, never cut mid-word', () => {
    for (const c of allCards()) {
      const b = blurb(c);
      assert.ok(b.length > 20, `${c.id}: "${b}"`);
      assert.ok(!/\s…$/.test(b), `${c.id} trimmed to a dangling space`);
    }
  });

  test('no two cards claim the same phrase', () => {
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    for (const c of allCards()) {
      for (const m of c.match) {
        const prev = owner.get(m);
        if (prev) clashes.push(`"${m}" claimed by both ${prev} and ${c.id}`);
        else owner.set(m, c.id);
      }
    }
    assert.deepEqual(clashes, []);
  });

  test('the fixture corpus is the WHOLE corpus, not the fixtures plus whatever is on disk', () => {
    /**
     * The leak this closes: `resetCards()` restores the cards on disk, which
     * are the user's, and overlaying the fixtures only replaces the ids the
     * two happen to share. A card of theirs with no fixture of the same name
     * survived, scored against all fifteen routing cases and claimed phrases
     * the fixtures also claim, so adding a card to their own workbench could
     * fail the router's tests.
     */
    putCard('intruder', [
      '---', 'id: intruder', 'kind: pipeline', 'rung: 3', 'cost: free',
      'match: cutaway, cutaways', '---', '', '## What it does', 'Nothing at all.', '',
    ].join('\n'));
    assert.ok(getCard('intruder'), 'the intruder must be installed or this proves nothing');

    useFixtures();

    assert.equal(getCard('intruder'), undefined, 'a card that is not a fixture must not reach the router');
    assert.deepEqual(allCards().map((c) => c.id).sort(), [...FIXTURE_IDS].sort());
  });

  test("a card's declared rung matches the plan it actually emits", () => {
    for (const c of allCards()) {
      assert.equal(actualRung(c.steps), c.rung, `${c.id} says rung ${c.rung} but its plan reaches ${actualRung(c.steps)}`);
    }
  });

  test('every plan validates against the real node catalogue', () => {
    for (const c of allCards()) {
      assert.deepEqual(validatePlan(c.steps), [], `${c.id} emits a plan that does not check out`);
    }
  });
});

describe('routing', () => {
  test('15 of 15, with the rung each one should cost', () => {
    const misses: string[] = [];
    for (const c of CASES) {
      const r = route(c.prompt);
      const got = r.plan?.cardId ?? '(declined)';
      if (got !== c.id) misses.push(`"${c.prompt}" -> ${got}, wanted ${c.id}`);
      else if (r.plan!.rung !== c.rung) misses.push(`"${c.prompt}" routed right but at rung ${r.plan!.rung}, not ${c.rung}`);
    }
    assert.deepEqual(misses, []);
  });

  test('no case wins by a hair', () => {
    const fragile = CASES
      .map((c) => ({ c, r: route(c.prompt) }))
      .filter((x) => x.r.plan?.fragile)
      .map((x) => `"${x.c.prompt}" by only ${x.r.plan!.margin} over ${x.r.live[1]?.card.id}`);
    assert.deepEqual(fragile, [], `fragile under ${FRAGILE_MARGIN}`);
  });

  test('a veto beats any score: the expensive-but-correct trap', () => {
    // "at 0:12" names the moment, so the 45s/min planner must stand down
    const r = route('Put a cutaway at 0:12');
    const broll = r.hits.find((h) => h.card.id === 'auto-broll-weave')!;
    assert.ok(broll.vetoed, 'the b-roll pipeline should be vetoed here');
    assert.equal(r.plan!.rung, 1, 'and a 20ms timeline op should answer instead');
  });

  test('the ladder can be made strict, and it costs coverage, not correctness', () => {
    const loose = CASES.filter((c) => route(c.prompt).plan?.cardId === c.id).length;
    const strictResults = CASES.map((c) => ({ c, r: route(c.prompt, { strictLadder: true }) }));
    const strict = strictResults.filter((x) => x.r.plan?.cardId === x.c.id).length;

    assert.equal(loose, CASES.length);
    assert.ok(strict < loose, 'strict mode is meant to trade something for cheapness');

    // What it trades is coverage: the cases it loses are DECLINED, not sent
    // to a cheaper wrong tool. That is the behaviour worth having, a router
    // that says "I am not sure" beats one that confidently blades a colour job.
    const wrong = strictResults.filter((x) => x.r.plan && x.r.plan.cardId !== x.c.id);
    assert.deepEqual(wrong.map((x) => x.c.prompt), [], 'strict mode must never misroute, only decline');

    assert.equal(
      route('Even out the colour across shots', { strictLadder: true }).plan,
      null,
      'a rung-4 climb penalised by 6.6 no longer clears the bar, and the router says so',
    );
  });

  test('a prompt about nothing is declined, not guessed at', () => {
    const r = route('what is the weather like');
    assert.equal(r.plan, null);
    assert.match(r.declined!, /claims any phrase/);
  });

  test('rationale quotes the card back, so a choice is explainable', () => {
    const r = route('Add some cutaways where he pauses');
    assert.match(r.plan!.rationale, /cutaways/);
  });
});

describe('editing a card really moves the router', () => {
  test('removing a phrase changes where a prompt goes', () => {
    const before = route('Normalise the levels').plan?.cardId;
    assert.equal(before, 'volume-adjust');

    const card = getCard('volume-adjust')!;
    putCard('volume-adjust', card.md.replace(/^match:.*$/m, 'match: louder, quieter'));
    const after = route('Normalise the levels').plan?.cardId;
    assert.notEqual(after, 'volume-adjust', 'the card stopped claiming the phrase, so it stopped winning');

    useFixtures();
    assert.equal(route('Normalise the levels').plan?.cardId, 'volume-adjust');
  });

  test('a multi-word phrase outscores a single word', () => {
    const c = getCard('timeline-ripple')!;
    const long = scoreCard('delete this shot and close the gap', c);
    const short = scoreCard('delete', c);
    assert.ok(long.score > short.score);
    assert.ok(long.why.includes('close the gap'));
  });

  test('a plan that does not parse fails at edit time, not at run time', () => {
    const card = getCard('timeline-blade')!;
    assert.throws(
      () => putCard('timeline-blade', card.md.replace('```json', '```json\n{ broken,')),
      /does not parse/,
    );
    useFixtures();
  });
});

describe('the shared eval runner', () => {
  test('agrees with the suite the tests run by hand', () => {
    const r = runSuite(SUITE);
    assert.equal(r.total, 15);
    assert.equal(r.passed, 15);
    assert.equal(r.fragile, 0);
    assert.equal(r.declined, 0);
  });

  test('reports what the suite would cost if it all ran', () => {
    // The failure this guards against is expensive-but-correct: a router that
    // always reaches for the dearest tool passes every case and bankrupts you.
    const r = runSuite(SUITE);
    assert.ok(r.gpuSeconds > 0, 'a suite of real work is not free');
    const allCheap = runSuite(SUITE.filter((c) => c.rung === 1));
    assert.ok(allCheap.gpuSeconds < r.gpuSeconds, 'rung-1 answers cost less');
  });

  test('a routed-right-but-overpriced case is not a pass', () => {
    const mispriced = [{ ...SUITE[0], rung: 1 }];
    const r = runSuite(mispriced);
    assert.equal(r.passed, 0);
    assert.equal(r.results[0].wrongRung, true, 'the right tool at the wrong price is still wrong');
  });

  test('routing survives being reworded', () => {
    const weak: string[] = [];
    for (const c of SUITE) {
      const r = checkRobustness(c.prompt);
      if (r.total > 0 && r.agree === 0) weak.push(`"${c.prompt}" -> no rewording routes the same`);
    }
    assert.deepEqual(weak, [], 'routing that works on one phrasing will break');
  });
});

/**
 * A phrase is one claim, however many places it is written.
 *
 * A card may list a phrase in `match:` and quote it again under "When to use
 * it". That is a natural thing to write, and it used to be counted twice: the
 * same words earned the match score AND the example score, so a card that
 * repeated itself outranked one that did not, on identical vocabulary. It
 * surfaced as the same phrase listed twice in the explanation, which is the
 * only reason anybody noticed.
 */
describe('a phrase counts once', () => {
  const card = (over: Partial<Card> = {}): Card => ({
    id: 'test-card',
    kind: 'pipeline',
    rung: 2,
    cost: '1s',
    match: ['extract audio'],
    veto: [],
    examples: [],
    whatItDoes: 'x',
    whenToUse: '',
    whenNotToUse: '',
    prose: '',
    steps: [],
    ...over,
  } as Card);

  test('a phrase in both match and the examples scores once, not twice', () => {
    const once = scoreCard('extract audio from this', card());
    const twice = scoreCard('extract audio from this', card({ examples: ['extract audio'] }));
    assert.equal(twice.score, once.score, 'repeating a claim inflated the score');
  });

  test('and it appears once in the explanation', () => {
    const hit = scoreCard('extract audio from this', card({ examples: ['extract audio'] }));
    assert.deepEqual(hit.why, ['extract audio']);
    assert.equal(new Set(hit.why).size, hit.why.length, 'a phrase is listed twice');
  });

  test('a genuinely different example still earns its own score', () => {
    const plain = scoreCard('pull the audio out of this', card());
    const extra = scoreCard('pull the audio out of this', card({ examples: ['pull the audio'] }));
    assert.ok(extra.score > plain.score, 'a real example added nothing');
    assert.deepEqual(extra.why, ['pull the audio']);
  });

  test('no card in the repo claims the same phrase twice', () => {
    const cards = allCards();
    assert.ok(cards.length, 'no cards to check');
    for (const c of cards) {
      const claims = [...c.match, ...c.examples].map((x) => x.toLowerCase().trim());
      const seen = new Set(claims);
      assert.equal(
        seen.size, claims.length,
        `${c.id} writes the same claim in both match: and its examples`,
      );
    }
  });
});

/**
 * A generated card is a real card or it is not written.
 *
 * The first version of the generator wrote "WRITE THIS" into the section that
 * carries the routing accuracy, and shipped: the card went live, started
 * winning prompts, and the instruction to fix it sat inside the thing that
 * needed fixing. A placeholder in a generator is a placeholder in production.
 */
describe('cards cannot be generated half-written', () => {
  const graph = {
    version: 1,
    nodes: [
      { id: 'in_v', kind: 'input', name: 'video', type: 'file:video', required: true, position: { x: 0, y: 0 } },
      { id: 'op1', kind: 'engine', engine: 'ffmpeg', operation: 'extract-audio', params: {}, position: { x: 1, y: 0 } },
      { id: 'out1', kind: 'output', fields: ['audio'], position: { x: 2, y: 0 } },
    ],
    edges: [],
  } as never;

  const full = {
    whenToUse: 'The user wants the sound on its own, as a file, with nothing done to it.',
    whenNotToUse: 'When they want the words out of it, or the levels changed rather than separated.',
  };

  test('no prose means no card, rather than a card full of instructions', async () => {
    const { generateCard, CardIncomplete } = await import('../lib/intel/generate.ts');
    assert.throws(
      () => generateCard(graph, 'x test', ['pull the audio'], { whenToUse: '', whenNotToUse: '' }),
      (e: unknown) => {
        assert.ok(e instanceof CardIncomplete);
        assert.ok(e.missing.includes('When NOT to use it'), JSON.stringify(e.missing));
        return true;
      },
    );
  });

  test('"When NOT to use it" alone being missing is still a refusal', async () => {
    const { generateCard } = await import('../lib/intel/generate.ts');
    assert.throws(
      () => generateCard(graph, 'x test', ['pull the audio'], { ...full, whenNotToUse: 'no' }),
      /When NOT to use it/,
    );
  });

  test('claiming nothing is a refusal: such a card can never win', async () => {
    const { generateCard } = await import('../lib/intel/generate.ts');
    assert.throws(() => generateCard(graph, 'x test', [], full), /phrase to claim/);
  });

  test('a complete one carries the author words, not a template', async () => {
    const { generateCard } = await import('../lib/intel/generate.ts');
    const d = generateCard(graph, 'x test', ['pull the audio'], full);
    assert.ok(d.markdown.includes(full.whenNotToUse));
    assert.ok(!/WRITE THIS|WRITE A REAL|TODO/i.test(d.markdown), 'it wrote a placeholder');
  });

  test('an example that repeats a claim is dropped, since it would score nothing', async () => {
    const { generateCard } = await import('../lib/intel/generate.ts');
    const d = generateCard(graph, 'x test', ['pull the audio'], {
      ...full,
      examples: ['pull the audio', 'give me just the sound'],
    });
    assert.equal((d.markdown.match(/^> "/gm) ?? []).length, 1);
    assert.ok(d.markdown.includes('give me just the sound'));
  });

  test('no card anywhere carries placeholder text', () => {
    /**
     * Both directories, and neither is required to hold anything.
     *
     * `lib/intel/cards/` is the user's and starts empty. `test/fixtures/cards/`
     * is the router's and does not. Asserting a count on the first would make
     * an empty workbench a test failure; asserting none at all would make this
     * a walk over nothing. So: check whatever is there, and prove separately
     * that the fixtures ARE there.
     */
    let checked = 0;
    for (const rel of ['../lib/intel/cards/', './fixtures/cards/']) {
      const dir = new URL(rel, import.meta.url);
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
        const text = readFileSync(new URL(f, dir), 'utf8');
        assert.ok(
          !/\bWRITE (THIS|A REAL)\b|\bTODO\b|\bFIXME\b|lorem ipsum/i.test(text),
          `${rel}${f} still holds placeholder text`,
        );
        checked += 1;
      }
    }
    assert.ok(checked >= FIXTURE_IDS.length, `only swept ${checked} cards`);
  });
});

/**
 * A generated example is a claim, or it is decoration.
 *
 * The parser reads quoted phrases out of `## When to use it` and nowhere
 * else. A generator that writes examples under `## Worked examples` produces
 * a card that looks like it answers to a sentence it has no hold on, which is
 * exactly what this one did.
 */
describe('generated examples land where claims are read from', () => {
  const graph = {
    version: 1,
    nodes: [
      { id: 'in_v', kind: 'input', name: 'video', type: 'file:video', required: true, position: { x: 0, y: 0 } },
      { id: 'op1', kind: 'engine', engine: 'ffmpeg', operation: 'extract-audio', params: {}, position: { x: 1, y: 0 } },
      { id: 'out1', kind: 'output', fields: ['audio'], position: { x: 2, y: 0 } },
    ],
    edges: [],
  } as never;

  test('a generated card claims the example it was given', async () => {
    const { generateCard } = await import('../lib/intel/generate.ts');
    const { parseCard } = await import('../lib/intel/index.ts');
    const d = generateCard(graph, 'claim test', ['pull the audio'], {
      whenToUse: 'The user wants the sound on its own as a file, with nothing done to it.',
      whenNotToUse: 'When they want the words out of it, or the levels changed rather than separated.',
      examples: ['give me just the sound as a file'],
    });
    const card = parseCard(d.markdown, d.id);
    assert.ok(
      card.examples.includes('give me just the sound as a file'),
      `the example is not a claim: ${JSON.stringify(card.examples)}`,
    );
  });

  test('a card written to disk is loadable and claims what it says', async () => {
    /**
     * Round trip through a real file rather than asserting on a card that
     * happens to be shipped: the card directory is the user's and may be
     * empty, so a test naming one of its files is a test of their data.
     */
    const { generateCard } = await import('../lib/intel/generate.ts');
    const { parseCard } = await import('../lib/intel/index.ts');
    const d = generateCard(graph, 'round trip', ['pull the audio'], {
      whenToUse: 'The user wants the sound on its own as a file, with nothing done to it.',
      whenNotToUse: 'When they want the words out of it, or the levels changed rather than separated.',
      examples: ['save the audio on its own'],
    });
    const card = parseCard(d.markdown, d.id);
    assert.ok(card.examples.includes('save the audio on its own'));
    for (const ex of card.examples) assert.ok(d.markdown.includes(ex));
  });
});
