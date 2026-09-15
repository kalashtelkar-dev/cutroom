/**
 * A B-roll plan, put on the timeline.
 *
 * `broll-b1` returns JSON, not media: a list of cutaways with the words each
 * one covers. A plan nobody can see is not a result, so it lands as markers,
 * which is what a marker is for and is the one thing in this document that
 * means "something goes here" without pretending footage exists yet.
 *
 * The arithmetic is the whole of the risk. **The pipeline counts in the
 * SOURCE file's seconds**, because that is the file it was handed; the
 * timeline counts in frames from its own zero, and the clip in between may
 * start partway into its media and sit anywhere on the track. So a marker is
 *
 *     timeline frame = clip start + (plan seconds at rate) - clip source start
 *
 * and dropping either of the two corrections puts every marker in the wrong
 * place while still looking plausible, which is exactly the class of bug this
 * project keeps writing down. A plan second that maps outside the clip is
 * discarded rather than clamped: a marker pinned to the head of a clip is a
 * lie about where the cutaway goes.
 */
import { addFrames, rangeEnd, secondsToFrames, subFrames, type Frames, type Rate } from '../time/frames.ts';
import type { EditOp, PlacedItem } from '../timeline/types.ts';
import { isClip } from '../timeline/document.ts';

/** One cutaway, as the pipeline writes it. Only the fields we place. */
export interface BrollEntry {
  start: number;
  end: number;
  duration?: number;
  scene?: string;
  quote?: string;
  confidence?: number;
}

export interface BrollPlan {
  broll: BrollEntry[];
  count?: number;
  dropped?: number;
  dropped_reasons?: string[];
}

/**
 * Read the plan out of whatever the run handed back.
 *
 * The field arrives as a JSON string on some runs and as an object on others,
 * so both are accepted. Anything without a `broll` array is refused rather
 * than treated as an empty plan: "the pipeline returned nothing" and "the
 * pipeline planned no cutaways" are different answers and only one of them
 * means the tool worked.
 */
export function readBrollPlan(raw: unknown): BrollPlan | null {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const plan = value as Record<string, unknown>;
  if (!Array.isArray(plan.broll)) return null;
  const broll = plan.broll.filter(
    (e): e is BrollEntry => !!e && typeof e === 'object'
      && typeof (e as BrollEntry).start === 'number'
      && typeof (e as BrollEntry).end === 'number',
  );
  return {
    broll,
    count: typeof plan.count === 'number' ? plan.count : broll.length,
    dropped: typeof plan.dropped === 'number' ? plan.dropped : 0,
    dropped_reasons: Array.isArray(plan.dropped_reasons)
      ? plan.dropped_reasons.filter((r): r is string => typeof r === 'string')
      : [],
  };
}

/** A short label for the marker. The scene if there is one, else the words. */
export function markerName(entry: BrollEntry, index: number): string {
  const text = (entry.scene || entry.quote || '').replace(/\s+/g, ' ').trim();
  const label = text.length > 48 ? `${text.slice(0, 47)}…` : text;
  return label || `B-roll ${index + 1}`;
}

export interface PlacedPlan {
  ops: EditOp[];
  placed: number;
  /** Entries whose source time does not fall inside the clip we placed from. */
  outside: number;
}

/**
 * Markers for a plan, against the clip the pipeline actually read.
 *
 * `newId` is injected rather than generated here so a test can assert on
 * exact ops, and so two runs in one session cannot collide.
 */
export function brollMarkerOps(
  plan: BrollPlan,
  clip: PlacedItem,
  rate: Rate,
  newId: (i: number) => string,
  colour = 'red',
): PlacedPlan {
  if (!isClip(clip.item)) return { ops: [], placed: 0, outside: plan.broll.length };
  const sourceStart = clip.item.sourceRange.start;
  const ops: EditOp[] = [];
  let outside = 0;

  plan.broll.forEach((entry, i) => {
    // source seconds -> source frames -> where that sits inside the clip
    const intoSource = secondsToFrames(Math.max(0, entry.start), rate);
    const intoClip = subFrames(intoSource, sourceStart);
    if (intoClip < 0) { outside += 1; return; }
    const at = addFrames(clip.range.start, intoClip);
    if (at >= rangeEnd(clip.range)) { outside += 1; return; }
    ops.push({
      op: 'add_marker',
      marker: { id: newId(i), at, name: markerName(entry, i), colour },
    });
  });

  return { ops, placed: ops.length, outside };
}

/** What to tell someone the run did, in one line. */
export function brollSummary(plan: BrollPlan, placed: number, outside: number): string {
  if (!plan.broll.length) {
    const why = plan.dropped_reasons?.length ? `, ${plan.dropped_reasons[0]}` : '';
    return plan.dropped
      ? `No cutaways survived the rules: ${plan.dropped} dropped${why}`
      : 'The planner found nothing worth cutting away to';
  }
  const parts = [`${placed} cutaway${placed === 1 ? '' : 's'} marked`];
  if (outside) parts.push(`${outside} outside the clip and skipped`);
  if (plan.dropped) parts.push(`${plan.dropped} dropped by the planner`);
  return parts.join(', ');
}
