import type { Card, CardMeta, Step } from './types.ts';

const section = (body: string, name: string): string => {
  const m = body.match(new RegExp(`##\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i'));
  return m ? m[1].trim() : '';
};

const csv = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * Parse one card.
 *
 * Deliberately forgiving: a card is authored by hand and a missing section
 * should degrade the card, not throw. A malformed plan fence is the one
 * exception, a plan that does not parse would be executed as nothing, and
 * silently doing nothing is worse than failing.
 */
export function parseCard(md: string, fallbackId = ''): Card {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  const meta = {} as CardMeta;
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (m) meta[m[1]] = m[2].trim();
    }
  }
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, '');

  let steps: Step[] = [];
  const fence = body.match(/```json\s*\n([\s\S]*?)```/);
  if (fence) {
    try {
      const parsed: unknown = JSON.parse(fence[1]);
      if (!Array.isArray(parsed)) throw new Error('plan must be an array of steps');
      steps = parsed as Step[];
    } catch (e) {
      throw new Error(
        `card "${meta.id ?? fallbackId}" has a plan that does not parse: ${(e as Error).message}`,
      );
    }
  }

  const whenToUse = section(body, 'When to use it');
  // Double quotes only: a single quote is an apostrophe far more often than
  // it is a delimiter, and "It's just me talking" must survive intact.
  // Examples wrap across lines in the source, so collapse whitespace.
  const examples = [...whenToUse.matchAll(/[“"]([^“”"]{6,80})[”"]/g)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.,;:]$/, ''))
    .filter((v, i, a) => v.length >= 6 && a.indexOf(v) === i);

  const prose = body
    .replace(/```[\s\S]*?```/g, ' ')   // the plan is data, not description
    .replace(/^#{1,6}\s.*$/gm, ' ')     // headings are boilerplate in every card
    .replace(/[|`*_>-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    id: meta.id ?? fallbackId,
    md,
    meta,
    body,
    match: csv(meta.match),
    veto: csv(meta.veto),
    rung: Number.parseInt(meta.rung ?? '2', 10) || 2,
    cost: meta.cost ?? '',
    whatItDoes: section(body, 'What it does'),
    whenToUse,
    examples,
    whenNotToUse: section(body, 'When NOT to use it'),
    prose,
    steps,
  };
}

/** The one-line summary a tool shows in a tooltip or a palette row. */
export function blurb(card: Card, max = 150): string {
  const text = card.whatItDoes.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const first = text.split('. ')[0];
  const out = first.length < 28 ? text : `${first}.`;
  if (out.length <= max) return out;
  const cut = out.slice(0, max);
  return `${cut.slice(0, Math.max(0, cut.lastIndexOf(' '))).replace(/[,;:]$/, '')}…`;
}
