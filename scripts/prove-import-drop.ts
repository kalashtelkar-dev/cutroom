/**
 * Drop a file on the media pool and watch it become an import.
 *
 *   npm run dev                        in another terminal
 *   npm run prove:import-drop
 *
 * Drag and drop is the part that breaks, and it breaks invisibly. This repo
 * has the scar twice already: a caption lane called `onGrab` for a cue and
 * `onGrab` returned early on anything that was not a clip, so cues were
 * immovable on screen while every unit test of the geometry passed; and the
 * drag's own `preventDefault` then stopped the browser ever synthesising the
 * `dblclick` that in-place editing was waiting for. Neither was visible to
 * `npm test`, because neither was about geometry.
 *
 * The same shape of bug is available here in three places, and each of them
 * leaves the app looking completely normal:
 *
 *  - no `preventDefault` on dragover, and the browser takes the drop instead
 *    and navigates the tab to the file. The handler is perfect and never runs.
 *  - reading `dataTransfer.files` instead of `types` to decide, and a pool
 *    tile dragged within the pool reads as an import of nothing.
 *  - the handler running and reaching no importer, which is a drop that
 *    highlights, clears, and quietly does nothing at all.
 *
 * So this drives a real DragEvent carrying a real File at the real panel and
 * then asks the app what happened.
 *
 * It SPENDS NOTHING. The cut is seeded into localStorage before the page's
 * own script runs, and `fetch` is replaced before the drop, so the import
 * gets as far as asking for an upload URL and no further. That refusal is the
 * assertion: the request proves the file reached the importer, and blocking
 * it proves no byte left the machine.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { demoProject } from '../lib/fixtures/project.ts';
import { SESSION_KEY, toSnapshot } from '../lib/project/session.ts';
// the app's own drag type, not a copy of the string: a copy would keep this
// passing after the real one changed
import { DRAG_TYPE } from '../lib/media/drop.ts';

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
console.log(`driving ${BASE}`);

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9226;
const OUT = '/private/tmp/cutroom-import-drop';
const PROFILE = '/private/tmp/cutroom-import-drop-profile';
mkdirSync(OUT, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
  '--disable-gpu', '--no-first-run', '--window-size=1600,1000',
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
const pending = new Map<number, (m: CdpReply) => void>();
interface CdpReply {
  result?: {
    result?: { value?: unknown };
    data?: string;
    exceptionDetails?: { exception?: { description?: string } };
  };
}
ws.onmessage = (e: MessageEvent) => {
  const m = JSON.parse(e.data as string);
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
};

const send = (method: string, params: Record<string, unknown> = {}): Promise<CdpReply> =>
  new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async <T>(expression: string): Promise<T> => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'threw');
  return r.result?.result?.value as T;
};
/** Wait for React to paint. A query before it sees the previous render. */
const paint = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))');

await send('Page.enable');
await send('Runtime.enable');
await sleep(2500);

const snapshot = JSON.stringify(toSnapshot({
  timeline: demoProject(), project: null, dirty: true, pipelineId: null, playhead: 0,
}));
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem(${JSON.stringify(SESSION_KEY)}, ${JSON.stringify(snapshot)}); } catch (e) {}`,
});
await send('Page.reload');
await sleep(5000);

// ── the panel has to be the one on screen ───────────────────────────────

const opened = await evaluate<boolean>(
  `!![...document.querySelectorAll('.cr-btab')].find(b=>b.textContent.trim()==='Media Pool')?.click() || true`,
);
await sleep(900);
const poolThere = await evaluate<boolean>(`!!document.querySelector('.cr-pool')`);
check('the Media Pool tab opens the pool', opened && poolThere);
if (!poolThere) { ws.close(); chrome.kill(); process.exit(1); }

/**
 * Nothing leaves the machine.
 *
 * Every request the importer makes is recorded and refused. The recording is
 * what proves the drop arrived somewhere real; the refusal is what keeps this
 * script free to run.
 */
await evaluate(`window.__calls = [];
  window.fetch = (...a) => { window.__calls.push(String(a[0])); return Promise.reject(new Error('blocked by the harness')); };`);

// ── hold a file over the panel ──────────────────────────────────────────

await evaluate(`window.__dt = new DataTransfer();
  window.__dt.items.add(new File([new Uint8Array([0,1,2,3])], 'dropped-clip.mp4', { type: 'video/mp4' }));
  window.__pool = document.querySelector('.cr-pool');
  const at = window.__pool.getBoundingClientRect();
  window.__opts = { bubbles: true, cancelable: true, dataTransfer: window.__dt,
    clientX: at.left + at.width / 2, clientY: at.top + at.height / 2 };
  window.__pool.dispatchEvent(new DragEvent('dragenter', window.__opts));
  const ev = new DragEvent('dragover', window.__opts);
  window.__pool.dispatchEvent(ev);
  window.__overTaken = ev.defaultPrevented; 1`);

check(
  'dragover is claimed, which is the whole of whether a drop can happen',
  await evaluate<boolean>('window.__overTaken'),
  'unclaimed, the browser takes the drop and navigates the tab to the file',
);
// the ring is React state, so it is a render away and not a statement away
await paint();
check(
  'holding files over the pool lights the drop ring',
  await evaluate<boolean>(`!!document.querySelector('.cr-pool[data-over]')`),
);

const ring = await send('Page.captureScreenshot', { format: 'png' });
if (ring.result?.data) writeFileSync(`${OUT}/ring.png`, Buffer.from(ring.result.data, 'base64'));

// ── let go ──────────────────────────────────────────────────────────────

check(
  'the drop is taken by the app',
  await evaluate<boolean>(`(() => {
    const ev = new DragEvent('drop', window.__opts);
    window.__pool.dispatchEvent(ev);
    return ev.defaultPrevented;
  })()`),
);
await sleep(700);

const after = await evaluate<{ text: string; calls: string[]; over: boolean }>(`({
  text: document.body.innerText.slice(-800),
  calls: window.__calls,
  over: !!document.querySelector('.cr-pool[data-over]'),
})`);

check('the ring clears once the file is taken', !after.over);
check(
  'the file reached the importer',
  after.calls.some((c) => c.includes('/api/uploads')),
  after.calls.length ? after.calls.join(', ') : 'the drop handler ran and asked for nothing',
);
check(
  'and the app said what it was doing with it',
  /dropped-clip\.mp4|Import/i.test(after.text),
  (after.text.match(/Import[^\n]*/) ?? ['nothing on screen about it'])[0],
);

/**
 * The other drag this panel has.
 *
 * A pool tile is draggable onto the timeline, and that drag carries a media
 * key rather than a file. If the pool decided by payload instead of by
 * `types`, dragging a tile a few pixels would read as an import and the ring
 * would come up over a drag that is not one.
 */
const tileDrag = await evaluate<boolean>(`(() => {
  const dt = new DataTransfer();
  dt.setData(${JSON.stringify(DRAG_TYPE)}, 'some-media-key');
  const at = window.__pool.getBoundingClientRect();
  window.__pool.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true,
    dataTransfer: dt, clientX: at.left + at.width / 2, clientY: at.top + at.height / 2 }));
  return true;
})()`);
await paint();
check(
  'a tile dragged over the pool is not mistaken for an import',
  tileDrag && !(await evaluate<boolean>(`!!document.querySelector('.cr-pool[data-over]')`)),
);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(`${OUT}/after.png`, Buffer.from(shot.result.data, 'base64'));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
console.log(`screenshots: ${OUT}/ring.png, ${OUT}/after.png\n`);
ws.close();
chrome.kill();
process.exit(failed.length ? 1 : 0);
