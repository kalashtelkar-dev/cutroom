/**
 * What the background agents are doing.
 *
 *   npm run agents
 *
 * Reads the workflow journal directly, because there is no slash command for
 * it in this build and "ask Claude" is not a status page.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/Users/kalash/.claude/projects/-Users-kalash-Tool-caller';

function newestWorkflowDir(): string | null {
  const sessions = existsSync(ROOT) ? readdirSync(ROOT) : [];
  const dirs: { path: string; at: number }[] = [];
  for (const s of sessions) {
    const wf = join(ROOT, s, 'subagents', 'workflows');
    if (!existsSync(wf)) continue;
    for (const run of readdirSync(wf)) {
      const p = join(wf, run);
      try { dirs.push({ path: p, at: statSync(p).mtimeMs }); } catch { /* gone */ }
    }
  }
  dirs.sort((a, b) => b.at - a.at);
  return dirs[0]?.path ?? null;
}

const dir = process.argv[2] ?? newestWorkflowDir();
if (!dir) { console.log('no workflow has run in this project yet'); process.exit(0); }

const journal = join(dir, 'journal.jsonl');
const agents = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
  : [];

const done: { label: string; head: string; brokenLeft: number | null }[] = [];
if (existsSync(journal)) {
  for (const line of readFileSync(journal, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== 'result') continue;
    const value = rec.result;
    if (value && typeof value === 'object' && 'stillBroken' in value) {
      const sb = (value as { stillBroken: unknown[] }).stillBroken;
      done.push({ label: 'verify', head: (value as { verdict?: string }).verdict?.split('\n')[0] ?? '', brokenLeft: sb.length });
    } else {
      const text = String(value ?? '');
      done.push({ label: 'repair', head: text.split('\n').find((l) => l.trim()) ?? '', brokenLeft: null });
    }
  }
}

console.log(`workflow: ${dir.split('/').pop()}`);
console.log(`agents started: ${agents.length}   finished: ${done.length}\n`);

for (const d of done) {
  const mark = d.brokenLeft === null ? '·' : d.brokenLeft === 0 ? 'ok' : '!!';
  const tail = d.brokenLeft === null ? '' : `  still broken: ${d.brokenLeft}`;
  console.log(`  ${mark} ${d.label.padEnd(7)} ${d.head.slice(0, 96)}${tail}`);
}

if (done.length < agents.length) {
  console.log(`\n  ${agents.length - done.length} still working. Re-run to refresh.`);
} else if (done.length) {
  console.log('\n  all done.');
}
