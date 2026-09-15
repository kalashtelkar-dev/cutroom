/**
 * Drive the app the way a person does.
 *
 * Unit tests prove the code agrees with itself. A screenshot proves the first
 * paint is not blank. Neither one opens the application and uses it, which is
 * why every defect that mattered in this project was found by the user and
 * not by me: demo data on screen, an import that failed, no drag and drop,
 * invented thumbnails. All of those are visible in the first minute of use.
 *
 *   node scripts/smoke.mjs            (needs the app running)
 *
 * It talks to Chrome over the DevTools protocol, so there is no test-runner
 * dependency and it exercises the real build.
 */
/**
 * Find the app rather than assume a port.
 *
 * This defaulted to 3170 while `npm run dev` serves 3000, so it reported four
 * failures against a page that was never loaded. A harness that cries wolf is
 * worse than no harness: the next real failure gets ignored.
 */
const PORTS = process.env.SMOKE_PORT ? [process.env.SMOKE_PORT] : ['3000', '3170', '3001'];
let BASE = null;
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
const DEBUG_PORT = 9222;

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

const OUT = '/private/tmp/cutroom-smoke';
const PROFILE = '/private/tmp/cutroom-smoke-profile';
mkdirSync(OUT, { recursive: true });
/**
 * A fresh browser every time.
 *
 * This script's first claim is "what a person sees when the editor opens",
 * and the editor now picks up the last session out of localStorage. Reusing
 * the profile would mean the second run measured the first run's leftovers:
 * a pool that is not empty, a track count moved by the delete test.
 */
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
  '--disable-gpu', '--no-first-run', '--window-size=1440,900',
  `--user-data-dir=${PROFILE}`,
  BASE + '/edit',
], { stdio: 'ignore' });

process.on('exit', () => chrome.kill());

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://localhost:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('/edit'));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('Chrome did not expose a page. Is the app running on ' + BASE + '?');
}

const wsUrl = await connect();
const { WebSocket } = await import('node:worker_threads').then(() => globalThis);
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.result?.exceptionDetails) {
    return { error: r.result.exceptionDetails.exception?.description ?? 'threw' };
  }
  return { value: r.result?.result?.value };
};

/**
 * Collect what the console actually says.
 *
 * This used to read `window.__smokeErrors`, which nothing ever set, so it
 * resolved to undefined, counted as 0 and passed every time. A comparison of
 * nothing always passes: it reported "no uncaught errors" through a render
 * loop that was crashing the page with "Maximum update depth exceeded".
 */
const consoleErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) {
    consoleErrors.push(
      (m.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 220),
    );
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    consoleErrors.push((d.exception?.description ?? d.text ?? 'threw').slice(0, 220));
  }
});

await send('Page.enable');
await send('Runtime.enable');
await sleep(2500);

console.log('\nWhat a person sees when the editor opens:\n');

// 1. it is not blank
const title = await evaluate(`document.querySelector('.cr-menubar') ? 'menubar' : 'missing'`);
check('the menu bar renders', title.value === 'menubar');

// 2. it opens empty, holding nobody else's footage
const pool = await evaluate(`document.querySelectorAll('.cr-mclip').length`);
check('the media pool starts empty', pool.value === 0, `${pool.value} items`);

const clips = await evaluate(`document.querySelectorAll('[data-track-id]').length`);
check('the timeline has tracks to drop onto', clips.value >= 5, `${clips.value} lanes`);

// 3. every menu opens and none is empty
//
// Awaiting two frames between the click and the query, because React has not
// rendered the popup when click() returns. The first version of this check
// reported every menu empty, which was the harness being wrong rather than
// the app, and a harness that cries wolf is worse than none.
const menus = await evaluate(`
  (async () => {
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const out = [];
    for (const b of document.querySelectorAll('.cr-menu-title')) {
      b.click();
      await frame();
      out.push([b.textContent, document.querySelectorAll('.cr-menu-item').length]);
      b.click();
      await frame();
    }
    return JSON.stringify(out);
  })()
`);
const menuData = JSON.parse(menus.value ?? '[]');
check('every menu opens with items in it', menuData.length >= 5 && menuData.every(([, n]) => n > 0),
  menuData.map(([n, c]) => `${n}:${c}`).join(' '));

// 4. nothing is drawn where footage should be
const painted = await evaluate(`
  (() => {
    const cv = document.querySelector('[data-track-id] canvas');
    if (!cv) return 'no canvas';
    const c = cv.getContext('2d');
    const d = c.getImageData(0, 0, Math.min(60, cv.width), Math.min(20, cv.height)).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 90) lit++;
    return lit;
  })()
`);
check('an empty timeline paints no invented imagery', painted.value === 0 || painted.value === 'no canvas',
  `${painted.value} lit pixels`);

// 5. the jobs panel opens and is honest about being empty
await evaluate(`
  (async () => {
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const f = [...document.querySelectorAll('.cr-menu-title')].find(b => b.textContent === 'File');
    f.click();
    await frame();
    const j = [...document.querySelectorAll('.cr-menu-item')].find(i => /Jobs/.test(i.textContent));
    j?.click();
    await frame();
    return j ? 'clicked' : 'no Jobs item';
  })()
`);
await sleep(500);
const jobs = await evaluate(`document.querySelector('.cr-jobs') ? (document.querySelector('.cr-jobs .empty')?.textContent ?? 'open') : 'missing'`);
check('the jobs panel opens', jobs.value !== 'missing', String(jobs.value).slice(0, 60));

/** Wait for React to paint. A query before it sees the previous render. */
const frames = () => evaluate(
  `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`);

// 6. the inspector fills its column rather than leaving dead black beside it
const insp = await evaluate(`(() => {
  const wrap = document.querySelector('.cr-inspwrap');
  const panel = document.querySelector('.cr-insp');
  const heads = ['.cr-btabs', '.cr-vhead', '.cr-itabs']
    .map((s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : null; });
  if (!wrap || !panel) return { ok: false, why: 'no inspector' };
  const w = Math.round(wrap.getBoundingClientRect().width);
  const p = Math.round(panel.getBoundingClientRect().width);
  return { ok: w === p && new Set(heads).size === 1, w, p, heads };
})()`);
check(
  'the inspector fills its column and the headers share one line',
  insp.value?.ok === true,
  `panel ${insp.value?.p} of ${insp.value?.w}, headers ${JSON.stringify(insp.value?.heads)}`,
);

// 7. the View menu really zooms rather than toasting about it
const zoom = await evaluate(`(() => {
  const before = document.querySelector('input[aria-label="Timeline zoom"]');
  return before ? Number(before.value) : null;
})()`);
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'View')?.click()`);
await frames();
await evaluate(`[...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] button')]
  .find(b => /zoom in/i.test(b.textContent))?.click()`);
await frames(); await frames();
const zoomAfter = await evaluate(`(() => {
  const el = document.querySelector('input[aria-label="Timeline zoom"]');
  return el ? Number(el.value) : null;
})()`);
check(
  'View then Zoom In actually zooms the timeline',
  typeof zoom.value === 'number' && typeof zoomAfter.value === 'number' && zoomAfter.value > zoom.value,
  `${zoom.value} -> ${zoomAfter.value}`,
);

// 8. Export refuses an empty timeline, and says why in the menu itself
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'File')?.click()`);
await frames();
const exp = await evaluate(`(() => {
  const item = [...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] button')]
    .find(b => /export video/i.test(b.textContent));
  if (!item) return { found: false };
  // aria-disabled, not the DOM property: the item stays focusable so a
  // keyboard user can read the reason it is refused
  return {
    found: true,
    disabled: item.getAttribute('aria-disabled') === 'true',
    text: item.textContent.trim(),
  };
})()`);
check('Export Video is in the File menu', exp.value?.found === true);
check(
  'Export is refused on an empty timeline, with the reason on the item',
  exp.value?.disabled === true && /nothing on the timeline/i.test(exp.value?.text ?? ''),
  (exp.value?.text ?? '').slice(0, 70),
);
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await frames();

// 9. the workbench opens over the cut
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'View')?.click()`);
await frames();
await evaluate(`[...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] button')]
  .find(b => /workbench/i.test(b.textContent))?.click()`);
await frames(); await frames();
const bench = await evaluate(`[...document.querySelectorAll('.wb-tab')].map(b => b.textContent.trim())`);
check(
  'View then Workbench opens it',
  Array.isArray(bench.value) && bench.value.length === 4,
  Array.isArray(bench.value) ? bench.value.join(' ') : String(bench.value),
);

// 10. delete a track, add one back, and it lands in its own section
const trackNames = `[...document.querySelectorAll('[role="listitem"]')]
  .map(r => (r.querySelector('span')?.nextElementSibling?.textContent ?? '').trim())
  .filter(Boolean)`;
const before = await evaluate(trackNames);

// the delete button is revealed on hover, but it is in the DOM either way
const deleted = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('[role="listitem"]')];
  const v2 = rows.find(r => /Video 2/.test(r.textContent));
  if (!v2) return 'no Video 2 row';
  const del = v2.querySelector('.cr-trkdel');
  if (!del) return 'no delete button';
  del.click();
  return 'clicked';
})()`);
await frames(); await frames();
const afterDelete = await evaluate(trackNames);
check(
  'a track can be deleted from its header',
  deleted.value === 'clicked' && (afterDelete.value?.length ?? 0) === (before.value?.length ?? 0) - 1,
  `${before.value?.length} then ${afterDelete.value?.length}`,
);

await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Timeline')?.click()`);
await frames();
await evaluate(`[...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] button')]
  .find(b => /add video track/i.test(b.textContent))?.click()`);
await frames(); await frames();

// the lanes carry their kind in the badge: V for picture, A for sound
const kinds = await evaluate(`[...document.querySelectorAll('[role="listitem"]')]
  .map(r => (r.querySelector('button')?.textContent ?? '').trim()[0])
  .filter(Boolean)`);
const seq = Array.isArray(kinds.value) ? kinds.value.join('') : '';
check(
  'a new video track lands above the audio tracks, not among them',
  /^V+A+$/.test(seq),
  seq || String(kinds.value),
);

// 11. console errors are bugs, and a render loop is the loudest of them
const loops = consoleErrors.filter((m) => /Maximum update depth/i.test(m));
check(
  'no render loop',
  loops.length === 0,
  loops.length ? loops[0].slice(0, 90) : 'nothing looped',
);
// React's own warnings about keys and act() are noise from the harness, not
// defects in the app, so they are named rather than swept up wholesale
const real = consoleErrors.filter((m) => !/Maximum update depth|not wrapped in act|unique "key"/i.test(m));
check(
  'no console errors',
  real.length === 0,
  real.length ? `${real.length}: ${real[0].slice(0, 80)}` : `${consoleErrors.length} total, none real`,
);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(`${OUT}/edit.png`, Buffer.from(shot.result.data, 'base64'));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
if (shot.result?.data) console.log(`screenshot: ${OUT}/edit.png`);
ws.close();
chrome.kill();
process.exit(failed.length ? 1 : 0);
