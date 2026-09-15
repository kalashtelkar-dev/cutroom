/**
 * The router's test corpus.
 *
 * These are test fixtures and they live in `test/`, not in
 * `lib/intel/cards/`. The router tests used to assert against whatever cards
 * the product shipped, which made two things true at once: clearing the
 * card directory broke thirteen tests that had nothing to do with the cards
 * being cleared, and nobody could add or edit a real card without wondering
 * which test would fail. Test data is not user data.
 *
 * `lib/intel/cards/` is now yours. This is the router's.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { allCards, putCard, removeCard, resetCards, type Card } from '../../lib/intel/index.ts';

const DIR = new URL('./cards/', import.meta.url);

export const FIXTURE_SOURCE: Record<string, string> = Object.fromEntries(
  readdirSync(DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => [f.replace(/\.md$/, ''), readFileSync(new URL(f, DIR), 'utf8')]),
);

export const FIXTURE_IDS = Object.keys(FIXTURE_SOURCE);

/**
 * Put the corpus in front of the router, and ONLY this corpus.
 *
 * `resetCards()` first, because the registry is module-level mutable state
 * and a test that edited a card must not leak into the next one. But reset
 * restores what is on disk, which is the user's cards, and overlaying the
 * fixtures onto that only replaces the ids the fixtures happen to share. A
 * card of theirs with no fixture of the same name survived, scored against
 * every routing case, and claimed phrases the fixtures also claim. That is
 * the leak this file was written to close, so close it: anything not a
 * fixture is removed before the fixtures go in.
 */
export function useFixtures(): Card[] {
  resetCards();
  for (const card of allCards()) {
    if (!(card.id in FIXTURE_SOURCE)) removeCard(card.id);
  }
  return FIXTURE_IDS.map((id) => putCard(id, FIXTURE_SOURCE[id]));
}

/** Things a person would actually say, and where each should go. */
export const FIXTURE_CASES: { prompt: string; expect: string; rung: number }[] = [
  { prompt: 'Cut this down to about 30 seconds',        expect: 'tighten-cut',      rung: 3 },
  { prompt: 'This drags, drop the slow bits',           expect: 'tighten-cut',      rung: 3 },
  { prompt: "It's just me talking for four minutes",    expect: 'auto-broll-weave', rung: 3 },
  { prompt: 'Add some cutaways where he pauses',        expect: 'auto-broll-weave', rung: 3 },
  { prompt: 'Put a cutaway at 0:12',                    expect: 'timeline-blade',   rung: 1 },
  { prompt: 'Burn subtitles on',                        expect: 'subtitle-burn',    rung: 3 },
  { prompt: 'Add captions, two lines max',              expect: 'subtitle-burn',    rung: 3 },
  { prompt: 'Punch in on the talking head',             expect: 'timeline-punch',   rung: 1 },
  { prompt: 'Get closer on that shot',                  expect: 'timeline-punch',   rung: 1 },
  { prompt: 'Split this clip at the playhead',          expect: 'timeline-blade',   rung: 1 },
  { prompt: 'Delete this shot and close the gap',       expect: 'timeline-ripple',  rung: 1 },
  { prompt: 'This bit is too loud',                     expect: 'volume-adjust',    rung: 2 },
  { prompt: 'Normalise the levels',                     expect: 'volume-adjust',    rung: 2 },
  { prompt: 'The drone shots are colder than the rest', expect: 'colour-match',     rung: 4 },
  { prompt: 'Even out the colour across shots',         expect: 'colour-match',     rung: 4 },
];
