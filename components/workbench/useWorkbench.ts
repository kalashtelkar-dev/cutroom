'use client';

/**
 * Shared state for the Tool Caller Workbench.
 *
 * The four tabs are four views of one thing: what the router does with a
 * sentence. Bench asks about one sentence, Evals asks about fifteen, Intel
 * changes the vocabulary they both read, and Pipelines builds the graph a
 * new card would point at. They have to share state or the loop breaks, a
 * card edited in Intel that Evals cannot see is a demo, not a workbench.
 *
 * The intel cards are module-level mutable state (`lib/intel/index.ts` says
 * so on purpose), and React cannot see a Map being written to. Every
 * mutation here goes through `editCard` or `revertCard`, which bump
 * `revision`, and every tab derives from that number. Nothing reads the card
 * map during render without listing `revision` as a dependency.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { allCards, getCard, putCard, removeCard, resetCards, type Card } from '@/lib/intel/index.ts';
import { CARD_SOURCE, type CardId } from '@/lib/intel/cards.generated.ts';
import { SEED_CASES, type EvalCase } from '@/lib/evals/cases.ts';

export type WorkbenchTab = 'bench' | 'intel' | 'evals' | 'pipelines';

export const TABS: readonly { id: WorkbenchTab; label: string }[] = [
  { id: 'bench', label: 'Bench' },
  { id: 'intel', label: 'Intel' },
  { id: 'evals', label: 'Evals' },
  { id: 'pipelines', label: 'Pipelines' },
] as const;

export interface WorkbenchStore {
  tab: WorkbenchTab;
  setTab: (tab: WorkbenchTab) => void;

  /** The prompt Bench is working on. Evals and the ranking list write to it. */
  prompt: string;
  setPrompt: (prompt: string) => void;

  /** Bench's A/B switch, kept here so a tab change does not reset it. */
  strictLadder: boolean;
  setStrictLadder: (on: boolean) => void;

  /** The seed suite plus everything Bench has promoted into it. */
  cases: EvalCase[];
  addCase: (prompt: string, expect: string) => void;

  cards: Card[];
  cardId: string;
  /** Cards whose Markdown differs from what is on disk. */
  dirty: ReadonlySet<string>;
  /** Bumped by every card mutation, so a tab knows to recompute. */
  revision: number;
  /**
   * Bumped only by a revert, which is the one change the editor's own
   * textarea did not make and therefore has to be re-seeded from.
   */
  resetToken: number;

  /** Applies edited Markdown. Returns the parse error, or null on success. */
  editCard: (id: string, md: string) => string | null;
  revertCard: (id: string) => void;
  createCard: (id: string, name?: string) => string | null;
  deleteCard: (id: string) => void;
  renameCard: (oldId: string, newId: string) => string | null;

  /** Open a card in Intel. */
  openCard: (id: string) => void;
  /** Send a prompt to Bench. */
  inspect: (prompt: string) => void;
  /**
   * Bumped by `inspect`, and by nothing else.
   *
   * Bench routes on submit rather than on every keystroke, so a prompt
   * arriving from somewhere else needs to say "this one was asked for" or it
   * would sit in the box unrouted.
   */
  promptToken: number;

  /** Phrase to the cards claiming it. More than one is a collision. */
  claimants: ReadonlyMap<string, string[]>;

  status: string | null;
  notify: (message: string) => void;
}

/** Every phrase a card claims: its `match:` list plus its quoted examples. */
export function claimsOf(card: Card): string[] {
  return [...new Set([...card.match, ...card.examples])];
}

export function useWorkbench(): WorkbenchStore {
  const [tab, setTab] = useState<WorkbenchTab>('bench');
  // Empty. The bench opened holding a prompt from the eval corpus with a
  // routed result already on screen, which reads as a decision someone made
  // rather than as an example. An editor that starts with someone else's
  // material is asking you to clear it before you can begin.
  const [prompt, setPrompt] = useState('');
  const [strictLadder, setStrictLadder] = useState(false);
  const [cases, setCases] = useState<EvalCase[]>(SEED_CASES);
  const [cardId, setCardId] = useState<string>('auto-broll-weave');
  const [revision, setRevision] = useState(0);
  const [resetToken, setResetToken] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [promptToken, setPromptToken] = useState(0);

  const cards = useMemo(() => {
    void revision;   // the card map is module state; this is the signal it moved
    return allCards();
  }, [revision]);

  /**
   * Edited means "differs from the Markdown on disk", read off the cards
   * themselves rather than tracked alongside them. A second copy of the truth
   * is a second thing to get wrong, and `CARD_SOURCE` is already the truth.
   */
  const dirty = useMemo(
    () => new Set(cards.filter((c) => CARD_SOURCE[c.id as CardId] !== c.md).map((c) => c.id)),
    [cards],
  );

  const claimants = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const card of cards) {
      for (const phrase of claimsOf(card)) {
        out.set(phrase, [...(out.get(phrase) ?? []), card.id]);
      }
    }
    return out;
  }, [cards]);

  const timer = useRef<number | undefined>(undefined);
  const notify = useCallback((message: string) => {
    setStatus(message);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus(null), 3200);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const editCard = useCallback((id: string, md: string): string | null => {
    try {
      putCard(id, md);
    } catch (e) {
      // The plan fence no longer parses. The card keeps its last good text,
      // the editor keeps the typing, and the message goes on screen.
      return (e as Error).message;
    }
    setRevision((r) => r + 1);
    return null;
  }, []);

  /**
   * `resetCards()` is all-or-nothing by design, so a per-card revert is
   * "put everything back, then re-apply the edits I am keeping".
   */
  const revertCard = useCallback((id: string) => {
    const keep = allCards()
      .filter((c) => c.id !== id && CARD_SOURCE[c.id as CardId] !== c.md)
      .map((c) => [c.id, c.md] as const);
    resetCards();
    for (const [other, md] of keep) putCard(other, md);
    setRevision((r) => r + 1);
    setResetToken((t) => t + 1);
    notify(`Reverted ${id} to what is on disk`);
  }, [notify]);

  const addCase = useCallback((casePrompt: string, expect: string) => {
    const rung = getCard(expect)?.rung ?? 2;
    setCases((prev) => [...prev, { prompt: casePrompt, expect, rung, source: 'bench' }]);
    notify(`Added to the suite, expecting ${expect}`);
  }, [notify]);

  const createCard = useCallback((id: string, name?: string): string | null => {
    const slug = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    if (!slug) return 'A card id is required';
    if (getCard(slug)) return `Card "${slug}" already exists`;

    const title = name?.trim() || slug.replace(/-/g, ' ');
    const template = `---
name: "${title}"
kind: tool
rung: 2
cost: "1 GPU min"
match:
  - "${title}"
---

# ${title}

A new tool card.

## When to use it

Use when the user asks to "${title}".

\`\`\`plan
step "placeholder"
\`\`\`
`;
    try {
      putCard(slug, template);
    } catch (e) {
      return (e as Error).message;
    }
    setRevision((r) => r + 1);
    setCardId(slug);
    setTab('intel');
    notify(`Created card "${slug}"`);
    return null;
  }, [notify]);

  const deleteCard = useCallback((id: string) => {
    removeCard(id);
    setRevision((r) => r + 1);
    const remaining = allCards();
    if (remaining.length) {
      setCardId(remaining[0].id);
    }
    notify(`Deleted card "${id}"`);
  }, [notify]);

  const renameCard = useCallback((oldId: string, newId: string): string | null => {
    const nextSlug = newId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    if (!nextSlug) return 'A card id is required';
    if (nextSlug === oldId) return null;
    if (getCard(nextSlug)) return `Card "${nextSlug}" already exists`;

    const existing = getCard(oldId);
    if (!existing) return `Card "${oldId}" not found`;

    try {
      putCard(nextSlug, existing.md);
      removeCard(oldId);
    } catch (e) {
      return (e as Error).message;
    }
    setRevision((r) => r + 1);
    setCardId(nextSlug);
    notify(`Renamed card to "${nextSlug}"`);
    return null;
  }, [notify]);

  const openCard = useCallback((id: string) => {
    setCardId(id);
    setTab('intel');
  }, []);

  const inspect = useCallback((next: string) => {
    setPrompt(next);
    setPromptToken((t) => t + 1);
    setTab('bench');
  }, []);

  return {
    tab, setTab,
    prompt, setPrompt,
    strictLadder, setStrictLadder,
    cases, addCase,
    cards, cardId, dirty, revision, resetToken,
    editCard, revertCard, createCard, deleteCard, renameCard, openCard, inspect, promptToken,
    claimants,
    status, notify,
  };
}

/**
 * Alt+D toggles the workbench, the way a browser opens devtools.
 *
 * It lives here rather than inside `Workbench` because the overlay renders
 * nothing when it is closed, so the chord that OPENS it has to be listened
 * for by whatever mounts it. `Workbench` handles the closing half.
 */
export function useWorkbenchHotkey(toggle: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.code === 'KeyD') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
}
