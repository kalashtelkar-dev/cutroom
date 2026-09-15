/**
 * A transcription's own segments onto the timeline.
 *
 * The obvious route is the SRT the same run wrote, and it is the wrong one.
 * whisperx renders subtitles by filling lines rather than by honouring the
 * segments it aligned, so the cues in the file are not the cues in the
 * result. Measured on run `run_219ef6e8`, a 12.3s Hindi clip:
 *
 *     segments (the `cues` field)      transcript.srt
 *     0.051 -> 1.215  one sentence     0.051 -> 8.343  four sentences
 *     1.276 -> 5.472                   8.363 -> 12.298 starting mid-sentence
 *     5.953 -> 6.496
 *     6.736 -> 8.463
 *     8.624 -> 9.708
 *     9.929 -> 12.298
 *
 * Six captions that change with the dialogue, against two blocks of text
 * that sit on screen for eight seconds each and break in the middle of a
 * sentence. The old pipeline's file does the same thing, so this is whisperx
 * and not one node's parameters: it is why the burn-in looked wrong rather
 * than why it looked wrong on one clip.
 *
 * So the cue list comes from the run's reply, which needs no fetch and no
 * parse, and `parseSrt` stays for the case that really is a file: an SRT
 * somebody imported, or a pipeline that returns nothing else.
 *
 * Seconds become frames through `atFrame`, the same boundary SRT crosses, so
 * there is one rounding rule for captions and not two.
 */
import { frames, type Rate } from '../time/frames.ts';
import { atFrame, type Cue } from './srt.ts';

/**
 * One aligned segment.
 *
 * `text` is what makes this a segment rather than a word: `whisperx/words`
 * hands back a flat list with exactly the same `start` and `end` and the
 * text under `word`, and putting that on a track would be one caption per
 * word. Requiring `text` is what tells the two apart.
 */
interface Segment {
  start: number;
  end: number;
  text: string;
}

const isSegment = (v: unknown): v is Segment => {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return typeof s.start === 'number' && Number.isFinite(s.start)
    && typeof s.end === 'number' && Number.isFinite(s.end)
    && typeof s.text === 'string';
};

/**
 * The segments inside a value, whatever it is wrapped in.
 *
 * Two real shapes: the `cues` field of a run's reply is the bare array, and
 * the `transcript.json` the same run wrote is `{segments, language}`. A card
 * reading the file with `read-json` hands over the second.
 */
function segmentsIn(value: unknown): Segment[] {
  if (Array.isArray(value)) return value.filter(isSegment);
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>).segments;
    if (Array.isArray(inner)) return inner.filter(isSegment);
  }
  return [];
}

/**
 * Segments as cues at the project rate.
 *
 * Half-open, exactly as SRT is read: `[start, end)` in frames, and a cue
 * that rounds to no frames at this rate is dropped rather than becoming an
 * item that holds time and draws nothing.
 *
 * Overlaps are cut back to the next cue's start. whisperx does emit them,
 * and `add_caption` splices rather than inserts, so an overlap would not
 * corrupt the track: the later cue would quietly eat the end of the one
 * before it and the document would then disagree with the durations this
 * function returned. Cutting here means the caller is told the truth.
 */
export function parseWhisperCues(value: unknown, rate: Rate): Cue[] {
  const spans = segmentsIn(value)
    .map((s) => ({ start: atFrame(s.start, rate), end: atFrame(s.end, rate), text: s.text.trim() }))
    .filter((s) => s.text !== '' && s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const cues: Cue[] = [];
  spans.forEach((span, i) => {
    const next = spans[i + 1];
    const end = next && next.start < span.end ? next.start : span.end;
    if (end > span.start) {
      cues.push({ start: span.start, duration: frames(end - span.start), text: span.text });
    }
  });
  return cues;
}

/**
 * The cues in a run's output object, under whatever the pipeline named them.
 *
 * A pipeline names its own output fields, the same reason `subtitleKeyOf`
 * looks at extensions rather than field names: this one calls them `cues`,
 * another would say `segments` or `transcript`. Those two names are tried
 * first because they are the ones anybody writes; after that every field is
 * offered to the parser, and only a list of things carrying a number, a
 * number and a string can come back from it.
 */
export function cuesInOutput(
  output: Record<string, unknown> | null | undefined,
  rate: Rate,
): Cue[] {
  if (!output) return [];
  for (const name of ['cues', 'segments']) {
    const found = parseWhisperCues(output[name], rate);
    if (found.length) return found;
  }
  for (const value of Object.values(output)) {
    const found = parseWhisperCues(value, rate);
    if (found.length) return found;
  }
  return [];
}
