/**
 * Reading a JSON file a pipeline produced.
 *
 * A pipeline hands back object keys, not data. `whisperx/subtitle` writes a
 * `transcript.json` carrying `{segments, word_segments, language}`, and the
 * only way to that data is to sign the key and fetch it. A port is a wire
 * inside a graph, so `segments` is not in the run's reply however much it
 * looks like a field. Without this, a plan can start a
 * transcription and then has nothing to think with.
 *
 * Deliberately its own step kind rather than a flag on `pipeline`. It is a
 * different thing happening: no job, no queue, no cost, and it can fail for
 * reasons a run cannot (a key that will not sign, a file that is not JSON).
 * Naming it means the run card can say "read transcript.json" instead of
 * attributing the wait to the pipeline that had already finished.
 */

export interface OutputFile {
  key: string;
  bytes?: number;
  role?: string;
}

/**
 * Which of a step's outputs to read.
 *
 * `pick` is matched against the end of the key, so ".json" finds
 * `transcript.json` without the card having to know the job id in front of
 * it. With no `pick`, there must be exactly one output: guessing which of
 * three files was meant is how a card silently reads the wrong one.
 */
export function chooseOutput(
  outputs: readonly OutputFile[],
  pick?: string,
): { key: string } | { error: string } {
  const files = outputs.filter((o) => typeof o.key === 'string' && o.key.length > 0);
  if (!files.length) return { error: 'that step produced no files to read' };

  if (!pick) {
    if (files.length === 1) return { key: files[0].key };
    return {
      error: `that step produced ${files.length} files (${files.map((f) => f.key.split('/').pop()).join(', ')}), `
        + 'so the plan has to say which one with "pick"',
    };
  }

  const matched = files.filter((f) => f.key.endsWith(pick));
  if (!matched.length) {
    return {
      error: `no output ends with "${pick}". There is ${files.map((f) => f.key.split('/').pop()).join(', ')}`,
    };
  }
  if (matched.length > 1) {
    return { error: `${matched.length} outputs end with "${pick}", so the plan cannot tell them apart` };
  }
  return { key: matched[0].key };
}

/**
 * An empty file is not an empty answer.
 *
 * `whisperx/subtitle` on a clip with no speech writes a 0 byte `.srt` beside
 * a `.json` that says `{"segments": []}`. Parsing the first as JSON throws,
 * and reporting that as a broken pipeline would be wrong: it ran, and there
 * was nothing in the audio.
 */
export function parseOutput(text: string, key: string): { value: unknown } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { error: `${key.split('/').pop()} is empty, so there was nothing to read` };
  try {
    return { value: JSON.parse(trimmed) };
  } catch (e) {
    return { error: `${key.split('/').pop()} is not JSON: ${(e as Error).message}` };
  }
}
