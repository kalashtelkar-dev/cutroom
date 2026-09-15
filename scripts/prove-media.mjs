/**
 * Import real files through the real application, and look at what appears.
 *
 * This is the path every media bug in this project has lived in, and the one
 * I had never driven. Each of these was reported by the user, not found here,
 * and every one of them is visible within seconds of doing what this script
 * does:
 *
 *   - a JPG got no preview, because ffmpeg/thumbnail takes file:video only
 *   - a still used its own upload key, which outputs/sign refuses outright
 *   - every video frame was discarded by a role filter, because
 *     ffmpeg/thumbnail tags all of its outputs "poster"
 *
 * Unit tests missed all three: they used a fake transport that agreed with
 * whatever the code assumed. Only the real API disagrees.
 *
 *   node scripts/make-fixtures.mjs     once, to make the media
 *   node scripts/prove-media.mjs       needs the app running
 *
 * It SPENDS: each import is an upload, a probe and a thumbnail job.
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

const FIXTURES = '/private/tmp/cutroom-fixtures';
const OUT = '/private/tmp/cutroom-media';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9240;
const PROFILE = '/private/tmp/cutroom-media-profile';
mkdirSync(OUT, { recursive: true });
/**
 * A fresh browser every time: the editor picks up the last session now, and
 * a pool restored from the previous run would make "every file reached the
 * media pool" count the same files twice.
 */
rmSync(PROFILE, { recursive: true, force: true });

const FILES = ['fixture.mp4', 'fixture.jpg', 'fixture.png', 'fixture.wav'];
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
  // headless has no user to gesture at it, and a browser will not start media
  // with sound without one. This is an artifact of the harness, not of the app:
  // in a real browser the press IS the gesture.
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
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });

let msgId = 0;
const pending = new Map();
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

console.log('\nImporting real files through the real app:\n');

// The Assistant is the default panel, so the pool is behind a tab. Without
// this the pool reads as empty and every check below fails for the wrong
// reason: the items existed, nothing was rendering them.
await evaluate(`[...document.querySelectorAll('.cr-btab')].find(b => /media pool/i.test(b.textContent))?.click()`);
await frames();

// a baseline, so "it painted something" cannot pass on an empty timeline
const beforeDrop = await evaluate(`(() => {
  let lit = 0;
  for (const c of document.querySelectorAll('canvas')) {
    if (c.width < 8 || c.height < 4) continue;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4 * 37) if (d[i] + d[i + 1] + d[i + 2] > 90) lit += 1;
  }
  return lit;
})()`);

// ── the import, driven exactly as a person does it ──────────────────────
const doc = await send('DOM.getDocument');
const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#cr-import-input' });
await send('DOM.setFileInputFiles', {
  nodeId: input.result.nodeId,
  files: FILES.map((f) => `${FIXTURES}/${f}`),
});

// uploads, probes and thumbnail jobs, one file at a time by design
let poolCount = 0;
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  const r = await evaluate(`document.querySelectorAll('.cr-mclip').length`);
  poolCount = r.value ?? 0;
  const busy = await evaluate(`!!document.querySelector('.cr-job[data-state="running"]')`);
  if (poolCount >= FILES.length && !busy.value) break;
}
check('every file reached the media pool', poolCount === FILES.length, `${poolCount} of ${FILES.length}`);

// the row existing is not the picture being there: wait for the decode, or
// the next three checks race the network and fail for the wrong reason
for (let i = 0; i < 40; i++) {
  const r = await evaluate(`(() => {
    const imgs = [...document.querySelectorAll('.cr-mclip img')];
    return imgs.length && imgs.every(i => i.complete);
  })()`);
  if (r.value) break;
  await sleep(500);
}

// ── what the document actually holds ────────────────────────────────────
const media = await evaluate(`(() => {
  const out = [];
  for (const el of document.querySelectorAll('.cr-mclip')) {
    const name = el.querySelector('.cr-nm')?.textContent?.trim() ?? '?';
    const img = el.querySelector('img, canvas');
    let painted = 0;
    if (img && img.tagName === 'CANVAS') {
      const c = img.getContext('2d');
      const d = c.getImageData(0, 0, img.width, img.height).data;
      for (let i = 3; i < d.length; i += 40) if (d[i] > 8) painted += 1;
    }
    out.push({
      name,
      kind: img ? img.tagName.toLowerCase() : 'none',
      loaded: img && img.tagName === 'IMG' ? (img.complete && img.naturalWidth > 0) : painted > 0,
      src: img && img.tagName === 'IMG' ? (img.currentSrc || img.src || '').slice(0, 120) : '',
    });
  }
  return out;
})()`);

const rows = media.value ?? [];
for (const f of ['fixture.mp4', 'fixture.jpg', 'fixture.png']) {
  const row = rows.find((r) => r.name === f);
  check(
    `${f} shows a real thumbnail in the pool`,
    !!row && row.loaded === true,
    row ? `${row.kind}${row.loaded ? '' : ' did not load'}` : 'not in the pool',
  );
}
const wav = rows.find((r) => r.name === 'fixture.wav');
check('fixture.wav is in the pool and asks for no picture', !!wav, wav ? 'present' : 'missing');

// ── no frame key may be an upload key, which can never be signed ────────
const badKeys = await evaluate(`(() => {
  const imgs = [...document.querySelectorAll('.cr-mclip img')].map(i => i.currentSrc || i.src || '');
  return imgs.filter(u => decodeURIComponent(u).includes('key=input/')).length;
})()`);
check('no thumbnail points at an upload key', (badKeys.value ?? 0) === 0, `${badKeys.value} bad`);

// The jobs panel opens itself during an import and covers the right half of
// the window. A drag aimed under it hits the panel, not the timeline, which
// is what a person would find too.
await evaluate(`[...document.querySelectorAll('button')]
  .find(b => /close/i.test(b.getAttribute('aria-label') ?? '') && b.closest('.cr-jobs'))?.click()`);
await frames();

// ── drop one on the timeline and look at the pixels ─────────────────────
// Chrome's own drag dispatch, not a fabricated DragEvent: a hand-made one
// carries a DataTransfer the browser did not create, and the drop path we
// care about is the one a real pointer takes.
const target = await evaluate(`(() => {
  const clip = [...document.querySelectorAll('.cr-mclip')]
    .find(el => /fixture\\.mp4/.test(el.textContent ?? '') || /\\.mp4/.test(el.getAttribute('data-tip') ?? ''));
  const stack = document.querySelector('[data-lane-stack]');
  const lane = stack?.querySelector('[data-track-id]');
  if (!clip || !stack || !lane) return { ok: false, why: !clip ? 'no pool item' : !stack ? 'no stack' : 'no lane' };
  const l = lane.getBoundingClientRect();
  return {
    ok: true,
    key: clip.getAttribute('data-key'),
    x: Math.round(l.left + 60),
    y: Math.round(l.top + l.height / 2),
  };
})()`);

let dropped = { ok: false, why: target.value?.why ?? 'no target' };
if (target.value?.ok) {
  const data = {
    items: [{ mimeType: 'application/x-cutroom-media', data: target.value.key }],
    dragOperationsMask: 1,
  };
  const at = { x: target.value.x, y: target.value.y, data, modifiers: 0 };
  await send('Input.dispatchDragEvent', { type: 'dragEnter', ...at });
  await send('Input.dispatchDragEvent', { type: 'dragOver', ...at });
  await send('Input.dispatchDragEvent', { type: 'drop', ...at });
  dropped = { ok: true };
}
await frames(); await sleep(2000); await frames();

const onTimeline = await evaluate(`document.querySelectorAll('[data-clip-id]').length`);
check(
  'a dropped clip lands on the timeline',
  (onTimeline.value ?? 0) > 0,
  dropped.ok ? `${onTimeline.value} clip(s)` : String(dropped.why),
);

const strip = await evaluate(`(() => {
  const canvases = [...document.querySelectorAll('[data-lane-stack] canvas')]
    .filter(c => c.width > 8 && c.height > 4);
  let best = { lit: 0, hues: 0 };
  for (const c of canvases) {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0; const hues = new Set();
    for (let i = 0; i < d.length; i += 4 * 37) {
      const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
      if (r + g + b > 90) lit += 1;
      hues.add((r >> 5) + ',' + (g >> 5) + ',' + (b >> 5));
    }
    if (lit > best.lit) best = { lit, hues: hues.size };
  }
  return best;
})()`);
check(
  'the clip on the timeline paints real frames, not a flat slab',
  // measured against the empty timeline, because the ruler and the playhead
  // paint too: without the baseline this passed on an empty editor
  (strip.value?.lit ?? 0) > (beforeDrop.value ?? 0) && (strip.value?.hues ?? 0) > 4,
  `${strip.value?.lit} lit vs ${beforeDrop.value} empty, ${strip.value?.hues} colours`,
);

// ── B-roll on a second track, over the first, while playing ─────────────
// The reported bug: B-roll showed when parked and vanished on play, because
// the monitor drew one element carrying whatever was topmost, and reloaded
// it every time the playhead crossed into a different clip.
const second = await evaluate(`(() => {
  const pool = [...document.querySelectorAll('.cr-mclip')]
    .find(el => /fixture\\.png/.test(el.getAttribute('data-tip') ?? ''));
  const stack = document.querySelector('[data-lane-stack]');
  const lanes = stack ? [...stack.querySelectorAll('[data-track-id]')] : [];
  const existing = document.querySelector('[data-clip-id]');
  if (!pool || !lanes.length || !existing) return { ok: false, why: 'nothing to stack onto' };
  // the lane above the one the first clip landed on
  const onLane = existing.closest('[data-track-id]');
  const i = lanes.indexOf(onLane);
  // the first clip landed on the topmost lane, so the layer underneath it is
  // the NEXT one down. Dropping onto the same lane would only nudge it along.
  const other = lanes[i + 1] ?? lanes[Math.max(0, i - 1)];
  if (other === onLane) return { ok: false, why: 'only one picture lane' };
  const u = other.getBoundingClientRect();
  const e = existing.getBoundingClientRect();
  return {
    ok: true, key: pool.getAttribute('data-key'),
    // the SAME start as the clip below, or the two never overlap in time and
    // there is no moment where both are layers
    x: Math.round(e.left + 12), y: Math.round(u.top + u.height / 2),
  };
})()`);
if (second.value?.ok) {
  const data = { items: [{ mimeType: 'application/x-cutroom-media', data: second.value.key }], dragOperationsMask: 1 };
  const at = { x: second.value.x, y: second.value.y, data, modifiers: 0 };
  await send('Input.dispatchDragEvent', { type: 'dragEnter', ...at });
  await send('Input.dispatchDragEvent', { type: 'dragOver', ...at });
  await send('Input.dispatchDragEvent', { type: 'drop', ...at });
}
await frames(); await sleep(1500); await frames();

const stacked = await evaluate(`document.querySelectorAll('[data-clip-id]').length`);
if ((stacked.value ?? 0) < 2) {
  const why = await evaluate(`(() => {
    const stack = document.querySelector('[data-lane-stack]');
    const lanes = stack ? [...stack.querySelectorAll('[data-track-id]')] : [];
    return {
      lanes: lanes.map(l => {
        const b = l.getBoundingClientRect();
        return l.getAttribute('data-track-id') + ' y=' + Math.round(b.top) + '..' + Math.round(b.bottom);
      }),
      poolKeys: [...document.querySelectorAll('.cr-mclip')].map(e => (e.getAttribute('data-tip') ?? '').split('|')[0]),
      toast: document.querySelector('.cutroom-toast')?.textContent ?? 'none',
    };
  })()`);
  console.log('    second drop target:', JSON.stringify(second.value));
  console.log('    page said:', JSON.stringify(why.value));
}
check('a second clip stacks on the track above', (stacked.value ?? 0) >= 2,
  second.value?.ok ? `${stacked.value} clips` : String(second.value?.why));

// ── park the playhead on the clip, the way a person does ────────────────
// Click the clip to select and focus, then ArrowDown, which the timeline
// binds to "go to the next edit point". That lands exactly on the clip's
// first frame, and ranges are half-open, so the clip IS under the playhead.
const clipAt_ = await evaluate(`(() => {
  const c = document.querySelector('[data-clip-id]');
  if (!c) return { ok: false, why: 'no clip' };
  const b = c.getBoundingClientRect();
  return { ok: true, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
})()`);
if (clipAt_.value?.ok) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: clipAt_.value.x, y: clipAt_.value.y, button: 'left', clickCount: 1, buttons: 1,
    });
  }
  await frames();
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40 });
  }
  // a second in, not on the edit point itself: parked exactly on a cut only
  // the clip that starts there is under the playhead, and two clips dropped
  // at the same pixel can still begin a frame apart
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type, code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39, modifiers: 8,
    });
  }
}
await frames(); await sleep(1500); await frames();
const parked = await evaluate(`!/no clip under the playhead/i.test(document.querySelector('.cr-viewer')?.textContent ?? '')`);
check('the playhead can be parked on a clip', parked.value === true,
  parked.value ? 'a clip is under it' : 'nothing under the playhead');

const layersParked = await evaluate(`document.querySelectorAll('.cr-vframe video, .cr-vframe img').length`);
check(
  'both tracks show as layers in the monitor',
  (layersParked.value ?? 0) >= 2,
  `${layersParked.value} layer(s)`,
);

// ── the viewer shows the frame under the playhead ───────────────────────
const viewer = await evaluate(`(() => {
  const el = document.querySelector('.cr-vframe video, .cr-vframe img');
  if (!el) return { why: 'no layer in the monitor' };
  const w = el.videoWidth || el.naturalWidth || 0;
  const h = el.videoHeight || el.naturalHeight || 0;
  if (!w || !h) return { why: 'the layer has decoded no picture yet' };
  const c = document.createElement('canvas');
  c.width = 160; c.height = 90;
  const g = c.getContext('2d');
  g.drawImage(el, 0, 0, 160, 90);
  const d = g.getImageData(0, 0, 160, 90).data;
  let lit = 0; const hues = new Set();
  for (let i = 0; i < d.length; i += 4 * 7) {
    const [r, gg, b] = [d[i], d[i + 1], d[i + 2]];
    if (r + gg + b > 90) lit += 1;
    hues.add((r >> 5) + ',' + (gg >> 5) + ',' + (b >> 5));
  }
  return { lit, hues: hues.size };
})()`);
check(
  'the viewer paints the frame under the playhead',
  (viewer.value?.lit ?? 0) > 0 && (viewer.value?.hues ?? 0) > 3,
  viewer.value?.why ?? `${viewer.value?.lit} lit, ${viewer.value?.hues} colours`,
);

const stuck = await evaluate(`(document.querySelector('.cr-viewer')?.textContent ?? '')`);
check(
  'the viewer is not stuck saying it is loading',
  !/loading the frame/i.test(String(stuck.value ?? '')),
  /loading the frame/i.test(String(stuck.value ?? '')) ? 'still loading' : 'painted',
);

// ── it plays, with sound, like a media player ───────────────────────────
const proxied = await evaluate(`(async () => {
  const v = document.querySelector('.cr-vstage video');
  if (!v) return { why: 'no video element' };
  const src = v.getAttribute('src') || '';
  if (!src) return { why: 'the element has no source, so nothing was transcoded' };
  let status = '?';
  try {
    const r = await fetch(src, { headers: { Range: 'bytes=0-1023' } });
    status = r.status + ' ' + (r.headers.get('content-type') || '') +
      ' range:' + (r.headers.get('content-range') || 'none');
  } catch (e) { status = 'threw ' + e.message; }
  return { src: decodeURIComponent(src).slice(0, 110), status, readyState: v.readyState };
})()`);
check(
  'the clip has a playable copy, served with byte ranges',
  /^206 /.test(proxied.value?.status ?? '') && /range:bytes/.test(proxied.value?.status ?? ''),
  proxied.value?.why ?? String(proxied.value?.status),
);

// wait for the element to have media to play, then press play
for (let i = 0; i < 40; i++) {
  const r = await evaluate(`(document.querySelector('.cr-vstage video')?.readyState ?? 0) >= 2`);
  if (r.value) break;
  await sleep(500);
}
// a real pointer on the real Play button, so the press carries a gesture
const playBtn = await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')]
    .find(x => (x.getAttribute('aria-label') ?? '') === 'Play');
  if (!b) return { ok: false, why: 'no Play button' };
  const r = b.getBoundingClientRect();
  return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
const at0 = await evaluate(`document.querySelector('.cr-vstage video')?.currentTime ?? -1`);
if (playBtn.value?.ok) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: playBtn.value.x, y: playBtn.value.y, button: 'left', clickCount: 1, buttons: 1,
    });
  }
}
await sleep(2000);
const played = await evaluate(`(() => {
  const v = document.querySelector('.cr-vstage video');
  if (!v) return { why: 'no video element' };
  return { after: v.currentTime, paused: v.paused, readyState: v.readyState };
})()`);
played.value = played.value ? { ...played.value, moved: (played.value.after ?? 0) - (at0.value ?? 0) } : played.value;
if (!playBtn.value?.ok) played.value = { why: playBtn.value?.why };
check(
  'pressing play actually plays the media',
  (played.value?.moved ?? 0) > 0.2,
  played.value?.why ?? `moved ${(played.value?.moved ?? 0).toFixed(2)}s, readyState ${played.value?.readyState}`,
);

// the layers must survive playback, which is the reported bug

if (playBtn.value?.ok) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: playBtn.value.x, y: playBtn.value.y, button: 'left', clickCount: 1, buttons: 1,
    });
  }
}
await sleep(1500);
const whilePlaying = await evaluate(`(() => {
  const els = [...document.querySelectorAll('.cr-vframe video, .cr-vframe img')];
  return {
    count: els.length,
    visible: els.filter(e => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 4 && r.height > 4 && cs.display !== 'none' && Number(cs.opacity) > 0;
    }).length,
  };
})()`);
check(
  'the upper layer is still shown while playing',
  (whilePlaying.value?.visible ?? 0) >= 2,
  `${whilePlaying.value?.visible} of ${whilePlaying.value?.count} visible`,
);

const real = consoleErrors.filter((m) => !/not wrapped in act|unique "key"/i.test(m));
check('no console errors through the whole import', real.length === 0,
  real.length ? real[0].slice(0, 100) : 'clean');

// ── when something failed, say what the page actually held ─────────────
if (checks.some((c) => !c.ok)) {
  const dump = await evaluate(`(async () => {
    const imgs = [...document.querySelectorAll('.cr-mclip img')];
    const out = [];
    for (const i of imgs.slice(0, 3)) {
      const u = i.currentSrc || i.src || '';
      let status = 'not fetched';
      try {
        const r = await fetch(u);
        status = r.status + ' ' + (r.headers.get('content-type') || '');
        if (!r.ok) status += ' ' + (await r.text()).slice(0, 160);
      } catch (e) { status = 'threw ' + e.message; }
      out.push({ src: decodeURIComponent(u).slice(0, 130), complete: i.complete, w: i.naturalWidth, status });
    }
    return {
      thumbs: out,
      poolMarkup: document.querySelector('.cr-mclip')?.outerHTML?.slice(0, 400) ?? 'none',
      playheadAt: document.querySelector('.cr-tc, [class*=timecode]')?.textContent?.trim() ?? '?',
      viewerText: (document.querySelector('.cr-viewer')?.textContent ?? '').slice(0, 120),
      clipBox: (() => { const c = document.querySelector('[data-clip-id]');
        if (!c) return 'none'; const b = c.getBoundingClientRect();
        return Math.round(b.left) + '..' + Math.round(b.right); })(),
      laneStack: !!document.querySelector('[data-lane-stack]'),
      clips: document.querySelectorAll('[data-clip-id]').length,
      laneCanvases: [...document.querySelectorAll('[data-lane-stack] canvas')]
        .map(c => c.width + 'x' + c.height),
      viewerCanvas: (() => { const c = document.querySelector('.cr-vstage canvas');
        return c ? c.width + 'x' + c.height : 'none'; })(),
    };
  })()`);
  console.log('\n--- what the page held ---');
  console.log(JSON.stringify(dump.value, null, 1));
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(`${OUT}/imported.png`, Buffer.from(shot.result.data, 'base64'));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
console.log(`screenshot: ${OUT}/imported.png`);
ws.close();
chrome.kill();
process.exit(failed.length ? 1 : 0);
