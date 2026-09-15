/**
 * Strip em-dashes from the repo.
 *
 *   npm run tidy
 *
 * The rule is enforced by test/house-rules.test.ts, but a failing test tells
 * you where the problem is without fixing it, and this is a habit that comes
 * back every time anyone writes prose. So: one command that fixes it.
 *
 * A comma is the default because it is grammatical wherever an em-dash was
 * being appositive, which is nearly everywhere. The exceptions are labels and
 * headings, where a colon reads better, and a bare em-dash standing in for
 * "no value", which becomes a hyphen.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EM = String.fromCharCode(0x2014);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP = new Set(['node_modules', '.next', '.git', 'public']);

/**
 * Files that are ALLOWED to contain an em-dash, because they are about
 * em-dashes.
 *
 * This script rewrote CLAUDE.md, which documents the rule, and in doing so
 * turned the documented check into `grep` for a plain hyphen: an instruction
 * that now matches almost every line of the repo. A tool that enforces a rule
 * must not corrupt the statement of the rule, and the archive is a record of
 * what was written, not something to rewrite either.
 */
const KEEP = new Set(['CLAUDE.md']);
const KEEP_DIRS = ['lib/intel/archive', 'test/fixtures'];
const EXTS = ['.ts', '.tsx', '.css', '.md', '.json', '.html'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || KEEP.has(entry)) continue;
    const full = join(dir, entry);
    if (KEEP_DIRS.some((d) => full.endsWith(d))) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

/** A label followed by its expansion reads better with a colon than a comma. */
const LABEL = new RegExp(`^(\\s*(?:[*/#-]+\\s*)?[A-Z][\\w .'\`()/-]{0,40}?) ${EM} `, '');

function fixLine(line: string): string {
  if (!line.includes(EM)) return line;
  let out = line;

  // a bare em-dash used as "no value"
  out = out.replace(new RegExp(`(['"\`>])${EM}(['"\`<])`, 'g'), '$1-$2');

  // A matched pair on one line is a parenthetical, and two commas around a
  // long aside read as a stumble. Parentheses say the same thing plainly.
  const pair = new RegExp(` ${EM} ([^${EM}]{2,80}) ${EM} `, 'g');
  out = out.replace(pair, ' ($1) ');

  if (LABEL.test(out)) out = out.replace(LABEL, '$1: ');

  out = out.replace(new RegExp(` ${EM} `, 'g'), ', ');
  out = out.replace(new RegExp(`${EM} `, 'g'), ', ');
  out = out.replace(new RegExp(` ${EM}`, 'g'), ',');
  out = out.replace(new RegExp(EM, 'g'), ',');
  return out.replace(/,\s*,/g, ',').replace(/,<\//g, '</');
}

let files = 0;
let count = 0;
for (const file of walk(ROOT)) {
  const before = readFileSync(file, 'utf8');
  if (!before.includes(EM)) continue;
  const after = before.split('\n').map(fixLine).join('\n');
  if (after === before) continue;
  count += before.split(EM).length - 1;
  files += 1;
  writeFileSync(file, after);
  console.log(`  ${relative(ROOT, file)}`);
}
console.log(count ? `tidy: removed ${count} em-dashes from ${files} files` : 'tidy: nothing to do');
if (count) console.log('re-run `npm run intel` and `npm run catalogue` if a generated file changed');
