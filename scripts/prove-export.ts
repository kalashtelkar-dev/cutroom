/**
 * Prove the export works, against the live API, with real media.
 *
 * This SPENDS. It generates two source clips, builds a timeline with a cut
 * from each plus a music bed, compiles it, creates and publishes a pipeline,
 * runs it, and downloads the result. Then it probes the file and checks the
 * frame count is EXACTLY the sum of the clip durations, because that is the
 * one claim the whole integer-frame model rests on.
 *
 *   npm run prove:export
 *
 * A unit test cannot do this. The compiler had nine wrong assumptions about
 * this API and every one of them survived a green suite.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { exportTimeline } from '../lib/export/render.ts';
import { serverTransport } from '../lib/export/transport.server.ts';
import { emptyTimeline } from '../lib/timeline/document.ts';
import { RATES, frames, timeRange, type Frames } from '../lib/time/frames.ts';
import type { Clip, Gap, Timeline } from '../lib/timeline/types.ts';
import type { DeliverySpec } from '../lib/compiler/types.ts';

const OUT = '/private/tmp/cutroom-export';
const RATE = RATES.film;            // 24fps, so a frame is exactly 1/24s
const F = (n: number): Frames => frames(n);

// ── env, the same file the app reads ────────────────────────────────────
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

/** One operation, waited out. An operation is a JOB, at /v1/jobs/{id}. */
async function operation(engine: string, op: string, params: unknown): Promise<string> {
  const started = await api<{ id?: string; jobId?: string }>(`/v1/${engine}/${op}`, {
    method: 'POST', body: JSON.stringify(params),
  });
  const id = started.id ?? started.jobId;
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    const j = await api<{ status: string; outputs?: { key: string; role?: string }[]; error?: unknown }>(
      `/v1/jobs/${id}`);
    if (['succeeded', 'done', 'completed'].includes(j.status)) {
      const out = j.outputs?.find((o) => o.role !== 'poster') ?? j.outputs?.[0];
      if (!out) throw new Error(`${engine}/${op} succeeded with no output`);
      return out.key;
    }
    if (['failed', 'error', 'cancelled'].includes(j.status)) {
      throw new Error(`${engine}/${op} ${j.status}: ${JSON.stringify(j.error).slice(0, 300)}`);
    }
  }
  throw new Error(`${engine}/${op} never finished`);
}

const clip = (id: string, mediaKey: string, start: number, duration: number): Clip => ({
  id, kind: 'clip', name: id, mediaKey,
  sourceRange: timeRange(F(start), F(duration)),
  enabled: true, effects: [],
});

const gap = (id: string, duration: number): Gap => ({ id, kind: 'gap', duration: F(duration) });

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`base: ${BASE}\nout:  ${OUT}\n`);

  // ── 1. source media, so this depends on no file I do not have ────────
  console.log('generating two picture sources and a music bed');
  const [a, b, music] = await Promise.all([
    operation('ffmpeg', 'custom', {
      args: ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=8',
             '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
             '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '{out}'],
      output: 'ex-a.mp4', tier: 'cpu',
    }),
    operation('ffmpeg', 'custom', {
      args: ['-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=24:duration=8',
             '-f', 'lavfi', '-i', 'sine=frequency=660:duration=8',
             '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '{out}'],
      output: 'ex-b.mp4', tier: 'cpu',
    }),
    operation('ffmpeg', 'custom', {
      args: ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=8',
             '-c:a', 'aac', '{out}'],
      output: 'ex-music.m4a', tier: 'cpu',
    }),
  ]);
  console.log(`  a     ${a}\n  b     ${b}\n  music ${music}\n`);

  // ── 2. a timeline anyone would recognise: two cuts over a bed ────────
  const t: Timeline = emptyTimeline('tl_prove', 'Export proof', RATE);
  t.media.a = { key: a, name: 'source a', kind: 'video', available: timeRange(F(0), F(192)) };
  t.media.b = { key: b, name: 'source b', kind: 'video', available: timeRange(F(0), F(192)) };
  t.media.m = { key: music, name: 'music bed', kind: 'audio', available: timeRange(F(0), F(192)) };

  const V2 = t.tracks.find((x) => x.kind === 'video' && x.name === 'Video 2');
  const V1 = t.tracks.find((x) => x.kind === 'video' && x.name === 'Video 1');
  const A3 = t.tracks.find((x) => x.kind === 'audio' && x.name === 'Music');
  if (!V1 || !V2 || !A3) throw new Error('the empty timeline does not have the tracks this expects');

  /**
   * The gaps are the point.
   *
   * Without them this timeline is two cuts of the same size, both carrying
   * sound, and `ffmpeg/concat` joins those happily. It is the mixture that it
   * refuses: a cut beside generated black, which is a different size with no
   * sound on it, and a music clip beside generated silence, which has no
   * picture at all. That is what a real edit looks like the moment anything is
   * moved, and it is what the export died on while this script was passing.
   *
   * 72 + 24 + 48 = 144 frames, which is 6.0s at 24fps exactly.
   */
  V1.items.push(clip('c1', 'a', F(24), F(72)), gap('hole', 24), clip('c2', 'b', F(12), F(48)));
  // the sound starts late, as it does the moment someone unlinks it and slides
  // it, which leaves silence to be joined onto the head of the track
  A3.items.push(gap('late', 24), clip('m1', 'm', F(0), F(120)));

  // and a layer over it, screened at 60%, so the render exercises the blend
  // path rather than only the cheap compose one
  const over = clip('c3', 'b', F(0), F(144));
  over.effects = [{ kind: 'cutroom/composite', params: { mode: 'screen', opacity: 0.6 }, enabled: true }];
  V2.items.push(over);
  const EXPECT_FRAMES = 144;

  const delivery: DeliverySpec = {
    width: 640, height: 360, container: 'mp4',
    videoCodec: 'h264', videoBitrate: '2M', audioBitrate: '128k',
    reencode: true,
  };

  // ── 3. the export, the same code path the button runs ────────────────
  console.log('exporting');
  const result = await exportTimeline(t, { delivery, name: 'Cutroom export proof' }, serverTransport(),
    (e) => console.log(`  [${e.phase}] ${e.message}`));

  console.log(`\n  pipeline ${result.pipelineId}\n  run      ${result.runId}\n  key      ${result.key}`);
  for (const w of result.warnings) console.log(`  warn     ${w.code}: ${w.message}`);

  // ── 4. download it, and check it is what the timeline said ───────────
  const res = await fetch(result.url);
  if (!res.ok) throw new Error(`downloading the render answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(`${OUT}/export.mp4`, bytes);
  console.log(`\nWROTE ${OUT}/export.mp4  (${bytes.length} bytes)`);

  const probed = await api<{ format?: { duration?: string }; streams?: { codec_type: string; nb_frames?: string; codec_name?: string }[] }>(
    '/v1/ffmpeg/probe', { method: 'POST', body: JSON.stringify({ input: result.key }) });
  const job = await (async () => {
    const id = (probed as { id?: string }).id;
    if (!id) return probed;
    for (let i = 0; i < 60; i++) {
      await sleep(1500);
      const j = await api<{ status: string; result?: unknown }>(`/v1/jobs/${id}`);
      if (['succeeded', 'done', 'completed'].includes(j.status)) return j.result ?? j;
      if (['failed', 'error'].includes(j.status)) throw new Error('probe failed');
    }
    throw new Error('probe never finished');
  })();

  console.log('\nprobe:', JSON.stringify(job).slice(0, 700));

  const video = (job as { streams?: { codec_type: string; nb_frames?: string }[] })
    .streams?.find((s) => s.codec_type === 'video');
  const got = Number(video?.nb_frames ?? 0);
  if (got === EXPECT_FRAMES) {
    console.log(`\nFRAME COUNT EXACT: ${got} frames, which is ${EXPECT_FRAMES / 24}s at 24fps with zero drift.\n`);
  } else {
    console.log(`\nFRAME COUNT ${got}, expected ${EXPECT_FRAMES}. That is a real discrepancy, not rounding.\n`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
