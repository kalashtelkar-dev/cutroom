/**
 * Two things the user asked for, driven the way they would drive them.
 *
 *   1. A file imported by mistake can be taken back out.
 *   2. A refresh does not throw the project away.
 *
 * Both are only true in a browser, so neither can be proved by the unit
 * suite: the first is a dialog and a batch, the second is localStorage, a
 * page load and an OTIO reader. The tests cover the pieces; this covers the
 * thing.
 *
 *   node scripts/make-fixtures.mjs     once, to make the media
 *   node scripts/prove-session.mjs     needs the app running
 *
 * It SPENDS on the first run only: the import is an upload, a probe, a
 * thumbnail job and a proxy transcode. A second run finds the pool already
 * restored, which is itself the thing being proved.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const FIXTURES = '/private/tmp/cutroom-fixtures';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = '/private/tmp/cutroom-session-profile';
const DEBUG_PORT = 9241;
const FILES = ['fixture.mp4', 'fixture.jpg'];

mkdirSync(PROFILE, { recursive: true });
for (const f of FILES) {
  if (!existsSync(`${FIXTURES}/${f}`)) {
    console.error(`\nMissing ${FIXTURES}/${f}. Run: node scripts/make-fixtures.mjs\n`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const PORTS = process.env.SMOKE_PORT ? [process.env.SMOKE_PORT] : ['3000', '3170', '3001'];
let BASE = null;
for (const p of PORTS) {
  try {
    const r = await fetch(`http://localhost:${p}/edit`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) { BASE = `http://localhost:${p}`; break; }
  } catch { /* next */ }
}
if (!BASE) {
  console.error(`\nNo app answering /edit on ${PORTS.join(', ')}. Start it with: npm run dev\n`);
  process.exit(1);
}
console.log(`driving ${BASE}`);

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
  '--disable-gpu', '--no-first-run', '--window-size=1440,900',
  '--autoplay-policy=no-user-gesture-required',
  `--user-data-dir=${PROFILE}`,
  `${BASE}/edit`,
], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());

let wsUrl;
for (let i = 0; i < 40 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://localhost:${DEBUG_PORT}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page' && t.url.includes('/edit'))?.webSocketDebuggerUrl;
  } catch { /* not up */ }
  if (!wsUrl) await sleep(500);
}
if (!wsUrl) { console.error('Chrome never offered a page to drive.'); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });

let msgId = 0;
const pending = new Map();
/**
 * Read over the protocol, not out of a global the app has to remember to
 * set. A harness that reads `window.__errors` counts zero when nothing ever
 * wrote to it, and then reports a crashing page as clean.
 */
const consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    consoleErrors.push((d.exception?.description ?? d.text ?? 'threw').slice(0, 200));
  }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? 'threw' };
  return { value: r.result?.result?.value };
};
const frames = () => evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))');

await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');
await sleep(3000);

const openPool = async () => {
  await evaluate(`[...document.querySelectorAll('.cr-btab')].find(b => /media pool/i.test(b.textContent))?.click()`);
  await frames();
};
const closeJobs = async () => {
  await evaluate(`[...document.querySelectorAll('button')]
    .find(b => /close/i.test(b.getAttribute('aria-label') ?? '') && b.closest('.cr-jobs'))?.click()`);
  await frames();
};
const poolNames = async () => (await evaluate(
  `[...document.querySelectorAll('.cr-mtile .cr-nm')].map(n => n.textContent.trim())`,
)).value ?? [];
const clipCount = async () => (await evaluate(`document.querySelectorAll('[data-clip-id]').length`)).value ?? 0;

await openPool();

// ── get to a project worth refreshing ───────────────────────────────────
let names = await poolNames();
const already = FILES.every((f) => names.includes(f));

if (!already) {
  console.log('\nImporting, because the pool does not already hold the fixtures:\n');
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#cr-import-input' });
  await send('DOM.setFileInputFiles', {
    nodeId: input.result.nodeId,
    files: FILES.map((f) => `${FIXTURES}/${f}`),
  });
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    names = await poolNames();
    const busy = await evaluate(`!!document.querySelector('.cr-job[data-state="running"]')`);
    if (names.length >= FILES.length && !busy.value) break;
  }
  await closeJobs();
  await openPool();
} else {
  console.log('\nThe pool came back from the last run, which is the point:\n');
}
names = await poolNames();
check('the fixtures are in the pool', FILES.every((f) => names.includes(f)), names.join(', ') || 'empty');

// a clip on the timeline, so removal has something to take with it
if ((await clipCount()) === 0) {
  await closeJobs();
  const target = await evaluate(`(() => {
    const clip = [...document.querySelectorAll('.cr-mclip')].find(el => /fixture\\.mp4/.test(el.textContent ?? ''));
    const lane = document.querySelector('[data-lane-stack] [data-track-id]');
    if (!clip || !lane) return { ok: false, why: !clip ? 'no pool item' : 'no lane' };
    const l = lane.getBoundingClientRect();
    return { ok: true, key: clip.getAttribute('data-key'), x: Math.round(l.left + 60), y: Math.round(l.top + l.height / 2) };
  })()`);
  if (target.value?.ok) {
    const data = { items: [{ mimeType: 'application/x-cutroom-media', data: target.value.key }], dragOperationsMask: 1 };
    const at = { x: target.value.x, y: target.value.y, data, modifiers: 0 };
    await send('Input.dispatchDragEvent', { type: 'dragEnter', ...at });
    await send('Input.dispatchDragEvent', { type: 'dragOver', ...at });
    await send('Input.dispatchDragEvent', { type: 'drop', ...at });
    await frames(); await sleep(1200); await frames();
  }
}
const clipsBefore = await clipCount();
check('a clip is cut from the mp4', clipsBefore > 0, `${clipsBefore} on the timeline`);

// ── 1. the pool is no longer a dead end ─────────────────────────────────
console.log('\nRemoving a file:\n');

const affordance = await evaluate(`(() => {
  const tiles = [...document.querySelectorAll('.cr-mtile')];
  return {
    tiles: tiles.length,
    withRemove: tiles.filter(t => t.querySelector('.cr-mx')).length,
    counts: tiles.map(t => (t.querySelector('.cr-muse')?.textContent ?? '0')),
  };
})()`);
check(
  'every file in the pool has a remove control',
  affordance.value?.tiles > 0 && affordance.value.tiles === affordance.value.withRemove,
  `${affordance.value?.withRemove} of ${affordance.value?.tiles}`,
);
check(
  'the tile says how many clips are cut from the file',
  (affordance.value?.counts ?? []).some((c) => Number(c) === clipsBefore),
  `counts ${JSON.stringify(affordance.value?.counts)}, timeline has ${clipsBefore}`,
);

// clicking it asks before it does anything
await evaluate(`[...document.querySelectorAll('.cr-mtile')]
  .find(t => /fixture\\.mp4/.test(t.textContent ?? ''))?.querySelector('.cr-mx')?.click()`);
await frames();

const dialog = await evaluate(`(() => {
  const d = document.querySelector('[aria-label="Remove media"]');
  if (!d) return { open: false };
  return {
    open: true,
    text: d.textContent.replace(/\\s+/g, ' ').trim().slice(0, 260),
    go: [...d.querySelectorAll('button')].map(b => b.textContent.trim()),
    listed: d.querySelectorAll('.cr-cwhat li').length,
  };
})()`);
check('removing asks first', dialog.value?.open === true);
check(
  'the question names what goes with it',
  new RegExp(`${clipsBefore} clip`).test(dialog.value?.text ?? ''),
  dialog.value?.text?.slice(0, 120) ?? 'no dialog',
);
check(
  'and names the clips themselves',
  (dialog.value?.listed ?? 0) === clipsBefore,
  `${dialog.value?.listed} listed, ${clipsBefore} on the timeline`,
);

// Cancel means cancel
await evaluate(`[...document.querySelectorAll('[aria-label="Remove media"] button')]
  .find(b => /^cancel$/i.test(b.textContent.trim()))?.click()`);
await frames();
check(
  'cancel leaves the file and the clips alone',
  (await poolNames()).includes('fixture.mp4') && (await clipCount()) === clipsBefore,
);

// ── 2. a refresh does not throw the project away ────────────────────────
console.log('\nRefreshing:\n');

// park the playhead somewhere that is not zero, so "the playhead came back"
// is a claim about the playhead and not about the default
const ruler = await evaluate(`(() => {
  const r = document.querySelector('[data-ruler]');
  if (!r) return null;
  const b = r.getBoundingClientRect();
  return { x: Math.round(b.left + 140), y: Math.round(b.top + b.height / 2) };
})()`);
if (ruler.value) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: ruler.value.x, y: ruler.value.y, button: 'left', clickCount: 1, buttons: 1,
    });
  }
  await frames();
}
const tc = async () => (await evaluate(`document.querySelector('.cr-vtc')?.textContent?.trim() ?? ''`)).value;
const parkedAt = await tc();
check('the playhead can be parked away from the start', /^00:00:0[1-9]|^00:00:[1-9]/.test(parkedAt), parkedAt);
// the copy is written on a trailing debounce, and pagehide flushes it; wait
// past the debounce so this measures persistence and not a race
await sleep(1500);
// read the snapshot BEFORE the reload: afterwards the page has restored and
// written its own, so reading it then measures the result rather than the cause
const storedPlayhead = (await evaluate(
  `(() => { const r = localStorage.getItem('cutroom.session.v1'); return r ? JSON.parse(r).playhead : 'no snapshot'; })()`,
)).value;
await send('Page.reload');
await sleep(4500);
await openPool();

const afterReload = {
  pool: await poolNames(),
  clips: await clipCount(),
  thumbs: (await evaluate(`(() => {
    const imgs = [...document.querySelectorAll('.cr-mtile img')];
    return { total: imgs.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length };
  })()`)).value,
};
check(
  'the pool survives a refresh',
  FILES.every((f) => afterReload.pool.includes(f)),
  afterReload.pool.join(', ') || 'empty',
);
check('the cut survives a refresh', afterReload.clips === clipsBefore, `${afterReload.clips} clips`);
check(
  'and so do the thumbnails, which are the slow part to make again',
  (afterReload.thumbs?.total ?? 0) > 0 && afterReload.thumbs.total === afterReload.thumbs.loaded,
  `${afterReload.thumbs?.loaded} of ${afterReload.thumbs?.total} loaded`,
);
check(
  'the playhead comes back where it was left',
  (await tc()) === parkedAt,
  `${await tc()} vs ${parkedAt}, snapshot says frame ${storedPlayhead}`,
);
check(
  'the proxy survives too, so the viewer can still play',
  (await evaluate(`(() => {
    const raw = localStorage.getItem('cutroom.session.v1');
    if (!raw) return 0;
    const pool = JSON.parse(raw).otio?.metadata?.editor_api?.media ?? {};
    return Object.values(pool).filter(m => typeof m.proxy === 'string').length;
  })()`)).value > 0,
);

// ── the removal itself, and its undo ────────────────────────────────────
console.log('\nGoing through with it:\n');
await evaluate(`[...document.querySelectorAll('.cr-mtile')]
  .find(t => /fixture\\.mp4/.test(t.textContent ?? ''))?.querySelector('.cr-mx')?.click()`);
await frames();
await evaluate(`[...document.querySelectorAll('[aria-label="Remove media"] button')]
  .find(b => /^remove/i.test(b.textContent.trim()))?.click()`);
await frames(); await sleep(400);

check(
  'the file and its clips are gone',
  !(await poolNames()).includes('fixture.mp4') && (await clipCount()) === 0,
  `pool: ${(await poolNames()).join(', ') || 'empty'}, ${await clipCount()} clips`,
);

// one undo, not one per clip
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }))`);
await frames(); await sleep(400);
const undone = { pool: await poolNames(), clips: await clipCount() };
check(
  'one undo puts the file and every clip back',
  undone.pool.includes('fixture.mp4') && undone.clips === clipsBefore,
  `pool: ${undone.pool.join(', ') || 'empty'}, ${undone.clips} clips`,
);

check('no uncaught errors along the way', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed\n`);

/**
 * Close the browser rather than kill it.
 *
 * A killed Chrome loses whatever localStorage it had not yet flushed to
 * disk, so a second run of this script found an empty pool and re-imported,
 * which reads as "persistence does not survive a restart" when the only
 * thing that did not survive was the harness's SIGTERM. Closing it properly
 * makes the second run's "the pool came back from the last run" line mean
 * what it says.
 */
await send('Browser.close').catch(() => {});
await sleep(1200);
ws.close();
chrome.kill();
process.exit(failed.length ? 1 : 0);
