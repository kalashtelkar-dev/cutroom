/**
 * What `ffmpeg/concat` will actually join.
 *
 * The render died at "ffmpeg exited 234" with no diagnostics, and 234 is
 * 256 - 22: ffmpeg's EINVAL. Reading the node's schema cannot explain it,
 * because the schema takes every one of these parameter sets happily. So this
 * runs the real node over the real shapes the compiler builds, and prints the
 * table it should have been written against in the first place.
 *
 *   npm run prove:concat
 *
 * Measured, on the live API:
 *
 *   | inputs                          | reencode | result |
 *   |---------------------------------|----------|--------|
 *   | audio only, matching codecs     | false    | joins  |
 *   | audio only                      | true     | 234    |
 *   | video only, matching shape      | false    | joins  |
 *   | video only                      | true     | 234    |
 *   | video+audio, one size           | true     | joins  |
 *   | video+audio, two sizes          | true     | 234    |
 *
 * Which is one rule: the node joins its inputs AS THEY ARE. It does not
 * scale a picture to meet another one and it does not put a silent track on
 * a file that has none. `reencode: true` re-encodes what is already
 * compatible and additionally insists that every input carry both a picture
 * and a sound, so it is strictly the fussier of the two paths and the
 * compiler now never uses it. Everything is matched first and joined by the
 * demuxer.
 *
 * This SPENDS, but only small cpu jobs. It exits non-zero if any of the
 * measurements above has changed, because the compiler is built on them.
 */
import { readFileSync } from 'node:fs';

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

interface Outcome { ok: boolean; key?: string; error?: string; result?: unknown }

/** One operation, waited out. An operation is a JOB, at /v1/jobs/{id}. */
async function attempt(engine: string, op: string, params: unknown): Promise<Outcome> {
  let started: { id?: string; jobId?: string };
  try {
    started = await api(`/v1/${engine}/${op}`, { method: 'POST', body: JSON.stringify(params) });
  } catch (e) {
    return { ok: false, error: `rejected before it ran: ${(e as Error).message}` };
  }
  const id = started.id ?? started.jobId;
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    const j = await api<{ status: string; outputs?: { key: string; role?: string }[]; error?: unknown; result?: unknown }>(
      `/v1/jobs/${id}`);
    if (['succeeded', 'done', 'completed'].includes(j.status)) {
      const out = j.outputs?.find((o) => o.role !== 'poster') ?? j.outputs?.[0];
      return { ok: true, key: out?.key, result: j.result };
    }
    if (['failed', 'error', 'cancelled'].includes(j.status)) {
      return { ok: false, error: `${j.status}: ${JSON.stringify(j.error).slice(0, 200)}` };
    }
  }
  return { ok: false, error: 'never finished' };
}

async function must(engine: string, op: string, params: unknown): Promise<string> {
  const r = await attempt(engine, op, params);
  if (!r.ok || !r.key) throw new Error(`${engine}/${op} failed: ${r.error}`);
  return r.key;
}

async function videoFrames(key: string): Promise<number> {
  const r = await attempt('ffmpeg', 'probe', { input: key });
  const streams = (r.result as { streams?: { codec_type: string; nb_frames?: string }[] })?.streams;
  return Number(streams?.find((s) => s.codec_type === 'video')?.nb_frames ?? 0);
}

const W = 640, H = 360, FPS = 24;

/** Exactly the args `matchForJoin` emits for a picture segment. */
const fit = (input: string, frames: number, label: string) => must('ffmpeg', 'custom', {
  input,
  args: [
    '-i', '{in0}',
    '-filter_complex',
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,`
    + `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},`
    + 'tpad=stop_mode=clone:stop_duration=1,format=yuv420p[v]',
    '-map', '[v]', '-an',
    '-frames:v', String(frames),
    '-c:v', '{enc:h264}', '-pix_fmt', 'yuv420p',
    '-video_track_timescale', String(FPS * 1000),
    '{out}',
  ],
  output: `${label}.mp4`, tier: 'cpu',
});

const results: { name: string; want: boolean; got: boolean; detail: string }[] = [];

async function check(name: string, want: boolean, inputs: string[], reencode: boolean) {
  const r = await attempt('ffmpeg', 'concat', {
    inputs, reencode, container: 'mp4', ...(reencode ? { videoCodec: 'h264' } : {}), tier: 'cpu',
  });
  const line = `${r.ok ? 'joins' : '234  '}  ${name}`;
  console.log(`  ${line}${r.ok ? '' : `  (${r.error})`}`);
  results.push({ name, want, got: r.ok, detail: r.ok ? (r.key ?? '') : (r.error ?? '') });
  return r;
}

async function main() {
  console.log(`base: ${BASE}\n`);

  console.log('building the shapes the compiler actually feeds a join');
  const [silence, withSound, blackNoSound, bigWithSound] = await Promise.all([
    // compile.ts silence()
    must('ffmpeg', 'custom', {
      args: ['-f', 'lavfi', '-t', '1', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
             '-c:a', 'aac', '-b:a', '192k', '{out}'],
      output: 'silence.m4a', tier: 'cpu',
    }),
    // a source clip: picture AND sound, at its own size, not the delivery's
    must('ffmpeg', 'custom', {
      args: ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=3',
             '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
             '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '{out}'],
      output: 'cc-src.mp4', tier: 'cpu',
    }),
    // compile.ts black(): the delivery size, and audio: false
    must('ffmpeg', 'synthetic', {
      pattern: 'color', color: 'black', width: W, height: H, fps: FPS,
      durationSec: 1, audio: false, container: 'mp4', videoCodec: 'h264', tier: 'cpu',
    }),
    must('ffmpeg', 'synthetic', {
      pattern: 'testsrc', width: 1920, height: 1080, fps: FPS,
      durationSec: 1, audio: true, container: 'mp4', videoCodec: 'h264', tier: 'cpu',
    }),
  ]);
  // compile.ts audioSegments(): the sound of a picture clip
  const extracted = await must('ffmpeg', 'extract-audio', {
    input: withSound, codec: 'aac', bitrate: '192k', sampleRate: '48000', channels: '2', tier: 'cpu',
  });

  console.log('\nsound, which is what the export died on first');
  await check('audio only, reencode (what the compiler used to send)', false, [silence, extracted], true);
  await check('audio only, demuxer', true, [silence, extracted], false);

  console.log('\npicture');
  await check('a cut beside generated black, reencode', false, [withSound, blackNoSound], true);
  await check('two sizes that both carry sound, reencode', false, [withSound, bigWithSound], true);

  console.log('\npicture, brought to one shape first, which is what the compiler does now');
  const [a, b] = await Promise.all([fit(withSound, 72, 'f-cut'), fit(blackNoSound, 24, 'f-black')]);
  const [fa, fb] = await Promise.all([videoFrames(a), videoFrames(b)]);
  console.log(`  the fit returns exactly what it is asked for: ${fa} and ${fb} frames (72, 24)`);
  const joined = await check('matched segments, demuxer', true, [a, b], false);

  let exact = true;
  if (joined.ok && joined.key) {
    const total = await videoFrames(joined.key);
    exact = total === 96;
    console.log(`  the join is the sum and not one frame more: ${total} frames (96)`);
  }

  console.log('\n── measured ────────────────────────────────────────────────');
  const moved = results.filter((r) => r.got !== r.want);
  for (const r of results) {
    console.log(`${r.got === r.want ? '  as documented' : '  CHANGED      '}  ${r.name}`);
  }
  if (fa !== 72 || fb !== 24 || !exact) {
    console.log('\nThe fit no longer returns an exact frame count. Every cut after a');
    console.log('gap moves when that happens, so this is not a rounding problem.');
    process.exit(1);
  }
  if (moved.length) {
    console.log(`\n${moved.length} measurement(s) changed. lib/compiler/compile.ts is built on this`);
    console.log('table, so read joinTrack and matchForJoin before trusting either.');
    process.exit(1);
  }
  console.log('\nEvery measurement still holds. The compiler matches, then joins.');
}

main().catch((e) => { console.error(e); process.exit(1); });
