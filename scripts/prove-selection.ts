/**
 * Select clips in the real editor, with a real pointer.
 *
 * Two selection bugs shipped past a green suite and a clean typecheck, and
 * both were reported by the user: a drag across the lanes selected nothing,
 * and clicking away from a clip never let it go. Neither is visible to a unit
 * test, because neither is about geometry. `marqueeHits` was correct before
 * this script existed; nothing was calling it.
 *
 *   npm run dev                        in another terminal
 *   npm run prove:selection
 *
 * It spends nothing: the cut is seeded into localStorage before the page's
 * own script runs, so no upload, no job and no API call happen at all.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
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
console.log(`driving ${BASE}`);

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9223;
const OUT = '/private/tmp/cutroom-selection';
const PROFILE = '/private/tmp/cutroom-selection-profile';
mkdirSync(OUT, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

/**
 * Tall enough that the ground below the last lane is on screen. One of the
 * checks is about clicking there, and at 900px high it is not in view, which
 * the harness reported as a failure of the app rather than of the window.
 */
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
  '--disable-gpu', '--no-first-run', '--window-size=1600,1400',
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
const frames = () => evaluate<number>('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))');

await send('Page.enable');
await send('Runtime.enable');
await sleep(2000);

/**
 * Seed the cut before any of the page's own script runs.
 *
 * A `setItem` from here is not enough: the page already open has a debounced
 * write of its empty document pending, that write lands after the seed, and
 * the reload then restores the empty one. This runs on the new document,
 * after the old one is gone.
 */
const snapshot = JSON.stringify(toSnapshot({
  timeline: demoProject(), project: null, dirty: true, pipelineId: null, playhead: 0,
}));
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem(${JSON.stringify(SESSION_KEY)}, ${JSON.stringify(snapshot)}); } catch (e) {}`,
});
await send('Page.reload');
await sleep(4000);

const laid = await evaluate<{ lanes: number; clips: number }>(`({
  lanes: document.querySelectorAll('[data-track-id]').length,
  clips: document.querySelectorAll('[data-clip-id]').length,
})`);
// every assertion below is about which clips are selected, and over an empty
// timeline every one of them passes by selecting nothing
check('the seeded cut is on the timeline', laid.clips > 0 && laid.lanes >= 5,
  `${laid.clips} clips over ${laid.lanes} lanes`);
if (!laid.clips) { ws.close(); chrome.kill(); process.exit(1); }

const selected = (): Promise<string[]> => evaluate<string[]>(
  `[...document.querySelectorAll('[data-clip-id][aria-selected="true"]')].map(e => e.dataset.clipId)`);

/**
 * Read the lane fresh every time. A click can scroll the timeline, and a
 * coordinate measured before that lands somewhere else afterwards: an early
 * version of this script clicked 20px outside the window and reported that
 * deselection was broken.
 */
interface LaneGeom {
  top: number;
  bottom: number;
  left: number;
  y: number;
  /** Somewhere on this lane that is not a clip, or null if the cut fills it. */
  empty: number | null;
  ground: { x: number; y: number; inView: boolean };
  clips: string[];
}

const laneGeom = () => evaluate<LaneGeom>(`(() => {
  const lane = document.querySelector('[data-track-id="trk_v1"]').getBoundingClientRect();
  const stack = document.querySelector('[data-lane-stack]').getBoundingClientRect();
  const y = (lane.top + lane.bottom) / 2;
  let empty = null;
  for (let x = Math.min(innerWidth, lane.right) - 6; x > lane.left; x -= 4) {
    const el = document.elementFromPoint(x, y);
    if (el && !el.closest('[data-clip-id]') && el.closest('[data-lane-stack]')) { empty = x; break; }
  }
  return {
    top: lane.top, bottom: lane.bottom, left: lane.left, y, empty,
    ground: { x: stack.left + 200, y: stack.bottom + 40, inView: stack.bottom + 40 < innerHeight },
    clips: [...document.querySelectorAll('[data-track-id="trk_v1"] [data-clip-id]')].map(e => e.dataset.clipId),
  };
})()`);

const SHIFT = 8;
const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });

const click = async (x: number, y: number, modifiers = 0) => {
  await mouse('mousePressed', x, y, { modifiers });
  await mouse('mouseReleased', x, y, { modifiers });
  await frames(); await frames();
};

const drag = async (x0: number, y0: number, x1: number, y1: number, modifiers = 0) => {
  await mouse('mousePressed', x0, y0, { modifiers });
  for (let i = 1; i <= 8; i++) {
    await mouse('mouseMoved', x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8,
      { buttons: 1, clickCount: 0, modifiers });
    await sleep(16);
  }
  await mouse('mouseReleased', x1, y1, { modifiers });
  await frames(); await frames();
};

/**
 * The empty point on the lane, or a stop. Every check below starts a gesture
 * from lane that holds no clip, and a run where there is none has not proved
 * anything and must not report that it has.
 */
const emptyOn = (lane: LaneGeom): number => {
  if (lane.empty === null) throw new Error('no empty lane on screen to start a gesture from');
  return lane.empty;
};

/** A band from the empty space past the last shot back across the whole lane. */
const bandAcrossV1 = async (lane: LaneGeom, modifiers = 0) =>
  drag(emptyOn(lane), lane.top + 4, lane.left + 2, lane.bottom - 4, modifiers);

let g = await laneGeom();
if (g.empty === null) {
  check('there is empty lane on screen to drag from', false, 'the cut fills the window');
} else {
  const clipX = await evaluate<number>(`(() => {
    const r = document.querySelector('[data-track-id="trk_v1"] [data-clip-id]').getBoundingClientRect();
    return r.left + Math.min(12, r.width / 2);
  })()`);

  await click(clipX, g.y);
  const one = await selected();
  check('clicking a clip selects it', one.length >= 1, one.join(','));

  g = await laneGeom();
  await click(emptyOn(g), g.y);
  const cleared = await selected();
  check('clicking empty lane lets it go', cleared.length === 0,
    cleared.length ? cleared.join(',') : `clicked x=${Math.round(emptyOn(g))}`);

  g = await laneGeom();
  await bandAcrossV1(g);
  const banded = await selected();
  const missed = g.clips.filter((id) => !banded.includes(id));
  check('a band across a lane takes every clip on it', missed.length === 0 && g.clips.length > 0,
    `${banded.length} selected, ${g.clips.length} on the lane${missed.length ? `, missed ${missed.join(',')}` : ''}`);

  const band = await evaluate<string>(`(() => {
    const b = [...document.querySelectorAll('[data-lane-stack] > div')]
      .find(e => (e.style.border || '').includes('--red'));
    return b ? b.style.display : 'no band';
  })()`);
  check('the band is gone once the pointer comes up', band === 'none', String(band));

  g = await laneGeom();
  await click(emptyOn(g), g.y);
  check('a click after a band lets go of all of it', (await selected()).length === 0);

  g = await laneGeom();
  await bandAcrossV1(g);
  const before = (await selected()).length;
  if (!g.ground.inView) {
    check('clicking below the last lane lets go too', false, 'no ground in view');
  } else {
    await click(g.ground.x, g.ground.y);
    const after = (await selected()).length;
    check('clicking below the last lane lets go too', before > 0 && after === 0, `${before} then ${after}`);
  }

  g = await laneGeom();
  await bandAcrossV1(g);
  const alone = await selected();
  g = await laneGeom();
  await click(emptyOn(g), g.y);
  await click(clipX, g.y);
  const kept = await selected();
  g = await laneGeom();
  await bandAcrossV1(g, SHIFT);
  const added = await selected();
  check('a shift band adds to the selection rather than replacing it',
    kept.length > 0 && kept.every((id) => added.includes(id)) && added.length >= alone.length,
    `${kept.length} then ${added.length}, the band alone takes ${alone.length}`);
}

const real = consoleErrors.filter((m) => !/not wrapped in act|unique "key"|Failed to load resource/i.test(m));
check('no console errors', real.length === 0, real[0] ?? `${consoleErrors.length} total, none real`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(`${OUT}/selection.png`, Buffer.from(shot.result.data, 'base64'));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
if (shot.result?.data) console.log(`screenshot: ${OUT}/selection.png`);
ws.close();
chrome.kill();
process.exit(failed.length ? 1 : 0);
