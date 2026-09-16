/**
 * Ask the assistant for subtitles and answer it, with a real pointer.
 *
 *   npm run dev                      in another terminal
 *   npm run prove:assistant-ask
 *
 * It spends nothing. The cut is seeded into localStorage before the page's own
 * script runs, and the run this drives to is stopped at the source check,
 * which is the point: what is being proved is the CONVERSATION, not the
 * transcription. `prove:subtitle-language` spends, and proves that.
 *
 * This exists because the unit suite cannot see any of what the user reported.
 * The router's answers were right in every test while the panel showed a Run
 * button that failed the moment it was pressed, and the two halves of that are
 * both invisible from node:
 *
 *  - whether a question ever reaches the screen,
 *  - whether clicking its answer runs anything.
 *
 * It is the same shape as `prove:caption-edit`, which found two defects that
 * every geometry test was green through.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { demoProject } from '../lib/fixtures/project.ts';
import { SESSION_KEY, toSnapshot } from '../lib/project/session.ts';

const PORTS = process.env.SMOKE_PORT ? [process.env.SMOKE_PORT] : ['3000', '3170', '3001'];
let BASE: string | null = null;
for (const p of PORTS) {
  try {
    const r = await fetch(`http://localhost:${p}/edit`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) { BASE = `http://localhost:${p}`; break; }
  } catch { /* try the next one */ }
}
if (!BASE) {
  console.error(`\nNo app answering /edit on ${PORTS.join(', ')}. Start it with: npm run dev\n`);
  process.exit(1);
}
console.log(`driving ${BASE}\n`);

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9227;
const PROFILE = '/private/tmp/cutroom-assistant-ask-profile';
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
  '--disable-gpu', '--no-first-run', '--window-size=1600,1200',
  `--user-data-dir=${PROFILE}`,
  `${BASE}/edit`,
], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());

async function connect(): Promise<string> {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://localhost:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t: { type: string; url: string }) => t.type === 'page' && t.url.includes('/edit'));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`Chrome did not expose a page. Is the app running on ${BASE}?`);
}

const ws = new WebSocket(await connect());
await new Promise((r) => { ws.onopen = r as () => void; });

let msgId = 0;
const pending = new Map<number, (m: Record<string, unknown>) => void>();
const consoleErrors: string[] = [];
ws.onmessage = (e: MessageEvent) => {
  const m = JSON.parse(e.data as string);
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) {
    consoleErrors.push((m.params.args ?? [])
      .map((a: { value?: unknown; description?: string }) => a.value ?? a.description ?? '')
      .join(' ').slice(0, 200));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    consoleErrors.push((d.exception?.description ?? d.text ?? 'threw').slice(0, 200));
  }
};

interface CdpReply {
  result?: { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } };
}

const send = (method: string, params: Record<string, unknown> = {}): Promise<CdpReply> =>
  new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve as (m: CdpReply) => void);
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async <T>(expression: string): Promise<T> => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'threw');
  return r.result?.result?.value as T;
};

await send('Page.enable');
await send('Runtime.enable');
await sleep(2000);

const snapshot = JSON.stringify(toSnapshot({
  timeline: demoProject(), project: null, dirty: true, pipelineId: null, playhead: 0,
}));
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem(${JSON.stringify(SESSION_KEY)}, ${JSON.stringify(snapshot)}); } catch (e) {}`,
});
await send('Page.reload');
await sleep(4500);

// ── the panel ───────────────────────────────────────────────────────────

/** The Assistant tab, which is a peer of the media pool rather than the default. */
const openAssistant = () => evaluate<boolean>(`(() => {
  const tab = [...document.querySelectorAll('button,[role=tab]')]
    .find(b => /assistant/i.test(b.textContent || ''));
  if (!tab) return false;
  tab.click();
  return true;
})()`);

const typed = () => evaluate<string[]>(
  `[...document.querySelectorAll('.cr-msg-u')].map(p => p.textContent.trim())`);
const askText = () => evaluate<string>(
  `document.querySelector('.cr-askq')?.textContent ?? ''`);
const chips = () => evaluate<string[]>(
  `[...document.querySelectorAll('.cr-askchip')].map(b => b.textContent.trim())`);
const settled = () => evaluate<string[]>(
  `[...document.querySelectorAll('.cr-askdone li')].map(li => li.textContent.trim())`);
const notes = () => evaluate<string[]>(
  `[...document.querySelectorAll('.cr-msg-a')].map(p => p.textContent.trim())`);

const clickChip = (label: string) => evaluate<boolean>(`(() => {
  const b = [...document.querySelectorAll('.cr-askchip')]
    .find(x => x.textContent.trim() === ${JSON.stringify(label)});
  if (!b) return false;
  b.click();
  return true;
})()`);

const type = async (text: string) => {
  await evaluate(`(() => {
    const el = document.getElementById('cr-chat-input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
  })()`);
  await evaluate(`document.getElementById('cr-chat-input')
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
};

/** Poll until a condition holds: a route round trip is not instant. */
async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const started = Date.now();
  let last = await read();
  while (Date.now() - started < ms) {
    if (ok(last)) return last;
    await sleep(250);
    last = await read();
  }
  return last;
}

check('the assistant panel opens', await openAssistant());
await sleep(600);

// ── one: a bare ask is a question, not a button ─────────────────────────

console.log('\n"put subtitles on this"');
await type('put subtitles on this');

const first = await until('a question', askText, (t) => t.length > 0);
/**
 * One question, and it is the one only the person can answer.
 *
 * What language is being SPOKEN is detected, and asking put a click in front
 * of every subtitle run to confirm a default. What it should be WRITTEN in is
 * nobody else's to decide, so that is the one that is asked.
 */
check('the assistant asks what it cannot work out', /subtitles read in/i.test(first),
  first || 'nothing on screen');
check('and says what it assumed rather than assuming it quietly',
  (await settled()).some((s) => /Speech/.test(s) && /Detect it/.test(s)),
  (await settled()).join(' | ') || 'it assumed something and said nothing');

/**
 * One question, once.
 *
 * `push` allocated an entry's id inside the state updater instead of when it
 * was called, so the sentence and the reply that followed it took the same
 * number, and the update that turned "the router is thinking" into the
 * question matched both. The panel showed the question twice and what had
 * been typed not at all, which is what these two count.
 */
check('what was typed is still on screen', (await typed()).includes('put subtitles on this'),
  (await typed()).join(' | ') || 'the log lost it');
const firstChips = await chips();
check('and the question is asked once, not twice',
  await evaluate<number>(`document.querySelectorAll('.cr-askfoot').length`) === 1,
  `${await evaluate<number>('document.querySelectorAll(".cr-askfoot").length')} question cards`);
check('and offers its own answers',
  firstChips.includes('Same as the speech') && firstChips.includes('English'),
  firstChips.join(' | '));
check('with no Run button to press', await evaluate<number>(
  `document.querySelectorAll('.cr-planbtn').length`) === 0);

// ── two: the one answer runs it, with no further pressing ───────────────

console.log('\nclicking "Same as the speech"');
check('the chip is clickable', await clickChip('Same as the speech'));

/**
 * The demo project cuts between several files, so `resolveToolSource` refuses
 * rather than picking one, and it says which. That refusal IS the proof: it
 * only happens if the run started, and it only reads that way if the shell
 * resolved the source instead of posting the literal text `$source`.
 */
/**
 * Wait for a real answer, not for the placeholder.
 *
 * "Routing…" is the entry that stands in while the router is asked, and an
 * assertion satisfied by it is satisfied by nothing having happened.
 */
const real = (n: string[]) => n.filter((t) => !/^Routing/.test(t));
const said = await until('a reply', notes, (n) => real(n).length > 0, 15000);
const reply = real(said).join(' | ');
check('the last answer runs it with no further pressing', reply.length > 0, reply || 'the panel said nothing');
check(
  'and it got as far as the footage, not a binding error',
  !/\$source|\$spoken|\$rewrite/.test(reply),
  reply,
);
check(
  'no clip id where the footage belongs',
  !/clp_[a-z0-9]+ is an id inside the document/i.test(reply),
  reply,
);

// ── four: a prompt that answers itself is not asked anything ────────────

console.log('\n"translate this from hindi to english"');
const before = real(await notes()).length;
await type('translate this from hindi to english');

const straight = await until('a reply', notes, (n) => real(n).length > before, 15000);
/**
 * A second card, with no question on it.
 *
 * Reading only that no question is on screen would pass on the first card
 * still sitting there answered, which is to say on the second prompt having
 * done nothing at all. It has to be a NEW card, and it has to be silent.
 */
check(
  'a prompt that answers both questions gets its own card',
  await evaluate<number>(`document.querySelectorAll('.cr-askfoot').length`) === 2,
  `${await evaluate<number>('document.querySelectorAll(".cr-askfoot").length')} cards`,
);
check(
  'and is asked neither of them',
  (await askText()) === '',
  await askText(),
);
check('and runs on the strength of what was typed', real(straight).length > before,
  real(straight).slice(before).join(' | ') || 'nothing happened, or only the placeholder');

check('the panel threw nothing', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' / '));

// ── verdict ─────────────────────────────────────────────────────────────

ws.close();
chrome.kill();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.log(failed.map((f) => `  FAIL  ${f.name}  ${f.detail}`).join('\n'));
  process.exit(1);
}
