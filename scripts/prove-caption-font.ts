/**
 * Do captions reach the rendered file as words, or as empty boxes?
 *
 *   npm run prove:caption-font
 *
 * The bug this exists for: a caption that reads perfectly in the viewer came
 * out of the export as a row of squares. Nothing could see it. The SRT was
 * right, the graph compiled, the run succeeded, the file played. The browser
 * simply has the whole machine's font book to fall back through and the
 * render container has one font, and that font has no Devanagari in it.
 *
 * Burning a line per script over black and looking at the result says the
 * server draws Latin, Greek, Cyrillic, Arabic, Hebrew, Armenian and Georgian
 * and draws boxes for every Indic script, Thai, Han, kana and Hangul.
 *
 * Fixing it took two things that are worthless apart, so this renders three
 * files and not one:
 *
 *   | the burn                                 | what comes out |
 *   |------------------------------------------|----------------|
 *   | the srt alone                            | boxes          |
 *   | the font attached, nothing naming it     | the same boxes |
 *   | the font attached AND named in the style | the words      |
 *
 * The middle row is the one worth the spend. libass matches an attached font
 * by family and will not fall back to one for a missing glyph, so an
 * attachment that no style asks for renders what no attachment renders. A
 * check that only measured the fixed path could not tell you that, and the
 * next person to "simplify" the force_style away would be told nothing by a
 * green suite.
 *
 * What is measured is `imagemagick/compare`, which answers how different two
 * pictures are as a number. The first version of this counted ink instead,
 * on the theory that a box is heavier than a letter. That is true of
 * Devanagari and false of Han: ten hollow boxes and ten dense characters came
 * back with the same number, and the check failed on a render that was
 * perfect. A measure that only works for the alphabet it was written against
 * is the "test written from the same wrong assumption as the code" that
 * AGENTS.md warns about, wearing a different hat.
 *
 * Every argument here comes out of a graph the real compiler built, and the
 * font is uploaded by the real transport. Retyping either would prove only
 * that this script works.
 *
 * It SPENDS, all small cpu jobs: one synthetic source, four uploads, two
 * muxes, five burns, six band grabs and seven comparisons.
 */
import { readFileSync } from 'node:fs';

import { compile } from '../lib/compiler/compile.ts';
import { emptyTimeline } from '../lib/timeline/document.ts';
import { applyEdits } from '../lib/timeline/edits.ts';
import { timelineSrt, captionText } from '../lib/subtitles/place.ts';
import { fontForCaptions } from '../lib/subtitles/fonts.ts';
import { RATES, frames, timeRange, type Frames } from '../lib/time/frames.ts';
import type { Graph } from '../lib/editor-api/graph.ts';
import type { Timeline } from '../lib/timeline/types.ts';
import type { DeliverySpec } from '../lib/compiler/types.ts';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const i = line.indexOf('=');
  if (i < 0 || line.trim().startsWith('#')) continue;
  const k = line.slice(0, i).trim();
  if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}

const BASE = process.env.EDITOR_API_URL as string;
const KEY = process.env.EDITOR_API_KEY as string;
if (!BASE || !KEY) throw new Error('EDITOR_API_URL and EDITOR_API_KEY have to be in .env.local');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body as T;
}

/** Run one operation to completion and hand back everything it answered. */
async function run(
  engine: string, operation: string, params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const started = await api<{ id?: string }>(`/v1/${engine}/${operation}`, {
    method: 'POST', body: JSON.stringify(params),
  });
  if (!started.id) return started as Record<string, unknown>;
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    const j = await api<{ status: string; result?: Record<string, unknown>; error?: unknown }>(
      `/v1/jobs/${started.id}`);
    if (['succeeded', 'done', 'completed'].includes(j.status)) return j.result ?? {};
    if (['failed', 'error'].includes(j.status)) {
      throw new Error(`${engine}/${operation}: ${JSON.stringify(j.error).slice(0, 300)}`);
    }
  }
  throw new Error(`${engine}/${operation} never finished`);
}

/** The key of the first file an operation wrote. */
async function must(engine: string, operation: string, params: Record<string, unknown>): Promise<string> {
  const outputs = ((await run(engine, operation, params)).outputs ?? []) as { key: string }[];
  if (!outputs.length) throw new Error(`${engine}/${operation} produced nothing`);
  return outputs[0].key;
}

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

// ── the document, and the graph the compiler makes of it ────────────────

const R = RATES.film;
const F = (n: number): Frames => frames(n);
const HINDI = 'आप नहीं समझोगी मम्मी, कितना मसाला बच जाता है इनमें।';
const DELIVERY: DeliverySpec = { width: 854, height: 480, container: 'mp4', reencode: true };

/** One picture clip and one cue, which is the smallest case of the bug. */
function captioned(text: string): Timeline {
  const t = emptyTimeline('tl_font', 'Caption font proof', R);
  t.media.v1 = { key: 'unused.mp4', name: 'unused.mp4', kind: 'video', available: timeRange(F(0), F(240)) };
  const v1 = t.tracks.find((x) => x.kind === 'video') ?? t.tracks[1];
  v1.items.push({
    id: 'c1', kind: 'clip', name: 'c1', mediaKey: 'v1',
    sourceRange: timeRange(F(0), F(72)), enabled: true, effects: [],
  });
  const withTrack = applyEdits(t, [{
    op: 'add_track',
    at: t.tracks.length,
    track: {
      id: 'trk_s1', kind: 'subtitle', name: 'Subtitles 1',
      locked: false, muted: false, solo: false, enabled: true, autoSelect: true,
    },
  }]).timeline;
  return applyEdits(withTrack, [{
    op: 'add_caption',
    trackId: 'trk_s1',
    at: F(12),
    caption: { id: 'cap_0', kind: 'caption', text, duration: F(48), enabled: true },
  }]).timeline;
}

/** The args of the one ffmpeg/custom node in a graph that writes this file. */
function argsFor(graph: Graph, output: string): string[] {
  const node = graph.nodes.find(
    (n) => n.kind === 'engine' && n.operation === 'custom'
      && (n.params as { output?: string }).output === output,
  );
  if (!node || node.kind !== 'engine') throw new Error(`the compiler emitted no node writing ${output}`);
  const args = (node.params as { args?: string[] }).args;
  if (!args) throw new Error(`the ${output} node carries no args`);
  return args;
}

// ── reading the pictures back ───────────────────────────────────────────

/**
 * The caption band of the moment the cue is on screen.
 *
 * The band and not the frame. `compare` answers a fraction of the whole
 * picture, and a line of text is a couple of percent of a 854x480 frame, so
 * comparing whole frames buries the only thing being measured in the black
 * around it. Cropping to the strip the words sit in costs exactly the same
 * one operation and multiplies the signal by the ratio of the areas.
 */
const bandOf = (key: string, label: string): Promise<string> =>
  must('ffmpeg', 'custom', {
    input: key,
    args: ['-ss', '1.0', '-i', '{in0}', '-frames:v', '1', '-vf', 'crop=854:120:0:360', '{out}'],
    output: `${label}.png`, tier: 'cpu',
  });

/** How different two bands are, as a fraction. 0 is identical. */
async function difference(a: string, b: string): Promise<number> {
  const r = await run('imagemagick', 'compare', { a, b, tier: 'cpu' });
  const d = r.difference;
  if (typeof d !== 'number') throw new Error(`compare answered no difference: ${JSON.stringify(r).slice(0, 200)}`);
  return d;
}

/**
 * Where the line between "the same picture" and "a different one" sits.
 *
 * Not where `compare`'s own summary puts it. That says under 0.02 is usually
 * the same shot, which is a sentence about photographs: two frames of the
 * same room differ by more than a caption does. Reading these against 0.02
 * failed every check on renders that were perfect, which is worth leaving
 * written down, because the number looked authoritative and was answering a
 * different question.
 *
 * What the runs actually measure: two identical renders come back at exactly
 * 0, and the smallest real difference measured here is two orders of
 * magnitude above that. There is no middle ground to be careful about.
 */
const DIFFERENT = 0.002;
const IDENTICAL = 0.0005;

// ── the proof ───────────────────────────────────────────────────────────

const { serverTransport } = await import('../lib/export/transport.server.ts');
const transport = serverTransport();

console.log(`base: ${BASE}\n`);
console.log('making a 3s black source, so anything drawn is the caption');
const src = await must('ffmpeg', 'synthetic', {
  pattern: 'color', color: 'black', width: 854, height: 480, fps: 24,
  durationSec: 3, audio: false, container: 'mp4', videoCodec: 'h264',
});
const blank = await bandOf(src, 'blank');

/**
 * One script, end to end.
 *
 * `control` adds the third render, the font attached with nothing naming it.
 * That one is about how libass behaves and not about the font, so it is
 * worth its cost once rather than once per script.
 */
async function prove(label: string, text: string, control: boolean): Promise<void> {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 54 - label.length))}\n`);

  const timeline = captioned(text);
  const need = fontForCaptions(captionText(timeline));
  const font = need.font;
  check(`${label}: the cues are read as needing a font`, font !== null, font?.family ?? 'none');
  check(`${label}: nothing in them is left uncovered`, need.missing.length === 0, need.missing.join(', '));
  if (!font) return;

  const srtKey = await transport.uploadText!('captions.srt', timelineSrt(timeline));
  const fontKey = await transport.uploadFont!(font);

  const withFont = compile(timeline, {
    delivery: DELIVERY, burnSubtitles: true, subtitleKey: srtKey,
    subtitleFont: { key: fontKey, family: font.family, file: font.file },
  });
  const withoutFont = compile(timeline, {
    delivery: DELIVERY, burnSubtitles: true, subtitleKey: srtKey,
  });

  const namedArgs = argsFor(withFont.graph, 'subtitled.mp4');
  const plainArgs = argsFor(withoutFont.graph, 'subtitled.mp4');
  check(
    `${label}: the compiler names the font in the burn it built`,
    namedArgs.some((a) => a.includes(`force_style='FontName=${font.family}'`)),
    namedArgs.find((a) => a.startsWith('subtitles=')) ?? '',
  );

  const mkv = await must('ffmpeg', 'custom', {
    input: [srtKey, fontKey],
    args: argsFor(withFont.graph, 'captions.mkv'),
    output: 'captions.mkv', tier: 'cpu',
  });

  const burn = async (name: string, args: string[], subs: string): Promise<string> => {
    console.log(`  burning: ${name}`);
    return bandOf(await must('ffmpeg', 'custom', {
      input: [src, subs], args, output: `${name}.mp4`, tier: 'cpu',
    }), `${name}-band`);
  };

  const plain = await burn(`${label}-no-font`, plainArgs, srtKey);
  const named = await burn(`${label}-named`, namedArgs, mkv);

  const drewPlain = await difference(blank, plain);
  const drewNamed = await difference(blank, named);
  const changed = await difference(plain, named);
  console.log(`\n   over black: srt alone ${drewPlain.toFixed(4)}, named ${drewNamed.toFixed(4)}`
    + `   ·   between them ${changed.toFixed(4)}\n`);

  check(`${label}: the srt alone draws something, so the burn itself works`, drewPlain > DIFFERENT, `${drewPlain}`);
  check(`${label}: naming the font draws something too`, drewNamed > DIFFERENT, `${drewNamed}`);
  check(
    `${label}: and not the same something, so the font is what drew it`,
    changed > DIFFERENT,
    `${changed}: the boxes and the words are different pictures`,
  );

  if (!control) return;

  /**
   * The same burn with the attachment and nothing naming it.
   *
   * Built from the compiler's own named args by taking the style back off,
   * so it stays the burn the compiler emits in every other respect. This is
   * the row that proves the attachment alone is not the fix, and that the
   * force_style nobody can see the point of is the point.
   */
  const unnamedArgs = namedArgs.map((a) => (a.startsWith('subtitles=') ? 'subtitles={in1}' : a));
  const unnamed = await burn(`${label}-unnamed`, unnamedArgs, mkv);
  const ignored = await difference(plain, unnamed);
  console.log(`\n   attached but unnamed, against the srt alone: ${ignored.toFixed(4)}\n`);
  check(
    'attaching the font and naming nothing changes NOTHING',
    ignored < IDENTICAL,
    `${ignored}: if this ever rises, libass learned to fall back and the style could go`,
  );
}

/**
 * Two scripts, because the two font files are not the same kind of file.
 *
 * Devanagari is a TrueType variable font from google/fonts and Chinese is a
 * static CFF OpenType from noto-cjk: a different container, a different
 * outline format and a different name table. Proving one proves nothing
 * about the other, and the CJK files are the ones with the traps in them.
 */
await prove('devanagari', HINDI, true);
await prove('chinese', '这是中文字幕，很好。', false);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed\n`);
process.exit(failed.length ? 1 : 0);
