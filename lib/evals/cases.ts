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
  /** The card that should win. */
  expect: string;
  /** The rung it should cost. Routing right at the wrong price is still wrong. */
  rung: number;
  /** Where the case came from, so a suite full of one person's phrasing shows. */
  source?: 'seed' | 'bench' | 'user';
}

/**
 * Fifteen things a person would actually say, against the cards in
 * `lib/intel/cards/`.
 *
 * These are YOUR cards, not the router's test fixtures, so this list is only
 * true while those cards are. Emptying the card directory should make this
 * suite fail loudly rather than quietly pass: that is the signal the
 * workbench exists to give. The router's own tests use
 * `test/fixtures/cards.ts` and are unaffected either way.
 *
 * Four of these guard one decision. `broll-b1` plans the cutaways and hands
 * back prompts; `auto-broll-weave` goes further and lays clips on V2. They
 * used to claim the same words, which meant the score decided and editing
 * either card moved the answer for both. Now they claim different phrases,
 * and "Put a cutaway at 0:12" still has to reach neither.
 */
export const SEED_CASES: EvalCase[] = [
  { prompt: 'Generate broll for this video',          expect: 'broll-b1',         rung: 3, source: 'seed' },
  { prompt: 'Add some cutaways where he pauses',      expect: 'broll-b1',         rung: 3, source: 'seed' },
  { prompt: "It's just me talking for four minutes",  expect: 'broll-b1',         rung: 3, source: 'seed' },
  { prompt: 'What should I show while he says that',  expect: 'broll-b1',         rung: 3, source: 'seed' },
  { prompt: 'Weave it in',                            expect: 'auto-broll-weave', rung: 3, source: 'seed' },
  { prompt: 'Cut them in for me',                     expect: 'auto-broll-weave', rung: 3, source: 'seed' },
  { prompt: 'Put a cutaway at 0:12',                  expect: 'timeline-blade',   rung: 1, source: 'seed' },
  { prompt: 'Burn subtitles on',                      expect: 'subtitle-burn',    rung: 3, source: 'seed' },
  { prompt: 'Add captions, two lines max',            expect: 'subtitle-burn',    rung: 3, source: 'seed' },
  { prompt: 'Punch in on the talking head',           expect: 'timeline-punch',   rung: 1, source: 'seed' },
  { prompt: 'Cut this down to about 30 seconds',      expect: 'tighten-cut',      rung: 3, source: 'seed' },
  { prompt: 'Delete this shot and close the gap',     expect: 'timeline-ripple',  rung: 1, source: 'seed' },
  { prompt: 'This bit is too loud',                   expect: 'volume-adjust',    rung: 2, source: 'seed' },
  { prompt: 'Even out the colour across shots',       expect: 'colour-match',     rung: 4, source: 'seed' },
  { prompt: 'Split this clip at the playhead',        expect: 'timeline-blade',   rung: 1, source: 'seed' },
];

/**
 * Rewordings used to check that routing survives a paraphrase.
 *
 * Routing that only works on one phrasing is routing that will break, and it
 * breaks silently: the suite still passes because the suite uses the phrasing
 * that works.
 */
export const PARAPHRASES: [RegExp, string][] = [
  [/^cut this down to (.*)$/i, 'trim it to $1'],
  [/^this drags, (.*)$/i, 'it is too slow, $1'],
  [/\bcutaways?\b/i, 'b-roll'],
  [/^burn subtitles on$/i, 'put captions on this'],
  [/^punch in on (.*)$/i, 'get tighter on $1'],
  [/^delete (.*)$/i, 'remove $1'],
  [/\btoo loud\b/i, 'way too loud'],
  [/^normalise\b/i, 'even out'],
  [/\bcolder\b/i, 'cooler'],
  [/^even out the colour (.*)$/i, 'match the grade $1'],
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
