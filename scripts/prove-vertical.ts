/**
 * A 16:9 cut delivered as a 9:16 reel, and the pixels read back out of it.
 *
 *   npm run prove:vertical
 *
 * This SPENDS, and it is small on purpose: one generated two second source,
 * two renders of one clip each, at 360x640. A few nodes of CPU work.
 *
 * It exists because `ffmpeg/transcode` takes a width and a height and the
 * catalogue does not say what it does when their shape is not its input's.
 * Letterbox, stretch and crop are all defensible readings and the schema
 * picks none. That never mattered while every export was 16:9 into 16:9,
 * where the three are the same answer. A reel is the first time they differ,
 * so the compiler stopped asking and sets the frame itself with a filter of
 * its own, and a filter of our own is exactly the kind of thing that
 * typechecks, unit tests green, and comes back `ffmpeg exited 234`.
 *
 * `npm run check:delivery` already says every destination compiles on both
 * sides. Compiling is not drawing. This is the half that looks at the file.
 *
 * What it checks, and why each one can fail on its own:
 *
 *  - the delivered file is 360x640. A stretch would also be 360x640, so this
 *    alone proves only that the frame reached the encoder.
 *  - contain leaves the top of the frame black, because a 16:9 picture
 *    centred in a 9:16 frame cannot reach it.
 *  - cover does NOT, because the picture is scaled until it fills the frame
 *    and the sides are cut off instead.
 *
 * The last two are the pair. Either one alone passes on a stretched picture:
 * a stretch has no bars, so it looks exactly like cover, and the only thing
 * that tells them apart is that contain, on the same source, has them.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

import { exportTimeline } from '../lib/export/render.ts';
import { serverTransport } from '../lib/export/transport.server.ts';
import { emptyTimeline } from '../lib/timeline/document.ts';
import { RATES, frames, timeRange, type Frames } from '../lib/time/frames.ts';
import type { Clip, Timeline } from '../lib/timeline/types.ts';
import type { DeliverySpec, FrameFit } from '../lib/compiler/types.ts';

const OUT = '/private/tmp/cutroom-vertical';
const RATE = RATES.film;
const F = (n: number): Frames => frames(n);

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const i = line.indexOf('=');
  if (i < 0 || line.trim().startsWith('#')) continue;
  const k = line.slice(0, i).trim();
  if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}
const BASE = process.env.EDITOR_API_URL as string;
const KEY = process.env.EDITOR_API_KEY as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep the text */ }
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(body).slice(0, 400)}`);
  return body as T;
}

interface Job { status: string; outputs?: { key: string; role?: string }[]; result?: unknown; error?: unknown }

/** One operation, waited out. An operation is a JOB, at /v1/jobs/{id}. */
async function operation(engine: string, op: string, params: unknown): Promise<Job> {
  const started = await api<{ id?: string; jobId?: string }>(`/v1/${engine}/${op}`, {
    method: 'POST', body: JSON.stringify(params),
  });
  const id = started.id ?? started.jobId;
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    const j = await api<Job>(`/v1/jobs/${id}`);
    if (['succeeded', 'done', 'completed'].includes(j.status)) return j;
    if (['failed', 'error', 'cancelled'].includes(j.status)) {
      throw new Error(`${engine}/${op} ${j.status}: ${JSON.stringify(j.error).slice(0, 300)}`);
    }
  }
  throw new Error(`${engine}/${op} never finished`);
}

const outputOf = (j: Job): string => {
  const out = j.outputs?.find((o) => o.role !== 'poster') ?? j.outputs?.[0];
  if (!out) throw new Error('succeeded with no output');
  return out.key;
};

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

/**
 * How black the top strip of the delivered frame is.
 *
 * A still is extracted, the top 40 rows are cropped out of it, and that strip
 * is compared with a black rectangle of the same size. `imagemagick/compare`
 * answers 0 for two identical images. Do NOT read the number against the 0.02
 * in compare's own summary, which is a sentence about photographs.
 */
async function topStripDifference(key: string): Promise<number> {
  const still = outputOf(await operation('ffmpeg', 'thumbnail',
    { input: key, count: 1, atSec: 1, format: 'png', tier: 'cpu' }));
  const strip = outputOf(await operation('imagemagick', 'crop',
    { input: still, width: 360, height: 40, gravity: 'north', format: 'png', tier: 'cpu' }));
  const black = outputOf(await operation('ffmpeg', 'custom', {
    args: ['-f', 'lavfi', '-i', 'color=c=black:s=360x40', '-frames:v', '1', '{out}'],
    output: 'black-strip.png', tier: 'cpu',
  }));
  const j = await operation('imagemagick', 'compare', { a: strip, b: black, tier: 'cpu' });
  const r = j.result as { difference?: number } | undefined;
  if (typeof r?.difference !== 'number') throw new Error(`compare answered ${JSON.stringify(j.result)}`);
  return r.difference;
}

/** Two identical images answer exactly 0, so anything this side of it is black. */
const IS_BLACK = 0.0005;
/** Every real difference measured in this repo has been well above this. */
const IS_PICTURE = 0.007;

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`base: ${BASE}\nout:  ${OUT}\n`);

  // a 16:9 source whose every row carries picture, so a bar at the top of the
  // delivery can only have been put there by the fit
  console.log('generating one 640x360 source');
  const source = outputOf(await operation('ffmpeg', 'custom', {
    args: ['-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=24:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '{out}'],
    output: 'vert-src.mp4', tier: 'cpu',
  }));
  console.log(`  ${source}\n`);

  const clip: Clip = {
    id: 'c1', kind: 'clip', name: 'bars', mediaKey: 'src',
    sourceRange: timeRange(F(0), F(48)), enabled: true, effects: [],
  };

  for (const fit of ['contain', 'cover'] as FrameFit[]) {
    const t: Timeline = emptyTimeline(`tl_vert_${fit}`, `Vertical ${fit}`, RATE);
    t.media.src = { key: source, name: 'bars', kind: 'video', available: timeRange(F(0), F(48)) };
    const V1 = t.tracks.find((x) => x.kind === 'video' && x.name === 'Video 1');
    if (!V1) throw new Error('the empty timeline has no Video 1');
    V1.items.push(clip);

    const delivery: DeliverySpec = {
      width: 360, height: 640, container: 'mp4',
      videoCodec: 'h264', videoBitrate: '2M', audioBitrate: '128k',
      reencode: true, fit,
    };

    console.log(`\nrendering 640x360 into 360x640, fit=${fit}`);
    const result = await exportTimeline(t, { delivery, name: `Cutroom vertical ${fit}` },
      serverTransport(), (e) => console.log(`  [${e.phase}] ${e.message}`));
    console.log(`  key ${result.key}`);

    const res = await fetch(result.url);
    if (res.ok) writeFileSync(`${OUT}/${fit}.mp4`, Buffer.from(await res.arrayBuffer()));

    const probe = await operation('ffmpeg', 'probe', { input: result.key });
    const streams = (probe.result as { streams?: { codec_type: string; width?: number; height?: number }[] })
      ?.streams ?? [];
    const v = streams.find((s) => s.codec_type === 'video');
    check(
      `${fit}: the delivered frame is 360x640`,
      v?.width === 360 && v?.height === 640,
      `${v?.width}x${v?.height}`,
    );

    const diff = await topStripDifference(result.key);
    if (fit === 'contain') {
      check(
        'contain: the top of the frame is black, because 16:9 cannot reach it',
        diff <= IS_BLACK,
        `difference from black ${diff}`,
      );
    } else {
      check(
        'cover: the top of the frame is picture, because the frame is filled',
        diff >= IS_PICTURE,
        `difference from black ${diff}`,
      );
    }
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  console.log(`files: ${OUT}/contain.mp4, ${OUT}/cover.mp4\n`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
