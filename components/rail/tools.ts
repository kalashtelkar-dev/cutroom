/**
 * The tool list, built FROM the intel cards.
 *
 * The rule this file exists to enforce: **a tool's description, cost and rung
 * come from its intel card and from nowhere else.** The router reads that card
 * to decide what a sentence means; the rail reads the same card to tell a
 * person what the icon does. A second copy of the sentence would let a tool
 * describe itself one way to the model and another way to the user, and the
 * two copies would drift apart the first time someone edited one of them.
 *
 * So what lives here is only what a card genuinely does not carry: a glyph, a
 * group, a short name, the arm-card's parameter menus, and the precondition
 * predicate. Everything a person reads is `blurb(card)`, `card.cost`,
 * `card.rung`, `card.match` and `card.examples`.
 *
 * A card with no entry in PRESENTATION still becomes a tool, that is how a
 * pipeline built in the workbench lands on the rail without a code change.
 */

// Relative, not the '@/' alias: this module is pure and test/shell-ui.test.ts
// imports it straight into node, which resolves neither tsconfig paths nor a
// bundler's aliases.
import { allCards, blurb, getCard, type Card } from '../../lib/intel/index.ts';
import { clipAt, findTrack, isClip } from '../../lib/timeline/document.ts';
import type { PlacedItem, Timeline, TrackKind } from '../../lib/timeline/types.ts';
import type { Frames } from '../../lib/time/frames.ts';

// ── icons ───────────────────────────────────────────────────────────────

/**
 * Icon geometry, not markup, because this file is `.ts` and cannot hold JSX.
 * `ToolIcon` in ToolRail.tsx is the one renderer, so the rail, the palette
 * and the run card cannot disagree about how a glyph is drawn.
 *
 * Every glyph is a 16-unit box drawn to read at 17px with a 1.35 stroke.
 * Where a standard exists it is used, which is why subtitles are a CC box.
 *
 * One glyph per card in play, plus `graph` for a card nobody has drawn one
 * for. The eight that belonged to the archived cards went with them:
 * geometry for a tool that does not exist is a drawing nothing can render.
 * `git log -p -- components/rail/tools.ts` has them if a card comes back.
 */
export type IconShape =
  | { k: 'path'; d: string; solid?: boolean; dash?: string }
  | { k: 'rect'; x: number; y: number; w: number; h: number; r?: number }
  | { k: 'circle'; cx: number; cy: number; r: number; solid?: boolean };

const ICONS = {
  subtitles: [
    { k: 'rect', x: 1.2, y: 3, w: 13.6, h: 10, r: 1.2 },
    { k: 'path', d: 'M3.8 9.6h3.6M9.6 9.6h2.6' },
  ],
  /** A graph we cannot characterise: three nodes and a join. */
  graph: [
    { k: 'circle', cx: 3.6, cy: 4, r: 1.7 },
    { k: 'circle', cx: 12.4, cy: 4, r: 1.7 },
    { k: 'circle', cx: 8, cy: 12.2, r: 1.7 },
    { k: 'path', d: 'M3.6 5.7v1.3a1 1 0 001 1h6.8a1 1 0 001-1V5.7M8 8v2.5' },
  ],
} as const satisfies Record<string, readonly IconShape[]>;

export type IconName = keyof typeof ICONS;
export const icon = (name: IconName): readonly IconShape[] => ICONS[name];

// ── tools ───────────────────────────────────────────────────────────────

/**
 * The headings on the rail, in the order they appear.
 *
 * `GENERATE` was `BUILD`. The rail's groups name what a tool DOES to the cut,
 * and the things that will live under this one all make something that was
 * not there before, which "build" was too broad a word for once it was the
 * only heading on screen.
 *
 * A card can name its own group in its front matter, so a card carrying
 * `group: BUILD` now falls through to its PRESENTATION entry rather than
 * matching: `presentationFor` only takes a group that is in this list. That
 * is the right way round, and it is why the archived cards were left saying
 * whatever they said.
 */
export const GROUPS = ['CUT', 'GENERATE', 'POLISH'] as const;
export type ToolGroup = (typeof GROUPS)[number];

export interface ToolParam {
  key: string;
  label: string;
  options: string[];
  defaultIndex: number;
}

/**
 * What the editor looks like right now, reduced to the handful of facts a
 * precondition can ask about. Derived from the document on every render by
 * `toolContext`; nothing here is stored.
 */
export interface ToolContext {
  hasVideo: boolean;
  hasAudio: boolean;
  videoClipCount: number;
  selection: { name: string; trackKind: TrackKind } | null;
  /**
   * A video clip covers the playhead AND the playhead is past that clip's
   * first frame. Blading on the first frame would leave a zero-length piece
   * behind, so "under the playhead" is not quite the right question.
   */
  splittableAtPlayhead: boolean;
}

export interface Tool {
  id: string;
  group: ToolGroup;
  /** A name, never a description, the description is the card's. */
  name: string;
  /** The intel card this tool IS. Every word a person reads comes from it. */
  cardId: string;
  icon: readonly IconShape[];
  /** Returns why the tool cannot run yet, or null when it can. */
  requires?: (ctx: ToolContext) => string | null;
  /** What it wants, in a phrase, shown on the tooltip when it *can* run. */
  needs?: string;
  params?: ToolParam[];
}

interface Presentation {
  group: ToolGroup;
  order: number;
  name: string;
  icon: IconName;
  needs?: string;
  requires?: (ctx: ToolContext) => string | null;
  params?: ToolParam[];
}

/**
 * What a card does not carry: a glyph, a group, a name, a precondition.
 *
 * One entry, because one card is in play. The other eight went to
 * `lib/intel/archive/` with their cards, rather than being left here to
 * describe tools the rail can no longer build: an entry whose card is gone
 * is never read, and the next person to read this file would have taken it
 * for a list of what Cutroom does.
 *
 * A card that comes back without an entry still reaches the rail through
 * `improvise()`, under a name made from its id and the generic glyph. That
 * is the seam a pipeline built in the workbench arrives through, and it is
 * why nothing here is required.
 */
const PRESENTATION: Record<string, Presentation> = {
  /**
   * No params, because neither of the two it had reached anything.
   *
   * `runTool` reads `args.target` and nothing else, so Style and Language
   * were two dropdowns that changed the run in no way at all. Language
   * cannot be offered here even once something does read the params: it is
   * a param on the whisperx nodes inside the pipeline, fixed in the graph,
   * and a pipeline's run body only carries its input nodes. Boxed and
   * karaoke need a caption style the document cannot hold yet.
   */
  'subtitle-burn': {
    group: 'GENERATE', order: 3, name: 'Gen Subtitles', icon: 'subtitles',
    needs: 'speech on a dialogue track',
    requires: (c) => (c.hasAudio ? null : 'no audio track to transcribe'),
  },
};

/** A card nobody has drawn an icon for yet still deserves a place on the rail. */
function improvise(card: Card): Presentation {
  const name = card.id.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return { group: 'POLISH', order: 99, name, icon: 'graph' };
}

function presentationFor(card: Card): Presentation {
  const fallback = PRESENTATION[card.id] ?? improvise(card);
  const meta = card.meta ?? {};
  const group = (meta.group && GROUPS.includes(meta.group as ToolGroup) ? meta.group : fallback.group) as ToolGroup;
  const icon = (meta.icon && meta.icon in ICONS ? meta.icon : fallback.icon) as IconName;
  const name = meta.tool_name || meta.name || fallback.name;
  const needs = meta.needs || fallback.needs;
  const parsedOrder = meta.order ? parseInt(meta.order, 10) : fallback.order;
  const order = Number.isNaN(parsedOrder) ? fallback.order : parsedOrder;
  return {
    ...fallback,
    group,
    icon,
    name,
    needs,
    order,
  };
}

/**
 * Read every card and hand back the rail.
 *
 * Deliberately a function rather than a module constant: the card registry is
 * mutable, the workbench edits frontmatter and adds generated cards, and a
 * snapshot taken at import time would show a tool describing itself out of a
 * card that has since changed.
 */
export function buildTools(): Tool[] {
  const tools = allCards().map<Tool>((card) => {
    const p = presentationFor(card);
    return {
      id: `t-${card.id}`,
      group: p.group,
      name: p.name,
      cardId: card.id,
      icon: ICONS[p.icon],
      requires: p.requires,
      needs: p.needs,
      params: p.params,
    };
  });
  const rank = (t: Tool) => {
    const card = getCard(t.cardId);
    const p = card ? presentationFor(card) : (PRESENTATION[t.cardId] ?? { order: 99 });
    return GROUPS.indexOf(t.group) * 100 + p.order;
  };
  return tools.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// ── what a tool says about itself, all of it read from the card ─────────

export const toolCard = (t: Tool): Card | undefined => getCard(t.cardId);

export function toolBlurb(t: Tool): string {
  const card = toolCard(t);
  return card ? blurb(card) : '';
}

export function toolCost(t: Tool): string {
  const card = toolCard(t);
  return card?.cost ?? '';
}

export function toolRung(t: Tool): number {
  const card = toolCard(t);
  return card?.rung ?? 3;
}

/**
 * The cost tier the corner dot shows: rung 1 is a local document patch and
 * carries no dot, rung 2 is one operation, rung 3 and up is a pipeline or a
 * graph and will spend GPU time. You can see what a click costs before you
 * make it.
 */
export type CostTier = 0 | 1 | 2;
export function toolTier(t: Tool): CostTier {
  const rung = toolRung(t);
  return rung <= 1 ? 0 : rung === 2 ? 1 : 2;
}

/** Rung-1 tools are a document patch: they run on click, with no arm card. */
export const runsLocally = (t: Tool): boolean => toolTier(t) === 0;

export const toolWhy = (t: Tool, ctx: ToolContext): string | null => t.requires?.(ctx) ?? null;

/**
 * The tooltip body. When a tool cannot run, the meta line says *why* instead
 * of what it costs, the cost of a thing you cannot do is not the question
 * you are asking.
 */
export function toolTipParts(t: Tool, ctx: ToolContext): [string, string, string] {
  const why = toolWhy(t, ctx);
  // the requirement gets its own line rather than running on from the blurb
  const desc = toolBlurb(t) + (t.needs && !why ? `\nNeeds ${t.needs}.` : '');
  const meta = why
    ? `can’t run yet, ${why}`
    : [`rung ${toolRung(t)}`, toolCost(t)].filter(Boolean).join(' · ');
  return [t.name, desc, meta];
}

// ── search ──────────────────────────────────────────────────────────────

export type PhraseSource = 'match' | 'example';

export interface ToolHit {
  tool: Tool;
  /** The tool's own phrase that caught the query, and where it came from. */
  phrase: string | null;
  from: PhraseSource | null;
}

/**
 * Search the same vocabulary the router searches.
 *
 * A card that claims "cutaway" for routing owns it here too. If the palette
 * matched only on names, typing what you want, "cutaway", "louder",
 * "shorter", would find nothing, and the assistant would understand a
 * sentence the tool list claimed not to know.
 */
function haystack(t: Tool): string {
  const card = toolCard(t);
  return [
    t.name, t.group, t.needs ?? '', toolBlurb(t),
    card?.match.join(' ') ?? '',
    card?.examples.join(' ') ?? '',
    card?.whenToUse ?? '',
  ].join(' ').toLowerCase();
}

/**
 * The phrase to show. A match phrase beats an example because the match list
 * is the card's canonical claim and an example is only illustrative; within
 * each, an exact hit beats a containment one.
 */
function phraseFor(t: Tool, q: string): { phrase: string; from: PhraseSource } | null {
  const card = toolCard(t);
  if (!card) return null;
  const lists: [PhraseSource, string[]][] = [['match', card.match], ['example', card.examples]];
  for (const [from, list] of lists) {
    const exact = list.find((p) => p === q);
    if (exact) return { phrase: exact, from };
  }
  for (const [from, list] of lists) {
    const near = list.find((p) => p.length > 2 && (p.includes(q) || q.includes(p)));
    if (near) return { phrase: near, from };
  }
  return null;
}

export function searchTools(tools: Tool[], query: string): ToolHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return tools.map((tool) => ({ tool, phrase: null, from: null }));
  return tools
    .filter((t) => haystack(t).includes(q) || phraseFor(t, q) !== null)
    .map((tool) => {
      const hit = phraseFor(tool, q);
      return { tool, phrase: hit?.phrase ?? null, from: hit?.from ?? null };
    });
}

// ── the editor state a precondition asks about ─────────────────────────

/**
 * The half of the context that depends on the document alone.
 *
 * Split out because it walks every item on every track and the other half
 * moves with the playhead. Memoise this on the timeline and a seek stops
 * paying for a count that cannot have changed.
 */
export type TrackFacts = Pick<ToolContext, 'hasVideo' | 'hasAudio' | 'videoClipCount'>;

export function trackFacts(timeline: Timeline): TrackFacts {
  let video = 0;
  let audio = 0;
  for (const track of timeline.tracks) {
    const n = track.items.filter(isClip).length;
    if (track.kind === 'audio') audio += n;
    else if (track.kind === 'video') video += n;
  }
  return { hasVideo: video > 0, hasAudio: audio > 0, videoClipCount: video };
}

export function toolContextFrom(
  facts: TrackFacts,
  timeline: Timeline,
  playhead: Frames,
  selection: PlacedItem | null,
): ToolContext {
  const under = clipAt(timeline, playhead);
  const selTrack = selection ? findTrack(timeline, selection.trackId) : undefined;

  return {
    ...facts,
    selection:
      selection && isClip(selection.item)
        ? { name: selection.item.name, trackKind: selTrack?.kind ?? 'video' }
        : null,
    // half-open: the playhead being ON the first frame means the whole clip is
    // still ahead of it, and blading there would leave nothing behind
    splittableAtPlayhead: under !== null && playhead > under.range.start,
  };
}

export const toolContext = (
  timeline: Timeline,
  playhead: Frames,
  selection: PlacedItem | null,
): ToolContext => toolContextFrom(trackFacts(timeline), timeline, playhead, selection);
