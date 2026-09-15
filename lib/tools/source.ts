/**
 * What a pipeline tool is pointed at.
 *
 * A rung 3 tool runs a published pipeline, and a pipeline reads ONE file. The
 * tool rail offers a target in the shell's own words ("Whole timeline",
 * "Selected clip, ..."), and something has to turn that phrase into an object
 * key the API can open. That is all this does, and it is separate from the
 * page because it is the part with rules in it.
 *
 * Two things it refuses to guess.
 *
 * A timeline cutting between several source files is not one file, so
 * "Whole timeline" has no single answer and the honest reply is to say which
 * files it found and ask for a clip. Picking the first would analyse footage
 * the user did not point at and bill them for it.
 *
 * And an empty selection is not the whole timeline. A target naming the
 * selected clip with nothing selected is a refusal, not a fallback, because
 * the fallback would silently run over something else.
 *
 * The times a pipeline hands back are in the SOURCE file's own seconds, not
 * timeline seconds. A clip trimmed from the middle of its media will get a
 * plan whose numbers do not line up with where that clip sits on the
 * timeline; `sourceOffset` is that difference, so a caller can say so.
 */
import { isClip } from '../timeline/document.ts';
import type { MediaRef, PlacedItem, Timeline } from '../timeline/types.ts';
import type { Frames } from '../time/frames.ts';

export interface ToolSource {
  /** The object key to hand the pipeline, best first. */
  key: string;
  /**
   * The other key for the same footage, tried when the first is gone.
   *
   * A project outlives the objects it points at. Uploads land under a dated
   * prefix (`input/2026-09-14/...`) and a proxy is a job output, so either can
   * be swept while the document still names both. Both shapes were confirmed
   * readable when they exist, so a failure to read one is about that object
   * and not about its kind, which is exactly when trying the other is worth a
   * second of cpu.
   */
  fallbackKey?: string;
  /** The media pool key it came from, which is not the same string. */
  mediaKey: string;
  name: string;
  /**
   * Frames between the start of the source file and the start of what the
   * user pointed at, so a plan in source time can be read against the cut.
   */
  sourceOffset: Frames;
  /** True when a proxy stood in for the original. */
  viaProxy: boolean;
}

export interface SourceRefusal { error: string }

const isSelectionTarget = (target: string): boolean => /^selected clip/i.test(target.trim());

/**
 * The key to send.
 *
 * The proxy when there is one: it is an mp4 the API wrote itself, with aac
 * audio and a moov atom at the front, where the original is whatever the
 * person happened to upload. Both carry the same running time.
 */
const keyFor = (m: MediaRef): { key: string; fallbackKey?: string; viaProxy: boolean } =>
  m.proxy
    ? { key: m.proxy, fallbackKey: m.key === m.proxy ? undefined : m.key, viaProxy: true }
    : { key: m.key, viaProxy: false };

/** Every distinct video media used by a track that is switched on. */
function videoMediaOnTimeline(timeline: Timeline): MediaRef[] {
  const seen = new Map<string, MediaRef>();
  for (const track of timeline.tracks) {
    if (track.kind !== 'video' || !track.enabled) continue;
    for (const item of track.items) {
      if (!isClip(item) || !item.enabled) continue;
      const media = timeline.media[item.mediaKey];
      if (media && media.kind === 'video' && !seen.has(media.key)) seen.set(media.key, media);
    }
  }
  return [...seen.values()];
}

export function resolveToolSource(
  timeline: Timeline,
  selected: PlacedItem | null,
  target: string,
): ToolSource | SourceRefusal {
  if (isSelectionTarget(target)) {
    if (!selected || !isClip(selected.item)) {
      return { error: 'that target is the selected clip, and nothing is selected' };
    }
    const media = timeline.media[selected.item.mediaKey];
    if (!media) {
      return { error: `"${selected.item.name}" points at media the project does not carry` };
    }
    if (media.kind !== 'video') {
      return { error: `"${media.name}" is ${media.kind}, and this tool reads a video` };
    }
    const { key, fallbackKey, viaProxy } = keyFor(media);
    return {
      key, fallbackKey, viaProxy, mediaKey: media.key, name: media.name,
      sourceOffset: selected.item.sourceRange.start,
    };
  }

  const found = videoMediaOnTimeline(timeline);
  if (!found.length) {
    return { error: 'there is no video on the timeline for this tool to read' };
  }
  if (found.length > 1) {
    const names = found.slice(0, 3).map((m) => `"${m.name}"`).join(', ');
    const more = found.length > 3 ? `, and ${found.length - 3} more` : '';
    return {
      error: `this tool reads one file and the timeline cuts between ${found.length}`
        + ` (${names}${more}). Select the clip you mean and run it on that.`,
    };
  }
  const media = found[0];
  const { key, fallbackKey, viaProxy } = keyFor(media);
  return {
    key, fallbackKey, viaProxy, mediaKey: media.key, name: media.name,
    sourceOffset: media.available.start,
  };
}

export const isRefusal = (r: ToolSource | SourceRefusal): r is SourceRefusal => 'error' in r;
