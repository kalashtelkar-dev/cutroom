/**
 * Finding the subtitle file in a run's output.
 *
 * A pipeline names its own output fields, so there is no field called
 * "subtitles" to rely on: `tpl_U3GJUhH92LC_` calls it `subtitles`, another
 * might call it `captions` or `files`, and each holds either one key or a
 * list of them. What is reliable is the extension, because the format is the
 * thing that makes a file readable as cues.
 *
 * `.srt` before `.vtt`, because a pipeline asked for several formats returns
 * all of them and the parser here is written for SRT first. `.json` is
 * deliberately not in the list: whisperx writes one, and it is a different
 * shape that `read-json` handles.
 */

const SUBTITLE_EXT = ['.srt', '.vtt'];

const keysIn = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
};

/** The first subtitle file in a run's output object, or null. */
export function subtitleKeyOf(output: Record<string, unknown> | null | undefined): string | null {
  if (!output) return null;
  const all = Object.values(output).flatMap(keysIn);
  for (const ext of SUBTITLE_EXT) {
    const hit = all.find((k) => k.toLowerCase().endsWith(ext));
    if (hit) return hit;
  }
  return null;
}
