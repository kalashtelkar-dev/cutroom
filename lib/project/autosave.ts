/**
 * When to save without being asked.
 *
 * The Save and Save As items went with the File menu, so the project has to
 * keep itself. The scheduling is a timer and the writing is `saveProject`;
 * what lives here is the decision, because the decision is the part with a
 * way to be wrong that nothing would notice.
 *
 * Three rules, and the third is the one that matters.
 *
 *  1. Nothing to save, nothing to do. `dirty` is false the instant a save
 *     lands, so a save cannot trigger the next one.
 *  2. One at a time. A second write while the first is in flight races it,
 *     and the loser is whichever reply arrives second: the document ends up
 *     at a revision the etag no longer matches, and every later save fails.
 *  3. **A conflict stops autosave until a person acts.** `saveProject` sends
 *     the etag of the revision it read, so a 409 means someone else moved
 *     first. Retrying with a fresh etag is not a retry, it is overwriting
 *     their work, and an autosave loop would do it within seconds and keep
 *     doing it. The manual path already refuses to: "Retrying with a fresh
 *     etag would overwrite whoever moved first, so the honest answer is to
 *     stop and say so." A loop that says it every two seconds and does it
 *     anyway would be worse than having no autosave at all.
 */

export type SaveStatus =
  /** Everything on screen is on the server. */
  | 'saved'
  /** Changed, and the timer has not run out yet. */
  | 'waiting'
  /** A write is in flight. */
  | 'saving'
  /** The write failed for a reason that may pass: offline, a 500. */
  | 'failed'
  /** Someone else changed the project. Autosave is off until that is resolved. */
  | 'conflict';

/** How long the document has to sit still before it is written. */
export const AUTOSAVE_MS = 2000;

export interface AutosaveInput {
  dirty: boolean;
  saving: boolean;
  status: SaveStatus;
}

/**
 * Should a save be scheduled right now?
 *
 * `failed` is deliberately not a stop. A failed write is usually the network,
 * the next edit reschedules, and the work is still in the browser either way.
 * `conflict` IS a stop, and only a person can clear it.
 */
export function shouldAutosave({ dirty, saving, status }: AutosaveInput): boolean {
  if (!dirty || saving) return false;
  return status !== 'conflict';
}

/** What to show beside the project name. Null means say nothing at all. */
export function saveLabel(status: SaveStatus): string | null {
  switch (status) {
    case 'saved': return 'Saved';
    case 'waiting': return 'Saving…';
    case 'saving': return 'Saving…';
    case 'failed': return 'Not saved';
    case 'conflict': return 'Changed elsewhere';
  }
}
