/**
 * Stage 0: retrieval.
 *
 * Never stuff every card into a model's context. Score them here, keep the
 * top handful, and let the model choose between real candidates.
 *
 * The scoring is deliberately simple and deliberately *legible*: a phrase
 * from the card's own `match:` list is worth far more than an incidental word
 * overlap, and a `veto:` phrase disqualifies a card no matter how well it
 * otherwise scored. That last part is what stops a router reaching for a
 * 45s/min GPU pipeline when the user said "at 0:12" and meant a 20ms cut.
 *
 * Because it is arithmetic rather than a model, the eval suite can run it a
 * thousand times in a second, and editing a card's frontmatter really moves
 * the numbers, which is the entire point of keeping the vocabulary in the
 * card instead of in the code.
 */
import { allCards, type Card } from '../intel/index.ts';

export interface RetrieveConfig {
  /**
   * Subtract a penalty per rung climbed, so a cheap tool has to be clearly
   * beaten before an expensive one wins. Off by default: it makes the ladder
   * strict at the cost of occasionally suppressing a correct rung-4 answer.
   * The workbench A/Bs it.
   */
  strictLadder?: boolean;
  /** Penalty per rung above 1. */
  ladderPenalty?: number;
  /** Score below which a card is not a live candidate at all. */
  threshold?: number;
  topK?: number;
}

const DEFAULTS = { strictLadder: false, ladderPenalty: 2.2, threshold: 1.2, topK: 8 };

export interface Hit {
  card: Card;
  /** Raw score before any ladder penalty. */
  score: number;
  /** Score after the penalty, what the ranking actually uses. */
  adj: number;
  vetoed: boolean;
  vetoedBy?: string;
  /** Which of the card's own phrases fired. This is the explanation. */
  why: string[];
}

/**
 * Fold a string to the form both sides of a comparison use.
 *
 * Both sides is the point. Normalising only the prompt meant a hyphenated
 * phrase could never fire: the prompt's "b-roll" became "b roll" while the
 * card still claimed "b-roll", so the most obvious word a person would type
 * matched nothing, in match lists AND in veto lists.
 */
export const fold = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9':\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** A prompt, padded so a phrase can be matched at either end. */
const normalise = (s: string) => ` ${fold(s)} `;

/**
 * Words that are free in this domain. Every card is about video, every card
 * says "clip", and half of them say "use". Scoring on those hands identical
 * points to every card and turns the free-text pass into noise.
 */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'out', 'all', 'any',
  'are', 'was', 'but', 'not', 'you', 'your', 'its', 'has', 'have', 'can', 'will',
  'one', 'two', 'what', 'when', 'how', 'why', 'does', 'use', 'used', 'using', 'make',
  'get', 'like', 'some', 'more', 'less', 'than', 'then', 'they', 'them', 'there',
  'here', 'just', 'only', 'also', 'about', 'over', 'under', 'each', 'every', 'per',
  'video', 'audio', 'clip', 'clips', 'file', 'files', 'media', 'track', 'tracks',
  'frame', 'frames', 'timeline', 'shot', 'shots', 'thing', 'stuff', 'bit', 'bits',
]);

export function scoreCard(prompt: string, card: Card): Omit<Hit, 'card' | 'adj'> {
  const p = normalise(prompt);
  const tokens = p.split(' ').filter((t) => t.length > 2 && !STOP.has(t));

  const vetoedBy = card.veto.find((v) => v && p.includes(fold(v)));

  let score = 0;
  const why: string[] = [];
  /**
   * One phrase, one claim.
   *
   * A card may list a phrase in `match:` and quote it again under "When to
   * use it", which is a natural thing to write and was counted twice: the
   * same words earned both the match score and the example score, so a card
   * that repeated itself outranked one that did not. It also put the phrase
   * in `why` twice, which is how it was noticed.
   *
   * Folded, because `match:` and an example can differ only in case or
   * punctuation and still be the same claim.
   */
  const claimed = new Set<string>();

  for (const phrase of card.match) {
    const f = phrase && fold(phrase);
    if (!f || claimed.has(f) || !p.includes(f)) continue;
    claimed.add(f);
    // a longer phrase is a stronger signal: "close the gap" beats "gap"
    score += 4 + phrase.split(' ').length;
    why.push(phrase);
  }

  // worked examples from the card's own "When to use it"
  for (const ex of card.examples) {
    const f = ex && fold(ex);
    if (!f || claimed.has(f) || !p.includes(f)) continue;
    claimed.add(f);
    score += 3 + ex.split(' ').length;
    why.push(ex);
  }

  // weak free-text overlap, to separate cards that already matched a phrase.
  // It is never enough to win on its own, see `rank`.
  const use = card.whenToUse.toLowerCase();
  const prose = card.prose.toLowerCase();
  for (const t of tokens) {
    if (use.includes(t)) score += 1.6;
    else if (prose.includes(t)) score += 0.45;
  }

  return { score: Number(score.toFixed(2)), vetoed: Boolean(vetoedBy), vetoedBy, why };
}

export function retrieve(prompt: string, cfg: RetrieveConfig = {}): Hit[] {
  const c = { ...DEFAULTS, ...cfg };
  return allCards()
    .map((card) => {
      const r = scoreCard(prompt, card);
      const penalty = c.strictLadder ? (card.rung - 1) * c.ladderPenalty : 0;
      return { card, ...r, adj: Number((r.score - penalty).toFixed(2)) };
    })
    .sort((a, b) => b.adj - a.adj);
}

export interface Ranking {
  hits: Hit[];
  /** Candidates that are not vetoed and clear the threshold, best first. */
  live: Hit[];
  winner: Hit | null;
  /**
   * How far ahead the winner is. A thin margin means the choice is fragile:
   * a paraphrase may well route somewhere else, and that is worth surfacing
   * rather than discovering three pipelines later.
   */
  margin: number;
  runnerUp: Hit | null;
}

export function rank(prompt: string, cfg: RetrieveConfig = {}): Ranking {
  const c = { ...DEFAULTS, ...cfg };
  const hits = retrieve(prompt, cfg);
  /**
   * A card must claim at least one phrase from the prompt to be a candidate.
   *
   * Free-text overlap alone is not a claim, without this, "what is the
   * weather like" routes to whichever card happens to share a word, and a
   * card whose vocabulary you just deleted keeps winning anyway. A card's
   * `match:` list is its claim on a phrase; a card that claims nothing
   * relevant does not act. Silence is the correct answer more often than
   * a confident guess is.
   */
  const live = hits
    .filter((h) => !h.vetoed && h.adj > c.threshold && h.why.length > 0)
    .slice(0, c.topK);
  const winner = live[0] ?? null;
  const runnerUp = live[1] ?? null;
  const margin = winner ? Number((winner.adj - (runnerUp?.adj ?? 0)).toFixed(2)) : 0;
  return { hits, live, winner, margin, runnerUp };
}
