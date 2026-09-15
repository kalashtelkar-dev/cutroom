/**
 * Do the document's captions reach the rendered file?
 *
 * The first attempt at this burned each cue as a gated `drawtext` filter,
 * the way a layer is gated. ffmpeg refused every combination: `%` is
 * expansion syntax, `:` separates options, and probing the live API one
 * character at a time showed there is no escaping that satisfies all of them
 * at once. A unit test could not have told me that; only ffmpeg could, and
 * `exited 234` was the whole of its opinion.
 *
 * So the cues are written to an SRT and burned with libass, which handles
 * every character, multi-line cues and hundreds of them. This renders that
 * path with a cue full of the characters that broke the other one, and reads
 * the pixels back at four moments.
 *
 *   npm run prove:captions
 *
 * It SPENDS: one synthetic source, one upload, one burn, four frame grabs.
 */
import { readFileSync } from 'node:fs';
import { RATES, frames } from '../lib/time/frames.ts';
import { toSrt } from '../lib/subtitles/srt.ts';

const env = readFileSync('.env.local', 'utf8');
const KEY = env.match(/^EDITOR_API_KEY=(.*)$/m)![1].trim();
const URL_ = env.match(/^EDITOR_API_URL=(.*)$/m)![1].trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${URL_}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body as T;
}

async function run(engine: string, operation: string, params: Record<string, unknown>) {
  const started = await api<{ id?: string }>(`/v1/${engine}/${operation}`, {
    method: 'POST', body: JSON.stringify(params),
  });
  if (!started.id) return started as Record<string, unknown>;
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    const j = await api<{ status: string; result?: Record<string, unknown>; error?: unknown }>(`/v1/jobs/${started.id}`);
    if (['succeeded', 'done', 'completed'].includes(j.status)) return j.result ?? {};
    if (['failed', 'error'].includes(j.status)) {
      throw new Error(`${engine}/${operation}: ${JSON.stringify(j.error).slice(0, 300)}`);
    }
  }
  throw new Error(`${engine}/${operation} never finished`);
}

const outputs = (r: Record<string, unknown>) => (r.outputs ?? []) as { key: string }[];

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const R = RATES.film;
console.log(`base: ${URL_}\n`);

/**
 * Cues exactly as the document holds them, written out by the real
 * serialiser. If `toSrt` ever produces something libass will not read, this
 * is where it shows.
 */
const CUES = [
  { start: frames(24), duration: frames(24), text: 'FIRST CUE' },
  { start: frames(72), duration: frames(24), text: "IT'S 50%: A,B [OK]" },
  { start: frames(120), duration: frames(24), text: 'THIRD LINE\nover two rows' },
];
const srt = toSrt(CUES, R);

console.log('uploading the caption file the document wrote');
const presigned = await api<{ url: string; key: string }>('/v1/uploads', {
  method: 'POST', body: JSON.stringify({ filename: 'captions.srt' }),
});
// the URL signs `host` alone: any header here breaks the signature
const put = await fetch(presigned.url, { method: 'PUT', body: srt });
check('the caption file uploads', put.ok, `PUT ${put.status}`);
if (!put.ok) process.exit(1);

console.log('making a 6s black source, so any bright pixel is a caption');
const src = outputs(await run('ffmpeg', 'synthetic', {
  pattern: 'color', color: 'black', width: 640, height: 360, fps: 24,
  durationSec: 6, audio: false, container: 'mp4', videoCodec: 'h264',
}))[0].key;

console.log('burning them in\n');
let burned = '';
try {
  burned = outputs(await run('ffmpeg', 'custom', {
    input: [src, presigned.key],
    args: ['-i', '{in0}', '-i', '{in1}', '-vf', 'subtitles={in1}', '-an', '{out}'],
    output: 'captioned.mp4',
    tier: 'cpu',
  }))[0].key;
  check('the burn completes, awkward characters and all', true);
} catch (e) {
  check('the burn completes, awkward characters and all', false, (e as Error).message.slice(0, 200));
  process.exit(1);
}

/**
 * How many bytes a still of one moment compresses to.
 *
 * Crude on purpose, and enough: over pure black, text is the only thing that
 * can add bytes. An earlier version of this script checked only the exit
 * status and reported a filter that drew the wrong text as a pass.
 */
async function bytesAt(key: string, atSec: number): Promise<number> {
  const still = outputs(await run('ffmpeg', 'thumbnail', { input: key, atSec, count: 1, width: 320 }));
  if (!still.length) throw new Error(`no still came back at ${atSec}s`);
  const signed = await api<{ urls?: Record<string, string> }>('/v1/outputs/sign', {
    method: 'POST', body: JSON.stringify({ keys: [still[0].key] }),
  });
  const url = (signed.urls ?? {})[still[0].key];
  if (!url) throw new Error('the still would not sign');
  return new Uint8Array(await (await fetch(url)).arrayBuffer()).length;
}

console.log('\nreading the picture back at four moments\n');
const empty = await bytesAt(burned, 0.5);
const first = await bytesAt(burned, 1.5);
const awkward = await bytesAt(burned, 3.5);
const gap = await bytesAt(burned, 4.5);
console.log(`   empty ${empty}B · cue 1 ${first}B · awkward cue ${awkward}B · gap ${gap}B\n`);

check('a cue puts words on an empty frame', first > empty * 1.15, `${first} vs ${empty}`);
check("an apostrophe, a percent, a colon, a comma and brackets all draw", awkward > empty * 1.15, `${awkward} vs ${empty}`);
check('a moment between cues is empty again', Math.abs(gap - empty) < empty * 0.2, `${gap} vs ${empty}`);

const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} passed\n`);
process.exit(failed.length ? 1 : 0);
