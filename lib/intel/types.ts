/**
 * The intel layer.
 *
 * One Markdown card per tool. The card is the single source of truth about
 * that tool: the vocabulary the router matches on, the guidance a model
 * reads, and the plan it emits. A tool cannot describe itself one way to a
 * person and another way to the model, because there is only one description.
 *
 * Tools are curated capabilities, not the 123 raw operations, handing a
 * router the whole catalogue wrecks its accuracy. There are three kinds, and
 * they form a cost ladder the router has to justify climbing:
 *
 *   timeline-op   a local patch. No API call, no LLM. ~20ms.
 *   operation     one editor-api operation. Seconds.
 *   pipeline      a saved, published pipeline. Tens of seconds to minutes.
 *   graph         an ad-hoc composition, when nothing saved fits.
 *
 * Plus two that are control rather than cost, and one that is neither:
 *
 *   fanout        run a body once per item
 *   branch        take one side
 *   read-json     read a JSON file a previous step produced, and bind what
 *                 is in it. A pipeline hands back object keys and not data,
 *                 so without this a plan can start a transcription and then
 *                 have nothing to think with. Free, local, and no job.
 */

export type StepKind =
  | 'timeline-op' | 'operation' | 'pipeline' | 'graph' | 'fanout' | 'branch' | 'read-json';

export interface Step {
  kind: StepKind;
  [key: string]: unknown;
}

import type { Question } from './options.ts';
export type { Question, Choice, Answer, FreeKind } from './options.ts';

/** Frontmatter, as authored. Everything is a string in the file. */
export interface CardMeta {
  id: string;
  kind: string;
  rung: string;
  cost: string;
  match: string;
  veto?: string;
  [key: string]: string | undefined;
}

export interface Card {
  id: string;
  /** The file, verbatim. Editing this and reparsing is the whole workflow. */
  md: string;

  // ── parsed ──
  meta: CardMeta;
  body: string;
  /** Phrases that make this card a candidate. Multi-word phrases score higher. */
  match: string[];
  /** Phrases that disqualify it outright, however well it otherwise scores. */
  veto: string[];
  /**
   * Quoted examples lifted out of `## When to use it`.
   *
   * A card that writes "It's just me talking" as an example of when to reach
   * for it has already declared that phrase; making the author repeat it in
   * `match:` is duplication that will drift. These score slightly below an
   * explicit match phrase, because an example is illustrative where the
   * match list is canonical.
   */
  examples: string[];
  /** 1–4. The cost ladder; the router justifies every rung it climbs. */
  rung: number;
  cost: string;
  /** `## What it does`, `## When to use it`, `## When NOT to use it`. */
  whatItDoes: string;
  whenToUse: string;
  whenNotToUse: string;
  /**
   * The card's prose with headings and the plan fence removed.
   *
   * The free-text half of scoring runs against this rather than the raw
   * body, because every card contains the words "What it does" and a JSON
   * plan, and matching on those gave every card an identical baseline score
   * for any prompt at all.
   */
  prose: string;
  /** The typed plan from the card's ```json fence. */
  steps: Step[];
  /**
   * What the card asks before it runs, from `## Options`.
   *
   * Empty for a card with one behaviour, which is most of them. Every binding
   * a choice sets is one the plan reads, so the questions and the plan are one
   * description and not two.
   */
  questions: Question[];
}
