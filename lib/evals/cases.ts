/**
 * The eval suite.
 *
 * Things a person would actually say, each paired with the tool that should
 * answer it and the rung that should cost. It lives in lib rather than in a
 * test file because two things need it: `npm test`, which fails the build on
 * a routing regression, and the workbench, which runs it after every card
 * edit so you can see what an edit broke before you commit it.
 */
export interface EvalCase {
  prompt: string;
  /**
   * The card that should win, or null when the right answer is silence.
   *
   * null is not an absence of a case, it IS the case. A card wins by claiming
   * a phrase, so the way routing goes wrong is a card claiming words that
   * were never its own, and a suite made only of prompts its own card should
   * answer cannot see that happen: every case passes while the card quietly
   * takes everything else in the language too.
   */
  expect: string | null;
  /** The rung it should cost. Routing right at the wrong price is still wrong. Ignored when `expect` is null. */
  rung: number;
  /** Where the case came from, so a suite full of one person's phrasing shows. */
  source?: 'seed' | 'bench' | 'user';
}

/**
 * Things a person would actually say, against the cards in
 * `lib/intel/cards/`.
 *
 * These are YOUR cards, not the router's test fixtures, so this list is only
 * true while those cards are. Emptying the card directory should make this
 * suite fail loudly rather than quietly pass: that is the signal the
 * workbench exists to give. The router's own tests use
 * `test/fixtures/cards.ts` and are unaffected either way.
 *
 * It is short because one card is in play. The other eight went to
 * `lib/intel/archive/` and their cases went with them, which is the point of
 * the file: a suite is a claim about what the cards answer, and thirteen
 * cases expecting cards that are not there would have failed on every run
 * while telling nobody anything they did not already know.
 *
 * The last two are here to keep a real question in the suite. Silence is the
 * right answer more often than a confident guess, and with one card on the
 * shelf the way this breaks is no longer "the wrong card won", it is
 * "subtitle-burn won something that was never about subtitles". A suite with
 * nothing but its own card's phrasing in it cannot see that happen.
 */
export const SEED_CASES: EvalCase[] = [
  { prompt: 'Burn subtitles on',                      expect: 'subtitle-burn', rung: 2, source: 'seed' },
  { prompt: 'Add captions, two lines max',            expect: 'subtitle-burn', rung: 2, source: 'seed' },
  { prompt: 'Put subs on this',                       expect: 'subtitle-burn', rung: 2, source: 'seed' },
  { prompt: 'I need an SRT out of this',              expect: 'subtitle-burn', rung: 2, source: 'seed' },
  { prompt: 'Put hindi subtitles on this',           expect: 'subtitle-burn', rung: 2, source: 'seed' },
  { prompt: 'Subtitle this in english',              expect: 'subtitle-burn', rung: 2, source: 'seed' },
  { prompt: 'Translate this into marathi',           expect: 'subtitle-burn', rung: 2, source: 'seed' },
  { prompt: 'Translate this from hindi to english',  expect: 'subtitle-burn', rung: 2, source: 'seed' },
  // nothing in play answers these, and the card that is must not claim them
  { prompt: 'Even out the colour across shots',       expect: null,            rung: 0, source: 'seed' },
  { prompt: 'Delete this shot and close the gap',     expect: null,            rung: 0, source: 'seed' },
];

/**
 * Rewordings used to check that routing survives a paraphrase.
 *
 * Routing that only works on one phrasing is routing that will break, and it
 * breaks silently: the suite still passes because the suite uses the phrasing
 * that works.
 */
export const PARAPHRASES: [RegExp, string][] = [
  [/^burn subtitles on$/i, 'put captions on this'],
  [/^add captions(.*)$/i, 'add subtitles$1'],
  [/\bsubs\b/i, 'subtitles'],
  [/^even out the colour (.*)$/i, 'match the grade $1'],
  [/^delete (.*)$/i, 'remove $1'],
];

/** Every distinct rewording of a prompt, excluding the prompt itself. */
export function paraphrase(prompt: string, limit = 5): string[] {
  const out = new Set<string>();
  for (const [pattern, replacement] of PARAPHRASES) {
    if (out.size >= limit) break;
    const reworded = prompt.replace(pattern, replacement);
    if (reworded !== prompt) out.add(reworded);
  }
  return [...out];
}
