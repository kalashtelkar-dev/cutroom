/**
 * Subtitles in the language spoken, and in another one, against the live API.
 *
 *   npm run dev                          in another terminal
 *   npm run prove:subtitle-language
 *
 * This SPENDS: one TTS generation to make real speech, then a transcription
 * per case and a translation on top of one of them. Everything it makes is a
 * job output under this account and nothing is left on a timeline.
 *
 * It exists because the unit suite cannot see any of what actually broke here,
 * and the list is long enough to be worth writing down:
 *
 *  - The router's answers are arithmetic and tested offline. Whether the plan
 *    they produce RUNS is a question about whisperx's params.
 *  - An operation is a JOB and a job has no SSE stream. Every card in play ran
 *    a pipeline, so the transport's operation path had never been exercised;
 *    a fake transport would not have noticed and did not.
 *  - `whisperx/translate` SILENTLY returns the source language on the default
 *    model. Status `succeeded`, no flag, no diagnostic. The only way to know
 *    is to read the words, which is why that is a case here and not a comment.
 *  - The reason for transcribing and then translating, rather than asking
 *    whisper to translate, is that whisper's translate skips the alignment and
 *    answers one segment for the whole clip. That claim is checked by
 *    comparing the timings of the two runs, not by trusting the card.
 *
 * It drives the app's own routes, so the route handlers, the real
 * `browserTransport` and its polling loop are all in the path. The only thing
 * it does not exercise is React.
 */
import { getCard } from '../lib/intel/index.ts';
import { answerByLabel, bindingsFrom } from '../lib/intel/options.ts';
import { createExecutor } from '../lib/executor/executor.ts';
import { browserTransport } from '../lib/executor/browserTransport.ts';
import { parseWhisperCues } from '../lib/subtitles/cues.ts';
import { rate } from '../lib/time/frames.ts';
import type { Step } from '../lib/intel/types.ts';

// ── the app ─────────────────────────────────────────────────────────────

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
console.log(`driving ${BASE}\n`);

/**
 * Relative URLs, resolved against the running app.
 *
 * The transport under test is the browser's, and it names `/api/...` because
 * that is where the key lives. Pointing `fetch` at the dev server is what lets
 * the shipped file run here unchanged rather than being copied into this
 * script, which is how `prove:layers` once proved a filter nothing emitted.
 */
const real = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  return real(url.startsWith('/') ? `${BASE}${url}` : url, init);
}) as typeof globalThis.fetch;

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── real speech to work on ──────────────────────────────────────────────

/** Three sentences, so a run that collapses them into one block shows it. */
const SCRIPT = 'नमस्ते, यह एक परीक्षण है। हम उपशीर्षक बना रहे हैं। '
  + 'यह वीडियो हिंदी में रिकॉर्ड किया गया था।';

async function op(engine: string, operation: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/ops/${engine}/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const started = await res.json();
  if (!res.ok || !started.id) throw new Error(`${engine}/${operation}: ${JSON.stringify(started).slice(0, 300)}`);

  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    const job = await (await fetch(`/api/jobs/${started.id}`)).json();
    if (['queued', 'running'].includes(job.status)) continue;
    if (job.status !== 'succeeded') throw new Error(`${engine}/${operation} ${job.status}: ${JSON.stringify(job.error)}`);
    return job.result as Record<string, unknown>;
  }
  throw new Error(`${engine}/${operation} never finished`);
}

console.log('making speech to work on (indicspeak, gpu)');
const speech = await op('indicspeak', 'speak', { text: SCRIPT, speaker: 'Amit', format: 'wav', tier: 'gpu' });
const AUDIO = String((speech.outputs as { key: string }[])[0].key);
console.log(`  ${AUDIO}  ${speech.durationSec}s\n`);

// ── the card answers its own questions ──────────────────────────────────

const card = getCard('subtitle-burn');
if (!card) throw new Error('subtitle-burn is not a card any more');
const CARD = card;

console.log('the router, through the app\'s own route');
const routed = await (await fetch('/api/route', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: 'put subtitles on this' }),
})).json();

check('a bare ask routes to subtitle-burn', routed.plan?.cardId === 'subtitle-burn', routed.plan?.cardId ?? routed.declined);
check(
  'and asks only what it cannot work out',
  routed.pending?.length === 1 && routed.pending[0].id === 'target',
  (routed.pending ?? []).map((q: { id: string }) => q.id).join(', ') || 'nothing',
);
check(
  'the spoken language is assumed, and says it was',
  (routed.answers ?? []).some((a: { questionId: string; assumed?: boolean }) =>
    a.questionId === 'spoken' && a.assumed === true),
  JSON.stringify(routed.answers),
);
check('with nothing wrong with the plan', (routed.problems ?? []).length === 0, JSON.stringify(routed.problems));

const named = await (await fetch('/api/route', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: 'put hindi subtitles on this' }),
})).json();
check(
  'a language in the prompt answers the question that claimed it',
  named.bindings?.target === 'hindi' && named.pending?.length === 0,
  `${JSON.stringify(named.bindings)}, ${named.pending?.length} still to ask`,
);

const conf = await (await fetch('/api/config/translation')).json();
check('translation is configured', typeof conf.connection === 'string' && conf.connection.length > 0,
  conf.connection ?? 'none, so a translation would be refused before it spent anything');

// ── running the card's own plan ─────────────────────────────────────────

const RATE = rate(24);

/** Answers by label, exactly as a chip click reaches the shell. */
function bindingsFor(picked: Record<string, string>): Record<string, unknown> {
  const answers = Object.entries(picked).map(([id, label]) => {
    const q = CARD.questions.find((x) => x.id === id);
    if (!q) throw new Error(`no question "${id}" on the card`);
    const a = answerByLabel(q, label);
    if (!a) throw new Error(`"${label}" is not an answer to "${id}"`);
    return a;
  });
  return bindingsFrom(answers);
}

interface Landed {
  cues: { start: number; duration: number; text: string }[];
  language: string;
  /** whisperx's own count, to check we placed its segments and not a file. */
  segmentCount: number;
  /** True when the segments carry per-word timings, which is what aligned means. */
  aligned: boolean;
}

async function run(label: string, picked: Record<string, string>): Promise<Landed> {
  const bindings: Record<string, unknown> = {
    ...bindingsFor(picked),
    source: AUDIO,
    // the shell reads this off /api/config/translation before it starts anything
    ...(conf.connection ? { vllmConnection: { use: conf.connection } } : {}),
    // seeded for local ops and referenced by no plan: the value whose
    // presence used to refuse every one of these runs before it began
    selection: 'clp_proof01',
    playhead: 0,
  };

  const jobs: string[] = [];
  const exec = createExecutor({
    transport: browserTransport(),
    emit: (e) => {
      if (e.type === 'job.queued') jobs.push(e.jobId);
      if (e.type === 'step.failed') console.log(`    ${e.failure}: ${e.message}`);
    },
  });

  console.log(`\n${label}`);
  const state = await exec.run({ cardId: CARD.id, steps: CARD.steps as Step[] }, { bindings });
  check(`${label}: the run finished`, state.status === 'done', state.error ?? state.status);
  if (state.status !== 'done') return { cues: [], language: '', segmentCount: 0, aligned: false };

  // the answer is on the LAST job, which is the translation when there was one
  const job = await (await fetch(`/api/jobs/${jobs[jobs.length - 1]}`)).json();
  const result = (job.result ?? {}) as Record<string, unknown>;
  const segments = (Array.isArray(result.segments) ? result.segments : []) as Record<string, unknown>[];
  return {
    cues: parseWhisperCues(result.segments, RATE),
    language: String(result.language ?? ''),
    segmentCount: segments.length,
    aligned: segments.every((seg) => Array.isArray(seg.words)),
  };
}

const DEVANAGARI = /[ऀ-ॿ]/;
const LATIN = /[A-Za-z]/;

const same = await run('subtitles in the language spoken', { spoken: 'Hindi', target: 'Same as the speech' });
check('it came back as Hindi words', DEVANAGARI.test(same.cues.map((c) => c.text).join(' ')),
  same.cues[0]?.text?.slice(0, 40) ?? 'nothing');
/**
 * The cues are whisperx's own aligned segments, and not the SRT it wrote.
 *
 * whisperx renders subtitles by filling lines rather than by honouring the
 * segments it aligned, so the file and the result disagree, and the file is
 * the one that puts eight seconds of text on screen at once. How MANY
 * segments there are is whisper's business and depends on the audio: a short
 * continuous utterance is legitimately one. That we placed every one of them,
 * with the word timings attached, is ours.
 */
check('every segment whisperx aligned became a cue', same.cues.length === same.segmentCount,
  `${same.cues.length} cues from ${same.segmentCount} segments`);
check('and they came back aligned, with per-word timings', same.aligned, `${same.segmentCount} segment(s)`);
check('every cue holds time', same.cues.length > 0 && same.cues.every((c) => c.duration > 0),
  same.cues.map((c) => c.duration).join(', '));

const english = await run('subtitles translated to English', { spoken: 'Hindi', target: 'English' });
check('it came back as English words', LATIN.test(english.cues.map((c) => c.text).join(' '))
  && !DEVANAGARI.test(english.cues.map((c) => c.text).join(' ')),
  english.cues[0]?.text?.slice(0, 40) ?? 'nothing');

/**
 * The reason the plan transcribes and then translates.
 *
 * Measured, and NOT what was assumed. A translation does not come back on the
 * same cue boundaries: on one run it answered one cue for one, and on the
 * next it split a single 6.6s segment into three. What it keeps is the SPAN,
 * the first start and the last end to the frame, and it re-divides inside it,
 * which for subtitles is an improvement rather than a defect: a sentence that
 * reads as three lines in English should be three lines.
 *
 * So the property worth pinning is that the words stay over the footage they
 * belong to. Whisper's own translate task cannot offer even that: it answers
 * `alignSkipped` and one segment for the whole clip, which is one caption on
 * screen for the length of the programme.
 */
const span = (cues: Landed['cues']) => cues.length
  ? { from: cues[0].start, to: cues[cues.length - 1].start + cues[cues.length - 1].duration }
  : null;
const a = span(same.cues);
const b = span(english.cues);
check('the translation covers exactly the stretch the speech does',
  a !== null && b !== null && a.from === b.from && a.to === b.to,
  `${a?.from}..${a?.to}  vs  ${b?.from}..${b?.to}`);
// a batch of one is never shown two cues, so it cannot merge them; this is
// the assertion that failed while the card relied on a system prompt instead
check('and one cue out for every cue in', english.cues.length === same.cues.length,
  `${same.cues.length} aligned, ${english.cues.length} translated`);
check('every translated cue holds time and none overlaps the next',
  english.cues.every((c, i) => c.duration > 0
    && (i === 0 || english.cues[i - 1].start + english.cues[i - 1].duration <= c.start)),
  english.cues.map((c) => `${c.start}+${c.duration}`).join(' '));

// ── the measurement the card is built on ────────────────────────────────

console.log('\nwhy this is not whisperx/translate (the card claims both of these)');
const quiet = await op('whisperx', 'translate', { input: AUDIO, formats: ['json'], tier: 'cpu' });
check(
  'the default model still returns the source language, silently',
  DEVANAGARI.test(String(quiet.text ?? '')),
  `succeeded, and said: ${String(quiet.text ?? '').slice(0, 50)}`,
);

// on gpu: large-v3 on the cpu pod does translate, and answers "the server
// closed without answering" often enough that a proof should not depend on it
const named3 = await op('whisperx', 'translate', { input: AUDIO, model: 'large-v3', formats: ['json'], tier: 'gpu' });
check(
  'and large-v3 is what makes it translate at all',
  LATIN.test(String(named3.text ?? '')) && !DEVANAGARI.test(String(named3.text ?? '')),
  String(named3.text ?? '').slice(0, 50),
);
/**
 * And this is the half that made it unusable even when it works.
 *
 * Its own answer says so: `translated text cannot be force-aligned against
 * source-language audio`. Segment counts vary with the audio and prove
 * nothing on their own; whether the words carry timings does not.
 */
const loose = (Array.isArray(named3.segments) ? named3.segments : []) as Record<string, unknown>[];
check(
  'but it throws the alignment away doing it',
  loose.length > 0 && !loose.some((seg) => Array.isArray(seg.words)),
  `${loose.length} segment(s), none with word timings, against ${same.segmentCount} aligned`,
);

// ── verdict ─────────────────────────────────────────────────────────────

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.log(failed.map((f) => `  FAIL  ${f.name}  ${f.detail}`).join('\n'));
  process.exit(1);
}
