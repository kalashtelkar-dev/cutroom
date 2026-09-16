/**
 * The cues a run actually hands back, onto the document.
 *
 * Every number here came off `run_219ef6e8-96ff-4945-95d5-9fb0b435a1c8`,
 * a 12.3s Hindi clip through `tpl_cdvkzzJeZylk`, and the SRT is the bytes
 * that run wrote. Nothing in this file is invented, which is the point: the
 * import pipeline once had 13 green tests over a transport that did what the
 * code assumed rather than what the API did.
 *
 * Placement is asserted on the timeline that comes out of `applyEdits`, not
 * on the ops, for the same reason every other placement test in this repo is.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { RATES, frames } from '../lib/time/frames.ts';
import { emptyTimeline, placeTrack } from '../lib/timeline/document.ts';
import { applyEdits } from '../lib/timeline/edits.ts';
import { parseSrt } from '../lib/subtitles/srt.ts';
import { parseWhisperCues, cuesInOutput, retimeTranslation } from '../lib/subtitles/cues.ts';
import { placeCuesOps, captionAt, cuesOf } from '../lib/subtitles/place.ts';
import type { Timeline } from '../lib/timeline/types.ts';

const R = RATES.film;            // 24fps, so a second is 24 frames
const f = frames;

/** The first cue's words, as `whisperx/words` hands them back. */
const WORDS = [
  { start: 0.051, end: 0.272, word: 'मम्मी,', score: 0.716 },
  { start: 0.493, end: 0.694, word: 'कितना', score: 0.706 },
  { start: 0.754, end: 0.914, word: 'टाइम', score: 0.57 },
  { start: 0.934, end: 1.215, word: 'लगेगा?', score: 0.962 },
];

/** Six segments, as the run replied. `words` is trimmed to the first cue's. */
const SEGMENTS = [
  {
    start: 0.051, end: 1.215, text: ' मम्मी, कितना टाइम लगेगा?',
    avg_logprob: -0.0961407129881812, words: WORDS,
  },
  { start: 1.276, end: 5.472, text: 'हाँ, बस दो मिनट। ठीक है। मम्मी!' },
  { start: 5.953, end: 6.496, text: 'क्या हुआ?' },
  { start: 6.736, end: 8.463, text: 'पता है कितनी कीमती चीज फैक रही थी आप ये?' },
  { start: 8.624, end: 9.708, text: 'अरे पागल है क्या?' },
  { start: 9.929, end: 12.298, text: 'हाँ, आप नहीं समझोगी मम्मी, कितना मसाला बच जाता है इनमें।' },
];

/** The run's reply, field for field. */
const RUN_OUTPUT: Record<string, unknown> = {
  cues: SEGMENTS,
  words: WORDS,
  wordCount: 38,
  subtitleFiles: [
    'output/bb4622ea-b1e2-4022-9948-ebbe94c60b88/transcript.srt',
    'output/bb4622ea-b1e2-4022-9948-ebbe94c60b88/transcript.vtt',
    'output/bb4622ea-b1e2-4022-9948-ebbe94c60b88/transcript.json',
  ],
  fileCount: 3,
  cuesJson: ['output/4206ccae-0084-466b-8eff-198ce6f77b8a/transcript.json'],
  transcript: 'मम्मी, कितना टाइम लगेगा? हाँ, बस दो मिनट।',
  language: 'hi',
  languageProbability: 0.9844,
  degenerate: false,
  durationSec: 12.298,
  audio: 'output/699806c7-7539-4b5d-b9e0-d86469339e5e/audio.wav',
};

/** transcript.srt from that same run, to the byte. */
const RENDERED_SRT = '1\n00:00:00,051 --> 00:00:08,343\n'
  + 'मम्मी, कितना टाइम लगेगा? हाँ, बस दो मिनट। ठीक है। \nमम्मी! क्या हुआ? पता है कितनी कीमती चीज फैक रही थी आप\n\n'
  + '2\n00:00:08,363 --> 00:00:12,298\n'
  + 'ये? अरे पागल है क्या? हाँ, आप नहीं समझोगी मम्मी, \nकितना मसाला बच जाता है इनमें।\n\n';

/** Frame positions at 24fps: round(seconds x 24), start and end each on their own. */
const EXPECTED = [
  { start: 1, duration: 28 },
  { start: 31, duration: 100 },
  { start: 143, duration: 13 },
  { start: 162, duration: 41 },
  { start: 207, duration: 26 },
  { start: 238, duration: 57 },
];

const emptyDoc = (): Timeline => emptyTimeline('tl_1', 'Test', R);

describe('reading a run\'s cues', () => {
  test('six segments, at the frames the seconds round to', () => {
    const cues = parseWhisperCues(SEGMENTS, R);
    assert.equal(cues.length, 6, 'the fixture has six segments to find');
    assert.deepEqual(
      cues.map((c) => ({ start: c.start, duration: c.duration })),
      EXPECTED,
    );
    assert.equal(cues[0].text, 'मम्मी, कितना टाइम लगेगा?', 'the leading space is gone');
  });

  test('the whole reply, without being told which field', () => {
    const cues = cuesInOutput(RUN_OUTPUT, R);
    assert.equal(cues.length, 6);
    assert.equal(cues[2].text, 'क्या हुआ?');
  });

  test('a flat word list is not a cue list', () => {
    // whisperx/words hands back the same start and end with the text under
    // `word`, and one caption per word is not what anybody asked for
    assert.ok(WORDS.length > 0, 'the fixture has words to reject');
    assert.deepEqual(parseWhisperCues(WORDS, R), []);
    assert.deepEqual(parseWhisperCues({ words: WORDS }, R), []);
  });

  test('the shape the .json file has, too', () => {
    // read-json hands over {segments, language}, which is the same data
    assert.equal(parseWhisperCues({ segments: SEGMENTS, language: null }, R).length, 6);
  });

  test('nothing to read is no cues, not a throw', () => {
    assert.deepEqual(parseWhisperCues(undefined, R), []);
    assert.deepEqual(parseWhisperCues({ segments: [] }, R), []);
    assert.deepEqual(cuesInOutput({ degenerate: true, transcript: '', language: 'hi' }, R), []);
    assert.deepEqual(cuesInOutput(null, R), []);
  });

  test('a cue with no words in it, or none left after rounding, is dropped', () => {
    const cues = parseWhisperCues([
      { start: 0, end: 1, text: '   ' },
      { start: 1, end: 1.01, text: 'blink' },     // under half a frame at 24fps
      { start: 2, end: 3, text: 'kept' },
    ], R);
    assert.deepEqual(cues.map((c) => c.text), ['kept']);
  });

  test('an overlap is cut back to the next cue, not left to be overwritten', () => {
    // add_caption splices, so an overlap would silently eat the end of the
    // cue before it and the document would disagree with what we returned
    const cues = parseWhisperCues([
      { start: 0, end: 2, text: 'first' },
      { start: 1, end: 3, text: 'second' },
    ], R);
    assert.deepEqual(cues, [
      { start: f(0), duration: f(24), text: 'first' },
      { start: f(24), duration: f(48), text: 'second' },
    ]);
  });
});

describe('why the reply beats the file it also wrote', () => {
  test('whisperx re-flows its own segments into two blocks', () => {
    const fromFile = parseSrt(RENDERED_SRT, R);
    const fromReply = parseWhisperCues(SEGMENTS, R);
    assert.ok(fromFile.length > 0, 'the SRT fixture has to parse before it can be compared');

    assert.equal(fromFile.length, 2);
    assert.equal(fromReply.length, 6);
    // eight and a bit seconds of four sentences on screen at once
    assert.deepEqual(fromFile[0], { start: f(1), duration: f(199), text: fromFile[0].text });
    assert.ok(fromFile[1].text.startsWith('ये?'), 'the second block opens mid-sentence');
    // the same words, cut where the speaker stops
    assert.ok(fromReply.every((c) => c.duration <= f(100)));
  });
});

describe('cues onto a project that has no subtitle track', () => {
  test('the track is made in the same batch as the captions', () => {
    const before = emptyDoc();
    assert.equal(before.tracks.filter((t) => t.kind === 'subtitle').length, 0);

    const ops = placeCuesOps(before, parseWhisperCues(SEGMENTS, R), { createTrack: true, seed: 'r1' });
    assert.equal(ops[0].op, 'add_track', 'the track has to exist before a caption lands on it');

    const after = applyEdits(before, ops).timeline;
    const track = after.tracks.find((t) => t.kind === 'subtitle');
    assert.ok(track, 'a subtitle track');
    assert.equal(track.kind, 'subtitle');

    const placed = placeTrack(track).filter((p) => p.item.kind === 'caption');
    assert.equal(placed.length, 6);
    assert.deepEqual(
      placed.map((p) => ({ start: p.range.start, duration: p.range.duration })),
      EXPECTED.map((e) => ({ start: f(e.start), duration: f(e.duration) })),
    );
  });

  test('one undo, because it is one batch', () => {
    const before = emptyDoc();
    const ops = placeCuesOps(before, parseWhisperCues(SEGMENTS, R), { createTrack: true });
    const { timeline, inverse } = applyEdits(before, ops);
    assert.equal(cuesOf(timeline).length, 6);
    assert.deepEqual(applyEdits(timeline, inverse).timeline.tracks, before.tracks);
  });

  test('the cue on screen at a frame is the one being spoken', () => {
    const doc = applyEdits(
      emptyDoc(),
      placeCuesOps(emptyDoc(), parseWhisperCues(SEGMENTS, R), { createTrack: true }),
    ).timeline;

    assert.equal(captionAt(doc, f(143))?.text, 'क्या हुआ?');      // its first frame
    assert.equal(captionAt(doc, f(155))?.text, 'क्या हुआ?');      // its last, [143, 156)
    // 156 to 161 is the pause before the next line, and a caption held over
    // it would be a caption sitting on screen while nobody is speaking
    assert.equal(captionAt(doc, f(156)), null);
    assert.equal(captionAt(doc, f(162))?.text, 'पता है कितनी कीमती चीज फैक रही थी आप ये?');
    assert.equal(captionAt(doc, f(0)), null, 'nothing is said in the first frame');
    assert.equal(captionAt(doc, f(295)), null, 'or after the last cue ends');
  });

  test('a clip that does not start at zero carries its cues with it', () => {
    const before = emptyDoc();
    const doc = applyEdits(
      before,
      placeCuesOps(before, parseWhisperCues(SEGMENTS, R), { createTrack: true, offset: f(48) }),
    ).timeline;
    assert.equal(cuesOf(doc)[0].start, f(49));
    assert.equal(captionAt(doc, f(191))?.text, 'क्या हुआ?');
  });

  test('running it twice replaces the cues rather than stacking them', () => {
    const before = emptyDoc();
    const once = applyEdits(before, placeCuesOps(before, parseWhisperCues(SEGMENTS, R), {
      createTrack: true, seed: 'run1',
    })).timeline;
    // the second run finds the track the first one made, so it clears it
    const twice = applyEdits(once, placeCuesOps(once, parseWhisperCues(SEGMENTS, R), {
      createTrack: true, seed: 'run2',
    })).timeline;

    assert.equal(twice.tracks.filter((t) => t.kind === 'subtitle').length, 1);
    assert.equal(cuesOf(twice).length, 6);
    assert.deepEqual(cuesOf(twice), cuesOf(once));
  });

  test('without createTrack it still refuses, and says why', () => {
    assert.throws(
      () => placeCuesOps(emptyDoc(), parseWhisperCues(SEGMENTS, R)),
      /no subtitle track/,
    );
  });
});

/**
 * A translation, put back on the timings the aligner measured.
 *
 * `vllm/translate` answers with segments of its own and they are not the ones
 * it was handed. Three runs over the same seven seconds of Hindi measured
 * three behaviours: one cue in and one out on the same boundaries, one cue in
 * and three out, and four aligned cues in and ONE out ending a frame early.
 * The third is a caption on screen for the length of the clip, which is what
 * `whisperx/translate` was rejected for, so a plan that relies on the model's
 * numbers has not solved the problem it set out to solve.
 */
describe('retiming a translation', () => {
  const cue = (start: number, duration: number, text: string) =>
    ({ start: frames(start), duration: frames(duration), text });

  test('matching counts take the aligner timings and the model words', () => {
    const aligned = [cue(5, 24, 'नमस्ते'), cue(30, 40, 'यह एक परीक्षण है')];
    const translated = [cue(4, 26, 'Hello'), cue(31, 38, 'This is a test')];

    const { cues, retimed } = retimeTranslation(aligned, translated);
    assert.equal(retimed, true);
    assert.deepEqual(cues.map((c) => [c.start, c.duration]), [[5, 24], [30, 40]],
      'the aligner measured these against the audio; the model measured nothing');
    assert.deepEqual(cues.map((c) => c.text), ['Hello', 'This is a test']);
  });

  test('a different count keeps the model spans, and says so', () => {
    // one long line in English is three in the target, or the other way round:
    // forcing that onto the original cues would throw two thirds of it away
    const aligned = [cue(5, 100, 'एक लंबा वाक्य')];
    const translated = [cue(5, 30, 'One'), cue(40, 30, 'long'), cue(75, 30, 'sentence')];

    const { cues, retimed } = retimeTranslation(aligned, translated);
    assert.equal(retimed, false);
    assert.equal(cues.length, 3);
    assert.deepEqual(cues.map((c) => c.text), ['One', 'long', 'sentence']);
  });

  test('a translation that came back empty is empty, never the original', () => {
    const aligned = [cue(5, 24, 'नमस्ते')];
    const { cues, retimed } = retimeTranslation(aligned, []);
    assert.deepEqual(cues, [], 'placing the source language here is the silent wrong-language bug');
    assert.equal(retimed, false);
  });

  test('the words are the only thing taken from the model', () => {
    const aligned = [cue(5, 24, 'नमस्ते')];
    const translated = [{ ...cue(999, 1, 'Hello'), extra: 'ignored' }];
    const { cues } = retimeTranslation(aligned, translated);
    assert.equal(cues[0].start, frames(5));
    assert.equal(cues[0].duration, frames(24));
  });
});
