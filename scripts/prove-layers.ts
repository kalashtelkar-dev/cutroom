/**
 * Whether a gap in an upper picture track really lets the track below show.
 *
 * The export dialog used to say: "the gaps in Video 2 show as black over the
 * track below, because ffmpeg/compose has no transparency". That is true of
 * compose and it was true of the render, and neither a typecheck nor a unit
 * test can tell you whether the replacement works, because the question is
 * what colour a pixel is in a file a GPU wrote.
 *
 *   npm run prove:layers
 *
 * So this builds the exact two strips the compiler builds, a red base and an
 * upper track that is blue for two seconds and then black for four, feeds
 * them the exact `ffmpeg/custom` args `layerOver` emits, and then reads a
 * pixel out of the result at two moments:
 *
 *   | at  | ungated (what shipped) | gated (what compiles now) |
 *   |-----|------------------------|---------------------------|
 *   | 1s  | blue                   | blue                      |
 *   | 4s  | BLACK, the bug         | red, the track below      |
 *
 * The ungated column is measured too, on purpose. A check that only ever
 * looks at the fixed path cannot tell you it is measuring anything at all.
 *
 * This SPENDS, but only small cpu jobs. It exits non-zero if any square of
 * that table moves, because lib/compiler/compile.ts is built on it.
 */
import { readFileSync } from 'node:fs';
import { HOLD_LAST } from '../lib/compiler/compile.ts';
import { inflateSync } from 'node:zlib';

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

interface Outcome { ok: boolean; key?: string; error?: string }

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
    const j = await api<{ status: string; outputs?: { key: string; role?: string }[]; error?: unknown }>(
      `/v1/jobs/${id}`);
    if (['succeeded', 'done', 'completed'].includes(j.status)) {
      const out = j.outputs?.find((o) => o.role !== 'poster') ?? j.outputs?.[0];
      return { ok: true, key: out?.key };
    }
    if (['failed', 'error', 'cancelled'].includes(j.status)) {
      return { ok: false, error: `${j.status}: ${JSON.stringify(j.error).slice(0, 300)}` };
    }
  }
  return { ok: false, error: 'never finished' };
}

async function must(engine: string, op: string, params: unknown): Promise<string> {
  const r = await attempt(engine, op, params);
  if (!r.ok || !r.key) throw new Error(`${engine}/${op} failed: ${r.error}`);
  return r.key;
}

// ── reading a pixel back ────────────────────────────────────────────────

/**
 * The colour of a 1x1 PNG, without a decoder.
 *
 * Every PNG filter type reduces to the raw byte when the image is one pixel
 * wide and one row tall: there is no pixel to the left and no row above, so
 * Sub, Up, Average and Paeth all add zero. So the scanline is the filter byte
 * followed by the sample, whatever the encoder chose.
 */
function pixelOf(png: Buffer): [number, number, number] {
  let at = 8; // the signature
  let colourType = -1;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') colourType = data[9];
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    at += 12 + length;
  }
  if (!idat.length) throw new Error('that is not a PNG, or it holds no image data');
  if (colourType !== 2 && colourType !== 6) {
    throw new Error(`colour type ${colourType} is not rgb, so the samples are not where this reads them`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < 4) throw new Error(`a ${raw.length} byte scanline is not one rgb pixel`);
  return [raw[1], raw[2], raw[3]];
}

/** The colour of one frame of a rendered file, at a given moment. */
async function colourAt(key: string, seconds: number, label: string): Promise<[number, number, number]> {
  // scale to a single pixel: the strips are flat colour, so the average IS
  // the colour, and one pixel is a PNG small enough to read by hand
  const shot = await must('ffmpeg', 'custom', {
    input: key,
    args: [
      '-ss', String(seconds), '-i', '{in0}',
      '-frames:v', '1', '-vf', 'scale=1:1', '{out}',
    ],
    output: `${label}.png`,
    tier: 'cpu',
  });
  const signed = await api<{ urls: Record<string, string> }>(
    '/v1/outputs/sign', { method: 'POST', body: JSON.stringify({ keys: [shot] }) });
  const url = signed.urls[shot];
  if (!url) throw new Error(`nothing signed for ${shot}: ${JSON.stringify(signed.urls)}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching the frame`);
  return pixelOf(Buffer.from(await res.arrayBuffer()));
}

/**
 * The colour of ONE point of a frame.
 *
 * `colourAt` averages the whole picture, which is the colour only while the
 * picture is one flat colour. A placed layer is deliberately not: the point of
 * it is that the middle of the frame and the corner of it differ, and an
 * average of the two would read as neither.
 */
async function pointAt(
  key: string, seconds: number, x: number, y: number, label: string,
): Promise<[number, number, number]> {
  const shot = await must('ffmpeg', 'custom', {
    input: key,
    args: [
      '-ss', String(seconds), '-i', '{in0}',
      '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},scale=1:1`, '{out}',
    ],
    output: `${label}.png`,
    tier: 'cpu',
  });
  const signed = await api<{ urls: Record<string, string> }>(
    '/v1/outputs/sign', { method: 'POST', body: JSON.stringify({ keys: [shot] }) });
  const url = signed.urls[shot];
  if (!url) throw new Error(`nothing signed for ${shot}: ${JSON.stringify(signed.urls)}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching the frame`);
  return pixelOf(Buffer.from(await res.arrayBuffer()));
}

/** Which of the three colours in play this pixel is, if any. */
function name([r, g, b]: [number, number, number]): string {
  const near = (v: number, want: number) => Math.abs(v - want) <= 40;
  if (near(r, 0) && near(g, 0) && near(b, 0)) return 'black';
  if (r > 120 && near(g, 0) && near(b, 0)) return 'red';
  if (near(r, 0) && near(g, 0) && b > 120) return 'blue';
  // blue over red: half opacity gives half of each, screen gives both at full.
  // Half and half is the narrower of the two and therefore tested first: 128
  // is above the 120 the magenta test asks for, and would answer to it.
  if (near(r, 128) && near(g, 0) && near(b, 128)) return 'half and half';
  if (r > 120 && near(g, 0) && b > 120) return 'magenta';
  return `rgb(${r},${g},${b})`;
}

// ── the strips the compiler builds ──────────────────────────────────────

const W = 640, H = 360, FPS = 24;
const TOP_FRAMES = 48; // two seconds of picture, then four seconds of gap

/** Exactly the fit `layerOver` puts on both of its inputs. */
const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,`
  + `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},format=yuv420p`;

/** Exactly the expression `gateExpression` writes for one visible run. */
const gate = `:enable='between(t,0,${Math.round(((TOP_FRAMES - 0.5) / FPS) * 1e6) / 1e6})'`;

/**
 * Exactly what `placement()` writes for a layer scaled to half the frame and
 * moved a quarter of the frame to the right.
 *
 *   zoom 0.5 of 640x360   is a 320x180 box to fit the picture inside
 *   x = (W-w)/2+160       is 320, so the picture covers x 320..640, y 90..270
 *
 * The compiler is held to this shape, character for character, by
 * test/compiler.test.ts. Change one and change the other.
 */
const PLACE_W = 320, PLACE_H = 180, PLACE_DX = 160;
const placedFit = (format: string) =>
  `scale=${PLACE_W}:${PLACE_H}:force_original_aspect_ratio=decrease:force_divisible_by=2,`
  + `setsar=1,fps=${FPS},format=${format}`;
const PLACE_AT = `x=(W-w)/2+${PLACE_DX}:y=(H-h)/2`;

/** Inside the placed picture, and two places outside it. */
const INSIDE: [number, number] = [450, 180];
const LEFT_OF: [number, number] = [100, 180];
const ABOVE: [number, number] = [450, 40];

const layer = (base: string, top: string, filter: string, label: string) => attempt('ffmpeg', 'custom', {
  args: [
    '-i', '{in0}', '-i', '{in1}',
    '-filter_complex', filter,
    '-map', '[v]', '-an',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '{out}',
  ],
  output: `${label}.mp4`,
  tier: 'cpu',
  input: [base, top],
});

const measured: { at: string; want: string; got: string }[] = [];

function record(at: string, want: string, got: string, rgb?: [number, number, number]): void {
  // the samples are named to be read, and the numbers kept because a name is
  // a judgement: the first run of this called rgb(128,0,128) magenta
  const raw = rgb ? ` = rgb(${rgb.join(',')})` : '';
  console.log(`  ${got === want ? '  as documented' : '  CHANGED      '}  ${at}: ${got}${raw} (${want})`);
  measured.push({ at, want, got });
}

async function main() {
  console.log(`base: ${BASE}\n`);
  console.log('building the two strips a gapped overlay track compiles to');

  const [base, top] = await Promise.all([
    // the track below: red for the whole six seconds
    must('ffmpeg', 'custom', {
      args: ['-f', 'lavfi', '-t', '6', '-i', `color=c=red:s=${W}x${H}:r=${FPS}`,
             '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '{out}'],
      output: 'layers-base.mp4', tier: 'cpu',
    }),
    // the track above: two seconds of blue, then four seconds of the black
    // that joinTrack fills a gap with
    must('ffmpeg', 'custom', {
      args: ['-f', 'lavfi', '-t', '2', '-i', `color=c=blue:s=${W}x${H}:r=${FPS}`,
             '-f', 'lavfi', '-t', '4', '-i', `color=c=black:s=${W}x${H}:r=${FPS}`,
             '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
             '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '{out}'],
      output: 'layers-top.mp4', tier: 'cpu',
    }),
  ]);

  console.log('\nlaying one over the other, ungated and gated');
  const [plain, gated] = await Promise.all([
    layer(base, top, `[0:v]${fit}[b];[1:v]${fit}[t];[b][t]overlay=x=0:y=0,${HOLD_LAST},format=yuv420p[v]`, 'layers-plain'),
    layer(base, top, `[0:v]${fit}[base];[1:v]${fit}[top];`
      + `[base][top]overlay=x=0:y=0${gate},${HOLD_LAST},format=yuv420p[v]`, 'layers-gated'),
  ]);
  if (!plain.ok || !plain.key) throw new Error(`the ungated overlay failed: ${plain.error}`);
  if (!gated.ok || !gated.key) {
    console.log(`\n  the gated overlay was REFUSED: ${gated.error}`);
    console.log('  `enable=` inside -filter_complex is what compile.ts now depends on.');
    process.exit(1);
  }

  console.log('\n── measured ────────────────────────────────────────────────');
  const [p1, p4, g1, g4] = await Promise.all([
    colourAt(plain.key, 1, 'layers-plain-1'),
    colourAt(plain.key, 4, 'layers-plain-4'),
    colourAt(gated.key, 1, 'layers-gated-1'),
    colourAt(gated.key, 4, 'layers-gated-4'),
  ]);
  record('ungated at 1s', 'blue', name(p1));
  record('ungated at 4s', 'black', name(p4)); // the bug, and the reason to trust the rest
  record('gated   at 1s', 'blue', name(g1));
  record('gated   at 4s', 'red', name(g4));

  console.log('\nand a blend over a gap, which reads its base twice');
  const blended = await layer(base, top,
    `[0:v]${fit},split[keep][under];[1:v]${fit}[top];`
    + '[under][top]blend=all_mode=screen:all_opacity=1[mixed];'
    + `[keep][mixed]overlay=x=0:y=0${gate},${HOLD_LAST},format=yuv420p[v]`, 'layers-blend');
  if (!blended.ok || !blended.key) {
    console.log(`  the gated blend was REFUSED: ${blended.error}`);
    process.exit(1);
  }
  record('blended at 4s', 'red', name(await colourAt(blended.key, 4, 'layers-blend-4')));

  await placedLayers(base);

  const moved = measured.filter((m) => m.got !== m.want);
  if (moved.length) {
    console.log(`\n${moved.length} measurement(s) changed. A gap in an upper track is gated out`);
    console.log('in lib/compiler/compile.ts on the strength of this table. Read layerOver.');
    process.exit(1);
  }
  console.log('\nA gap in an upper track lets the track below through. Measured, not assumed.');
}

/**
 * A layer that was scaled and moved, which is what an inspector Transform is.
 *
 * The values were carried on the clip and skipped by the compiler, so every
 * export came out full frame. What is being measured here is not "does scale
 * work": it is that the three things the filter has to get right all hold at
 * once, and none of them is visible in a graph.
 *
 *   the picture is drawn small, where it was put         inside is blue
 *   nothing is drawn around it, so the track below shows  outside is red
 *   a blend mode applies inside the picture and NOWHERE else
 *
 * The third is the one worth the money. A blend over a placed layer has to
 * decide what to do with the frame the layer does not cover, and the obvious
 * answer, blending against the empty canvas, turns the whole frame to black
 * under `multiply` and washes it out under `screen`.
 */
async function placedLayers(base: string): Promise<void> {
  console.log('\nand a layer scaled to half the frame and moved right, three ways');

  const top = await must('ffmpeg', 'custom', {
    args: ['-f', 'lavfi', '-t', '6', '-i', `color=c=blue:s=${W}x${H}:r=${FPS}`,
           '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '{out}'],
    output: 'layers-solid-top.mp4', tier: 'cpu',
  });

  const [plain, faded, screened, alone] = await Promise.all([
    // placedFilter, mode normal at full opacity
    layer(base, top, `[0:v]${fit}[base];[1:v]${placedFit('yuv420p')}[top];`
      + `[base][top]overlay=${PLACE_AT},format=yuv420p[v]`, 'placed-plain'),
    // placedFilter, mode normal at 50%: the alpha carries the opacity
    layer(base, top, `[0:v]${fit}[base];`
      + `[1:v]${placedFit('yuva420p')},colorchannelmixer=aa=0.5[top];`
      + `[base][top]overlay=${PLACE_AT},format=yuv420p[v]`, 'placed-faded'),
    // placedFilter, a real blend mode: canvas, mask, blend, merge, overlay
    layer(base, top, `color=c=black@0:s=${W}x${H}:r=${FPS},format=yuva420p[canvas];`
      + `[1:v]${placedFit('yuva420p')}[top];`
      + `[canvas][top]overlay=${PLACE_AT}:shortest=1[full];`
      + '[full]split[shown][alpha];[alpha]alphaextract[mask];'
      + `[0:v]${fit},split[keep][under];`
      + '[under][shown]blend=all_mode=screen:all_opacity=1[mixed];'
      + '[mixed][mask]alphamerge[masked];'
      + '[keep][masked]overlay=x=0:y=0,format=yuv420p[v]', 'placed-screen'),
    // transformLayer: the bottom track, which has only black under it, and no
    // sound at all, so `-map 0:a?` has to be optional in earnest
    attempt('ffmpeg', 'custom', {
      args: [
        '-i', '{in0}',
        '-filter_complex',
        `color=c=black:s=${W}x${H}:r=${FPS}[bg];[0:v]${placedFit('yuv420p')}[top];`
        + `[bg][top]overlay=${PLACE_AT}:shortest=1,format=yuv420p[v]`,
        '-map', '[v]', '-map', '0:a?',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '{out}',
      ],
      output: 'placed-alone.mp4', tier: 'cpu', input: [top],
    }),
  ]);

  for (const [what, r] of [['plain', plain], ['faded', faded], ['screened', screened],
                           ['on its own', alone]] as const) {
    if (!r.ok || !r.key) {
      console.log(`\n  the ${what} placement was REFUSED: ${r.error}`);
      console.log('  lib/compiler/compile.ts places a moved layer with exactly these filters.');
      process.exit(1);
    }
  }

  const at = (r: Outcome, [x, y]: [number, number], label: string) =>
    pointAt(r.key as string, 3, x, y, label);
  const [pIn, pLeft, pAbove, fIn, sIn, sLeft, aIn, aLeft] = await Promise.all([
    at(plain, INSIDE, 'placed-plain-in'),
    at(plain, LEFT_OF, 'placed-plain-left'),
    at(plain, ABOVE, 'placed-plain-above'),
    at(faded, INSIDE, 'placed-faded-in'),
    at(screened, INSIDE, 'placed-screen-in'),
    at(screened, LEFT_OF, 'placed-screen-left'),
    at(alone, INSIDE, 'placed-alone-in'),
    at(alone, LEFT_OF, 'placed-alone-left'),
  ]);
  record('placed   inside', 'blue', name(pIn), pIn);
  record('placed   beside', 'red', name(pLeft), pLeft); // no black border round the picture
  record('placed   above ', 'red', name(pAbove), pAbove);
  record('at 50%   inside', 'half and half', name(fIn), fIn);
  record('screened inside', 'magenta', name(sIn), sIn);
  record('screened beside', 'red', name(sLeft), sLeft); // the blend stops at the picture
  record('alone    inside', 'blue', name(aIn), aIn);
  record('alone    beside', 'black', name(aLeft), aLeft); // nothing under the bottom layer
}

main().catch((e) => { console.error(e); process.exit(1); });
