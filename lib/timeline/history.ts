/**
 * Undo, over batches.
 *
 * The unit is a batch, never an op. A model run that trims forty clips, adds a
 * track and burns subtitles is ONE entry called "tighten the cut", and one
 * press of undo puts the timeline back where it was. An op-level stack would
 * make the user press undo forty-two times to escape a result they disliked,
 * which is the whole reason the editor API applies a batch as one revision.
 *
 * `undo` and `redo` take the function that applies a batch instead of handing
 * the ops back, because the redo batch does not exist until the undo has
 * actually been applied: it IS the inverse of the inverse, and only the caller
 * that owns the document can produce it. Passing the applier in is the only
 * shape where a caller cannot forget to record it and quietly lose redo. If
 * the applier throws (a batch that no longer fits the document it is being
 * applied to), the entry goes back on the stack and nothing is lost.
 */
import type { EditOp } from './types.ts';

/** Applies a batch to the document and returns the batch that undoes it. */
export type ApplyBatch = (ops: EditOp[]) => EditOp[];

export interface HistoryEntry {
  label: string;
  ops: EditOp[];
}

export interface History {
  /** Record a batch that has already been applied, by the ops that undo it. */
  push(label: string, inverse: EditOp[], coalesce?: boolean): void;
  /** Undo one batch. Returns its label, or null if there is nothing to undo. */
  undo(apply: ApplyBatch): string | null;
  redo(apply: ApplyBatch): string | null;
  clear(): void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Newest first, which is the order a menu lists them in. */
  readonly labels: { undo: string[]; redo: string[] };
}

/**
 * Deep enough that nobody reaches the end of it in a session, shallow enough
 * that a long AI session does not pin every intermediate document in memory:
 * an entry can carry whole track snapshots.
 */
export const HISTORY_LIMIT = 100;

export function createHistory(limit: number = HISTORY_LIMIT): History {
  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];

  const cap = (stack: HistoryEntry[]) => {
    while (stack.length > limit) stack.shift();
  };

  const step = (from: HistoryEntry[], to: HistoryEntry[], apply: ApplyBatch): string | null => {
    const entry = from.pop();
    if (!entry) return null;
    let reverse: EditOp[];
    try {
      reverse = apply(entry.ops);
    } catch (err) {
      // the document refused the batch, so the stack must look untouched
      from.push(entry);
      throw err;
    }
    to.push({ label: entry.label, ops: reverse });
    cap(to);
    return entry.label;
  };

  return {
    push(label, inverse, coalesce = false) {
      const top = undoStack[undoStack.length - 1];
      if (coalesce && top && top.label === label) {
        // Keep the OLD inverse. It returns to where the run of changes began,
        // which is what one press of undo has to do after a drag. Replacing
        // it with the new one would undo only the final pixel.
        redoStack.length = 0;
        return;
      }
      undoStack.push({ label, ops: [...inverse] });
      cap(undoStack);
      // a new edit after an undo abandons the branch that was undone, as it
      // must: those ops describe a document that no longer exists
      redoStack.length = 0;
    },
    undo: (apply) => step(undoStack, redoStack, apply),
    redo: (apply) => step(redoStack, undoStack, apply),
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
    },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    get labels() {
      return {
        undo: undoStack.map((e) => e.label).reverse(),
        redo: redoStack.map((e) => e.label).reverse(),
      };
    },
  };
}
