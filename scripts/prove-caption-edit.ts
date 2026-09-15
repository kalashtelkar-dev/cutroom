/**
 * Move, retime and retype a cue in the real editor, with a real pointer.
 *
 * The unit tests know the geometry is right. They cannot know the pointer
 * reaches it, and in this repo that is exactly where this feature was broken:
 * the lane called `onGrab` for a caption and `onGrab` returned early on
 * anything that was not a clip, so a cue was draggable in every test and
 * immovable on screen. `captionSpan` and `dragCaption` would have been just
 * as green with nothing calling them.
 *
 *   npm run dev                        in another terminal
 *   npm run prove:caption-edit
 *
 * It spends nothing: the cut and its subtitles are seeded into localStorage
 * before the page's own script runs, so no upload, no job, no API call.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { demoProject } from '../lib/fixtures/project.ts';
import { SESSION_KEY, toSnapshot } from '../lib/project/session.ts';
import { applyEdits } from '../lib/timeline/edits.ts';
import { placeCuesOps } from '../lib/subtitles/place.ts';
import { frames } from '../lib/time/frames.ts';

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
const DEBUG_PORT = 9224;
const OUT = '/private/tmp/cutroom-caption-edit';
const PROFILE = '/private/tmp/cutroom-caption-edit-profile';
mkdirSync(OUT, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

/** Three cues with 48 frames of room between them, on a real cut. */
const CUES = [
  { start: frames(24), duration: frames(24), text: 'one' },
  { start: frames(96), duration: frames(24), text: 'two' },
  { start: frames(168), duration: frames(24), text: 'three' },
];
const base = demoProject();
const seeded = applyEdits(base, placeCuesOps(base, CUES, { createTrack: true, seed: 'p' })).timeline;

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
  result?: {
    result?: { value?: unknown };
    data?: string;
    exceptionDetails?: { exception?: { description?: string } };
  };
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
/** Wait for React to paint. A query before it sees the previous render. */
const painted = () => evaluate<number>('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))');

await send('Page.enable');
await send('Runtime.enable');
await sleep(2000);

const snapshot = JSON.stringify(toSnapshot({
  timeline: seeded, project: null, dirty: true, pipelineId: null, playhead: 0,
}));
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem(${JSON.stringify(SESSION_KEY)}, ${JSON.stringify(snapshot)}); } catch (e) {}`,
});
await send('Page.reload');
await sleep(4000);

/** Every cue on screen, as pixels and words. Read fresh: a drag can scroll. */
interface Cue { id: string; left: number; right: number; width: number; y: number; text: string }

const cues = () => evaluate<Cue[]>(`[...document.querySelectorAll('[data-caption-id]')].map(e => {
  const r = e.getBoundingClientRect();
  return {
    id: e.dataset.captionId,
    left: r.left, right: r.right, width: r.width,
    y: (r.top + r.bottom) / 2,
    text: (e.querySelector('span') || e).textContent,
  };
})`);

const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });

const drag = async (x0: number, y0: number, x1: number, y1: number) => {
  await mouse('mousePressed', x0, y0);
  for (let i = 1; i <= 10; i++) {
    await mouse('mouseMoved', x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10,
      { buttons: 1, clickCount: 0 });
    await sleep(16);
  }
  await mouse('mouseReleased', x1, y1);
  await painted(); await painted();
};

const first = await cues();
check('three cues are on the timeline', first.length === 3, `${first.length} found`);
if (first.length !== 3) {
  ws.close(); chrome.kill(); process.exit(1);
}

/**
 * One frame in pixels, measured rather than assumed.
 *
 * Every cue was seeded 24 frames long, so the width on screen is the scale.
 * A drag of N pixels lands on the frame nearest it, so every assertion below
 * allows one frame of rounding and not a pixel more.
 */
const ppf = first[0].width / 24;
const slack = ppf + 1;
const near = (a: number, b: number) => Math.abs(a - b) <= slack;
/**
 * Snapping is on in the editor, as it is for a user, so an edge dropped near
 * a cut lands ON the cut. That is the feature working, not the drag missing,
 * and it is worth up to SNAP_PX of travel. Anything looser than this would
 * stop being a measurement.
 */
const snapSlack = 8 + slack;
const nearly = (a: number, b: number) => Math.abs(a - b) <= snapSlack;
check('the lane is zoomed enough to aim at', ppf > 0.5, `${ppf.toFixed(2)}px per frame`);

const mid = (c: Cue) => c.left + c.width / 2;

// ── the cue moves, and only the cue moves ──────────────────────────────
{
  const [one, two, three] = first;
  const by = Math.min(60, (three.left - two.right) / 2);
  await drag(mid(two), two.y, mid(two) + by, two.y);
  const after = await cues();
  const moved = after.find((c) => c.id === two.id)!;
  check('dragging a cue moves it by what the pointer travelled',
    near(moved.left, two.left + by) && near(moved.width, two.width),
    `${Math.round(two.left)} to ${Math.round(moved.left)}, wanted ${Math.round(two.left + by)}`);
  check('the cues either side of it stay where they were',
    near(after.find((c) => c.id === one.id)!.left, one.left)
    && near(after.find((c) => c.id === three.id)!.left, three.left),
    'a shifted neighbour is the whole class of bug this feature could have had');
}

// ── the wall ───────────────────────────────────────────────────────────
{
  const now = await cues();
  const [one, two] = now;
  await drag(mid(two), two.y, one.left - 200, two.y);
  const after = await cues();
  const moved = after.find((c) => c.id === two.id)!;
  const kept = after.find((c) => c.id === one.id)!;
  check('a cue dragged into its neighbour stops flush against it',
    near(moved.left, kept.right), `stopped at ${Math.round(moved.left)}, cue one ends ${Math.round(kept.right)}`);
  check('and the neighbour still has its words', kept.text === 'one', kept.text);
  check('and keeps its own length through the collision', near(moved.width, two.width),
    `${Math.round(two.width)} then ${Math.round(moved.width)}`);
}

// ── an edge ────────────────────────────────────────────────────────────
{
  const now = await cues();
  const two = now[1];
  const by = 40;
  // the out handle is the rightmost 5px of the cue
  await drag(two.right - 2, two.y, two.right - 2 + by, two.y);
  const after = await cues();
  const trimmed = after.find((c) => c.id === two.id)!;
  check('dragging the end of a cue makes it longer and leaves its start alone',
    near(trimmed.left, two.left) && nearly(trimmed.width, two.width + by),
    `start ${Math.round(two.left)} to ${Math.round(trimmed.left)}, `
    + `width ${Math.round(two.width)} to ${Math.round(trimmed.width)}`);

  const three = after[2];
  await drag(trimmed.right - 2, trimmed.y, three.right + 300, trimmed.y);
  const grown = (await cues()).find((c) => c.id === two.id)!;
  check('and it stops at the cue after it rather than swallowing it',
    near(grown.right, three.left) && (await cues()).length === 3,
    `ends at ${Math.round(grown.right)}, cue three starts ${Math.round(three.left)}`);
}

// ── the words ──────────────────────────────────────────────────────────
{
  const before = (await cues())[1];
  // a real double click: two whole press/release pairs, close together
  await mouse('mousePressed', mid(before), before.y);
  await mouse('mouseReleased', mid(before), before.y);
  await sleep(60);
  await mouse('mousePressed', mid(before), before.y, { clickCount: 2 });
  await mouse('mouseReleased', mid(before), before.y, { clickCount: 2 });
  await painted(); await painted();

  const typing = await evaluate<boolean>(
    `document.activeElement?.classList.contains('cr-cap-edit') === true`);
  check('double-clicking a cue opens its words for typing', typing);

  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'],
  });
  await send('Input.insertText', { text: 'मम्मी' });
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await painted(); await painted();

  const after = (await cues())[1];
  check('the typed words land on the cue', after.text === 'मम्मी', `"${after.text}"`);
  check('and typing did not move it', near(after.left, before.left) && near(after.width, before.width),
    `${Math.round(before.left)}/${Math.round(before.width)} then ${Math.round(after.left)}/${Math.round(after.width)}`);
}

// ── undo ───────────────────────────────────────────────────────────────
{
  const before = (await cues())[1];
  for (let i = 0; i < 5; i++) {
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 4, commands: ['undo'],
    });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 4 });
    await painted();
  }
  const after = await cues();
  const back = after[1];
  check('undo walks every one of those edits back',
    after.length === 3 && back.text === 'two' && near(back.left, first[1].left) && near(back.width, first[1].width),
    `"${back.text}" at ${Math.round(back.left)}, seeded at ${Math.round(first[1].left)}`);
  if (back.text === before.text && !near(back.left, first[1].left)) {
    console.log('    (five undos may not be enough if the drags coalesced)');
  }
}

const real = consoleErrors.filter((m) => !/not wrapped in act|unique "key"|Failed to load resource/i.test(m));
check('no console errors', real.length === 0, real[0] ?? `${consoleErrors.length} total, none real`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(`${OUT}/caption-edit.png`, Buffer.from(shot.result.data, 'base64'));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
if (shot.result?.data) console.log(`screenshot: ${OUT}/caption-edit.png`);
ws.close();
chrome.kill();
process.exit(failed.length ? 1 : 0);
