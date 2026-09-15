import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * House rules, enforced rather than remembered.
 *
 * A rule that lives only in a document survives exactly as long as everyone
 * who read it. This file is the reason the em-dash rule will still hold in
 * six months.
 */

// fileURLToPath, not .pathname: the repo path contains a space and a
// URL-encoded %20 is not a directory anyone has.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP = new Set(['node_modules', '.next', '.git', 'public']);
/**
 * Markdown and .mjs are in this list because they were not, and that was a
 * hole the rule fell straight through: four em-dashes went into ROADMAP.md
 * past a green suite, and `npm run tidy` was able to rewrite the em-dashes
 * out of CLAUDE.md, the document that defines the rule, without this
 * noticing. The documented grep has always included `*.md`; this did not.
 */
const EXTS = ['.ts', '.tsx', '.css', '.json', '.md', '.mjs'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

describe('house rules', () => {
  const files = walk(ROOT);

  test('the repo has source files to check', () => {
    assert.ok(files.length > 20, `only found ${files.length} files, so the walk is wrong`);
  });

  test('no em-dashes, anywhere', () => {
    //, rather than the character itself, so this file does not fail itself
    const EM = String.fromCharCode(0x2014);
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (!text.includes(EM)) continue;
      text.split('\n').forEach((line, i) => {
        if (line.includes(EM)) offenders.push(`${relative(ROOT, f)}:${i + 1}  ${line.trim().slice(0, 90)}`);
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `use a colon, a comma or a full stop instead:\n${offenders.join('\n')}`,
    );
  });

  test('components take their chrome colours from tokens, not from literals', () => {
    /**
     * Two hex literals are legitimate and the rule has to know the difference.
     *
     *  - a FALLBACK behind a token read. Canvas cannot resolve a CSS custom
     *    property, so painters call getComputedStyle and pass a literal as the
     *    value to use when the token is missing or during SSR. The token is
     *    still the source of truth.
     *  - CONTENT. The procedural filmstrip painter invents stand-in imagery
     *    until real poster frames exist; those colours are pixels in a picture,
     *    not chrome, and no token should govern them.
     *
     * Anything else is a colour that will not follow the theme.
     */
    const ALLOWED = /token\(|getPropertyValue|FALLBACK|PALETTE|fallback/;
    // components/ui/tokens.ts is the one file whose job is to hold literals:
    // it is the SSR fallback table for every token, and centralising them
    // there is what keeps them out of everywhere else.
    const EXEMPT = 'components/ui/tokens.ts';
    const offenders: string[] = [];
    for (const f of files) {
      if (!f.includes('/components/') || f.endsWith(EXEMPT)) continue;
      const text = readFileSync(f, 'utf8');
      let inPalette = false;
      text.split('\n').forEach((line, i) => {
        if (/^const (PALETTES|FALLBACK)\b/.test(line.trim())) inPalette = true;
        else if (inPalette && /^\];?$/.test(line.trim())) inPalette = false;
        if (inPalette || ALLOWED.test(line)) return;
        const m = line.match(/#[0-9a-fA-F]{3,8}\b/);
        if (m) offenders.push(`${relative(ROOT, f)}:${i + 1}  ${m[0]}  ${line.trim().slice(0, 70)}`);
      });
    }
    assert.deepEqual(offenders, [], `style with var(--token) from app/globals.css:\n${offenders.join('\n')}`);
  });

  test('the SSR token fallbacks match the stylesheet they promise to mirror', () => {
    /**
     * components/ui/tokens.ts carries a literal for every token so canvas
     * painting works before hydration. A table that quietly drifts from
     * app/globals.css is worse than no table: the page renders one palette
     * and then swaps to another. The file's docstring promises they match,
     * so the promise is checked.
     */
    const css = readFileSync(join(ROOT, 'app', 'globals.css'), 'utf8');
    const root = css.slice(css.indexOf(':root {'), css.indexOf('@theme'));
    const declared = new Map<string, string>();
    for (const m of root.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
      declared.set(m[1], m[2].trim().toLowerCase());
    }

    const ts = readFileSync(join(ROOT, 'components', 'ui', 'tokens.ts'), 'utf8');
    const table = ts.slice(ts.indexOf('FALLBACKS'), ts.indexOf('};', ts.indexOf('FALLBACKS')));
    const pairs = [...table.matchAll(/'(--[\w-]+)':\s*'([^']+)'/g)];

    // A comparison of nothing passes. If the table is renamed or reshaped,
    // this test would silently stop checking, which is the failure mode it
    // exists to prevent in the first place.
    assert.ok(declared.size > 20, `only found ${declared.size} tokens in globals.css`);
    assert.ok(pairs.length > 20, `only found ${pairs.length} fallbacks to compare`);

    const drift: string[] = [];
    for (const m of pairs) {
      const [, name, fallback] = m;
      const real = declared.get(name);
      if (real === undefined) { drift.push(`${name} is not in globals.css at all`); continue; }
      if (real !== fallback.toLowerCase()) drift.push(`${name}: tokens.ts says ${fallback}, globals.css says ${real}`);
    }
    assert.deepEqual(drift, [], `the fallback table has drifted:\n${drift.join('\n')}`);
  });

  test('no leftover stubs', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f.includes('/test/')) continue;
      const text = readFileSync(f, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/\bTODO\b|\bFIXME\b|not implemented/i.test(line)) {
          offenders.push(`${relative(ROOT, f)}:${i + 1}  ${line.trim().slice(0, 80)}`);
        }
      });
    }
    assert.deepEqual(offenders, [], `finish it or delete it:\n${offenders.join('\n')}`);
  });
});
