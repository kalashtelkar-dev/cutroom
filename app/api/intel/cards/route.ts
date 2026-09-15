import { writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Write an intel card to disk.
 *
 * The workbench could generate a card for a pipeline and show you what it
 * would say, and then there was nowhere for it to go: nothing called
 * `putCard`, so the Intel tab never listed it and the router never saw it. A
 * preview with no way to commit it is a dead end, which is what this closes.
 *
 * On disk rather than in memory on purpose. `lib/intel/cards/*.md` is the
 * source of truth and `npm run intel` bundles it; a card that lived only in
 * the session would vanish on reload and would never reach the eval suite.
 *
 * Development only. This writes into the repository, which is exactly what
 * the workbench is for and exactly what a deployed server must never do.
 */
export const dynamic = 'force-dynamic';

const DIR = join(process.cwd(), 'lib', 'intel', 'cards');
const ID = /^[a-z0-9][a-z0-9-]{1,48}$/;

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return Response.json(
      { error: 'the workbench writes to the repository, so it is development only' },
      { status: 403 },
    );
  }

  let body: { id?: string; markdown?: string; overwrite?: boolean };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const id = String(body.id ?? '').trim();
  const markdown = String(body.markdown ?? '');
  if (!ID.test(id)) {
    return Response.json(
      { error: `"${id}" is not a card id. Lower case, digits and hyphens, 2 to 49 characters.` },
      { status: 400 },
    );
  }
  /**
   * A card is refused if a section is missing or is filler.
   *
   * The generator is the first line and this is the second, because a
   * placeholder that reaches disk reaches the router: it starts winning
   * prompts and the note asking someone to fix it sits inside the card that
   * needs fixing. That happened once, which is why this check exists.
   */
  const section = (heading: string): string => {
    const at = markdown.indexOf(`## ${heading}`);
    if (at < 0) return '';
    const rest = markdown.slice(at + heading.length + 3);
    const next = rest.indexOf('\n## ');
    return (next < 0 ? rest : rest.slice(0, next)).trim();
  };

  const FILLER = /\bWRITE (THIS|A REAL)\b|\bTODO\b|\bFIXME\b|lorem ipsum/i;
  const wrong: string[] = [];
  for (const heading of ['What it does', 'When to use it', 'When NOT to use it']) {
    const body = section(heading);
    if (body.length < 25) wrong.push(`"${heading}" is missing or too short to be an answer`);
    else if (FILLER.test(body)) wrong.push(`"${heading}" still holds placeholder text`);
  }
  if (!/^match:\s*\S/m.test(markdown)) {
    wrong.push('the card claims no phrases, so it can never win a prompt');
  }
  if (wrong.length) {
    return Response.json({ error: wrong.join('; ') }, { status: 400 });
  }
  if (!markdown.startsWith('---')) {
    return Response.json({ error: 'a card starts with its frontmatter' }, { status: 400 });
  }

  const file = join(DIR, `${id}.md`);
  if (existsSync(file) && !body.overwrite) {
    return Response.json(
      { error: `${id}.md already exists. Send overwrite to replace it.`, exists: true },
      { status: 409 },
    );
  }

  try {
    writeFileSync(file, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
  } catch (e) {
    return Response.json({ error: `could not write ${id}.md: ${(e as Error).message}` }, { status: 500 });
  }

  const cards = readdirSync(DIR).filter((f) => f.endsWith('.md')).sort();
  return Response.json({
    id,
    file: `lib/intel/cards/${id}.md`,
    cards: cards.length,
    // the generated bundle is what the router and the tests read, and it is
    // committed on purpose, so saying this is not optional
    next: 'npm run intel, then npm test',
  });
}

/** What is on disk, so the tab can say whether a card is already written. */
export async function GET() {
  if (!existsSync(DIR)) return Response.json({ cards: [] });
  const cards = readdirSync(DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const text = readFileSync(join(DIR, f), 'utf8');
      const id = /^id:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? f.replace(/\.md$/, '');
      return { id, file: f };
    });
  return Response.json({ cards });
}
