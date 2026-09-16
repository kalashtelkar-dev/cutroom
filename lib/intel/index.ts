import { parseCard } from './parse.ts';
import { CARD_SOURCE, CARD_IDS, type CardId } from './cards.generated.ts';
import type { Card } from './types.ts';

export type { Card, Step, CardMeta, Question, Choice, Answer } from './types.ts';
export {
  answersInPrompt, answerByLabel, bindingsFrom, bindingsSet,
  defaultAnswer, pendingQuestions, parseOptions, withAssumed,
} from './options.ts';
export { parseCard, blurb } from './parse.ts';
export { CARD_IDS, type CardId } from './cards.generated.ts';

/**
 * Cards are parsed once and held. They are also mutable on purpose: the
 * workbench edits a card's frontmatter and re-runs the eval suite against
 * whatever it now says, and that loop is only honest if the router reads the
 * same objects the editor wrote.
 */
const cards = new Map<string, Card>(
  CARD_IDS.map((id) => [id, parseCard(CARD_SOURCE[id as CardId], id)]),
);

export const allCards = (): Card[] => [...cards.values()];
export const getCard = (id: string): Card | undefined => cards.get(id);

/** Replace a card from edited Markdown. Throws if the plan no longer parses. */
export function putCard(id: string, md: string): Card {
  const card = parseCard(md, id);
  cards.set(id, card);
  return card;
}

/** Add a card the workbench generated for an imported or newly built pipeline. */
export const addCard = (card: Card): void => { cards.set(card.id, card); };

/** Remove a card from the card registry. */
export function removeCard(id: string): boolean {
  return cards.delete(id);
}

/** Restore every card to what is on disk. Used by the workbench's revert. */
export function resetCards(): void {
  cards.clear();
  for (const id of CARD_IDS) cards.set(id, parseCard(CARD_SOURCE[id as CardId], id));
}
