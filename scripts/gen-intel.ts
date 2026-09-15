/**
 * Bundle lib/intel/cards/*.md into a module.
 *
 *   npm run intel
 *
 * The cards are authored as Markdown because that is what a person edits and
 * what a model reads. They are bundled because reading files at request time
 * would tie the router to a filesystem it will not have once this is a page
 * inside AISuite.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../lib/intel/parse.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'lib', 'intel', 'cards');
const OUT = join(HERE, '..', 'lib', 'intel', 'cards.generated.ts');

const files = readdirSync(DIR).filter((f) => f.endsWith('.md')).sort();
const entries: string[] = [];
const ids: string[] = [];

for (const f of files) {
  const md = readFileSync(join(DIR, f), 'utf8');
  const id = f.replace(/\.md$/, '');
  const card = parseCard(md, id);          // throws here rather than at runtime
  if (card.id !== id) throw new Error(`${f}: frontmatter id "${card.id}" does not match the filename`);
  if (!card.match.length) console.warn(`  warning: ${id} claims no match phrases, it can never be routed to`);
  ids.push(id);
  entries.push(`  ${JSON.stringify(id)}: ${JSON.stringify(md)},`);
}

/**
 * An empty union is `never`, not nothing.
 *
 * With no cards this emitted `export type CardId =` followed by a bare
 * semicolon, which is not TypeScript and broke the whole build: every page
 * that reaches the workbench imports this file. A generator has to be correct
 * at zero, because zero is the state a project starts in and the one it
 * returns to when someone clears it out.
 *
 * Built outside the template on purpose: a nested backtick closes the
 * template it is nested in, which is how the first attempt at this failed.
 */
const union = ids.length
  ? '\n' + ids.map((i) => '  | ' + JSON.stringify(i)).join('\n')
  : ' never';

const body = entries.length ? '\n' + entries.join('\n') + '\n' : '';

writeFileSync(OUT, `// GENERATED FILE. Do not edit by hand. Run: npm run intel
// Source: lib/intel/cards/*.md  ·  ${ids.length} cards


export type CardId =${union};

/** Each card's Markdown, verbatim. Parse with parseCard(). */
export const CARD_SOURCE: Record<CardId, string> = {${body}};

export const CARD_IDS: readonly CardId[] = ${JSON.stringify(ids)};
`);

console.log(`intel: ${ids.length} cards -> ${OUT}`);
if (!ids.length) {
  console.log('  no cards. The router will decline everything, which is the correct');
  console.log('  answer for a registry that claims nothing.');
}
for (const id of ids) {
  const c = parseCard(readFileSync(join(DIR, `${id}.md`), 'utf8'), id);
  console.log(`  rung ${c.rung}  ${id.padEnd(18)} ${c.match.length} phrases, ${c.veto.length} vetoes, ${c.steps.length} steps`);
}
