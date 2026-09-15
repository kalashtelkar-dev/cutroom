/**
 * A subtitle has to be on screen while the video is PLAYING.
 *
 * The bug: cues were transcribed, placed, drawn, and visible when you
 * scrubbed. Press play and they vanished. Nothing about the caption was
 * wrong. The viewer does not re-render per frame during playback, a rAF loop
 * compares `activeTimelineSignature` and tells React the position only when
 * that string moves, and the signature named every clip on screen and no
 * caption. Over one long clip it never moved, so `position` stayed where
 * playback began and the drawn cue was whatever had been up at that one
 * frame. Usually nothing.
 *
 * No unit test can see this: every piece is individually right. So this drives
 * the real page, presses Play, and reads the words out of the DOM against the
 * clock's own timecode, which the controller writes 60 times a second and
 * which is therefore the frame the app actually believes it is on.
 *
 *   npm run dev                     in another terminal
 *   npm run prove:caption-playback
 *
 * It spends nothing: the cut is seeded into localStorage before the page's own
 * script runs, so no upload, no job and no API call happen at all.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { demoProject } from '../lib/fixtures/project.ts';
import { SESSION_KEY, toSnapshot } from '../lib/project/session.ts';
import { applyEdits } from '../lib/timeline/edits.ts';
import { captionAt } from '../lib/subtitles/place.ts';
import { frames, rateFps, type Frames } from '../lib/time/frames.ts';
import type { Caption, Timeline } from '../lib/timeline/types.ts';

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

/**
 * Cues over the head of the cut, laid so that the interesting ones arrive in
 * the MIDDLE of a clip rather than on a cut. A cue that starts where the
 * picture changes would have been re-rendered by the clip alone, which is
 * exactly how this defect stayed hidden for as long as it did.
 */
const CUES: { id: string; text: string; at: number; duration: number }[] = [
  { id: 'cap_1', text: 'the first line', at: 24, duration: 48 },
  { id: 'cap_2', text: 'the second line', at: 96, duration: 48 },
  { id: 'cap_3', text: 'the third line', at: 168, duration: 48 },
  { id: 'cap_4', text: 'the fourth line', at: 240, duration: 48 },
];

function seeded(): Timeline {
  const doc = demoProject();
  const caption = (c: typeof CUES[number]): Caption => ({
    id: c.id, kind: 'caption', text: c.text, duration: frames(c.duration), enabled: true,
  });
  return applyEdits(doc, [
    {
      op: 'add_track',
      at: 0,
      track: {
        id: 'trk_s1', kind: 'subtitle', name: 'Subtitles 1',
        locked: false, muted: false, solo: false, enabled: true, autoSelect: true,
      },
    },
    ...CUES.map((c) => ({
      op: 'add_caption' as const, trackId: 'trk_s1', caption: caption(c), at: frames(c.at),
    })),
  ]).timeline;
}

const TIMELINE = seeded();
const FPS = Math.round(rateFps(TIMELINE.rate));

/** "00:00:04:11" back to 107. Non-drop, which is what 24fps is. */
function parseTimecode(tc: string): number | null {
  const m = /^(\d+):(\d+):(\d+)[:;](\d+)$/.exec(tc.trim());
  if (!m) return null;
  const [, hh, mm, ss, ff] = m.map(Number) as unknown as number[];
  return ((hh * 60 + mm) * 60 + ss) * FPS + ff;
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9224;
const PROFILE = '/private/tmp/cutroom-caption-profile';
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
  '--disable-gpu', '--no-first-run', '--mute-audio',
  // deliberately wide. The caption box sizes itself against the FRAME, and a
  // wide window with a small viewer is what showed it sizing against neither.
  '--window-size=2560,1400',
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
  timeline: TIMELINE, project: null, dirty: true, pipelineId: null, playhead: 0,
}));
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem(${JSON.stringify(SESSION_KEY)}, ${JSON.stringify(snapshot)}); } catch (e) {}`,
});
await send('Page.reload');
await sleep(4000);

const laid = await evaluate<{ cues: number; clips: number }>(`({
  cues: document.querySelectorAll('[data-caption-id]').length,
  clips: document.querySelectorAll('[data-clip-id]').length,
})`);
// every assertion below is about which cue is on screen, and with no cues on
// the timeline every one of them passes by finding nothing
check('the seeded cues are on the timeline', laid.cues >= CUES.length && laid.clips > 0,
  `${laid.cues} cues, ${laid.clips} clips`);
if (laid.cues < CUES.length) { ws.close(); chrome.kill(); process.exit(1); }

/** What the screen says, in one read, so the two halves are one paint. */
const onScreen = () => evaluate<{ tc: string; cue: string | null; text: string | null }>(`(() => {
  const cap = document.querySelector('.cr-vcap');
  return {
    tc: document.querySelector('.cr-vtc')?.textContent ?? '',
    cue: cap ? cap.dataset.captionId ?? null : null,
    text: cap ? (cap.textContent ?? '').trim() : null,
  };
})()`);

// ── the caption box is measured against the frame, not the window ───────

const box = await evaluate<{ frameW: number; frameH: number; padLeft: number; padBottom: number; font: number }>(`(() => {
  const frame = document.querySelector('.cr-vframe');
  const cap = document.querySelector('.cr-vcap') ?? frame.appendChild(
    Object.assign(document.createElement('div'), { className: 'cr-vcap' }));
  const cs = getComputedStyle(cap);
  const span = cap.querySelector('span');
  return {
    frameW: frame.clientWidth,
    frameH: frame.clientHeight,
    padLeft: parseFloat(cs.paddingLeft),
    padBottom: parseFloat(cs.paddingBottom),
    font: span ? parseFloat(getComputedStyle(span).fontSize) : 0,
  };
})()`);
const wantPadLeft = box.frameW * 0.06;
const wantPadBottom = box.frameH * 0.04;
check(
  'the caption box is padded off the FRAME, not off the browser window',
  Math.abs(box.padLeft - wantPadLeft) < 1.5 && Math.abs(box.padBottom - wantPadBottom) < 1.5,
  `frame ${box.frameW}x${box.frameH}, padding ${box.padLeft.toFixed(1)}/${box.padBottom.toFixed(1)}px, `
  + `wanted ${wantPadLeft.toFixed(1)}/${wantPadBottom.toFixed(1)}px`,
);
check(
  'and there is room left for words',
  box.frameW - box.padLeft * 2 > box.frameW * 0.8,
  `${(box.frameW - box.padLeft * 2).toFixed(0)}px of ${box.frameW}px`,
);

// ── play, and watch ────────────────────────────────────────────────────

await evaluate(`document.querySelector('[aria-label="First frame"]').click()`);
await sleep(300);
const before = await onScreen();
check('nothing is on screen at the top of the cut', before.cue === null, `timecode ${before.tc}`);

await evaluate(`document.querySelector('[aria-label="Play"]').click()`);

const samples: { frame: number; cue: string | null; text: string | null; tc: string }[] = [];
for (let i = 0; i < 70; i++) {
  const s = await onScreen();
  const frame = parseTimecode(s.tc);
  if (frame !== null) samples.push({ frame, cue: s.cue, text: s.text, tc: s.tc });
  await sleep(180);
}
await evaluate(`document.querySelector('[aria-label="Stop"]').click()`);

const last = samples[samples.length - 1];
check('the clock actually ran', !!last && last.frame > 200, last ? `reached ${last.tc}` : 'no samples');

const seen = [...new Set(samples.map((s) => s.cue).filter(Boolean))] as string[];
/*
 * Every one of them, not "most". Run against the defect this passed at three
 * of four: the demo cut has a cut every couple of seconds, so three cues
 * happened to sit near one and were re-rendered into view by the picture
 * changing rather than by anything knowing they were there. A bar the bug
 * clears is not a bar.
 */
check(
  'every cue appeared while it was playing, not only where a cut happened to be',
  seen.length === CUES.length,
  `saw ${seen.length} of ${CUES.length}: ${seen.join(', ') || 'none'}`,
);
check(
  'and they arrived in the order they are written',
  seen.join(',') === CUES.slice(0, seen.length).map((c) => c.id).join(','),
  seen.join(',') || 'none',
);

/**
 * The real assertion: at the frame the CLOCK says it is on, the words on
 * screen are the words the document puts there.
 *
 * A tolerance of a few frames, and only backwards: the clock writes the
 * timecode itself every rAF, React repaints the caption one render behind it,
 * so the text can legitimately be up to a frame or two old. It can never be
 * from the future, and over a 48 frame cue a lag of 3 is not what "the
 * subtitles do not show" looked like.
 */
const LAG = 3;
const wrong = samples.filter((s) => {
  const want = new Set<string | null>();
  for (let d = 0; d <= LAG; d++) want.add(captionAt(TIMELINE, frames(Math.max(0, s.frame - d)) as Frames)?.id ?? null);
  return !want.has(s.cue);
});
check(
  'every sample shows the cue the document puts at that frame',
  wrong.length === 0 && samples.length > 20,
  wrong.length
    ? `${wrong.length}/${samples.length} wrong, first at ${wrong[0].tc}: screen ${wrong[0].cue ?? 'nothing'}, `
      + `document ${captionAt(TIMELINE, frames(wrong[0].frame) as Frames)?.id ?? 'nothing'}`
    : `${samples.length} samples`,
);

check('the page threw nothing', consoleErrors.length === 0, consoleErrors[0] ?? '');

ws.close();
chrome.kill();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
