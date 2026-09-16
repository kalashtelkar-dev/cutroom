/**
 * What the editor supplies to a plan, as opposed to what a plan produces.
 *
 * Three things bind a `$name` and they are worth keeping straight, because a
 * name that none of them sets reaches the API as the literal text `$name` and
 * comes back `input_unreachable`, which has happened on this project three
 * times:
 *
 *   1. the SHELL, which is this list,
 *   2. the card's own questions, whose answers set what they say they set,
 *   3. an EARLIER STEP, whose job result is spread over the bindings.
 *
 * It lives here rather than in the two places that check it, because it was
 * in two places: `scripts/check-cards.ts` and `test/options.test.ts` each had
 * their own copy, and the first card to need a new one would have been failed
 * by whichever copy nobody remembered to edit.
 */

/** Bindings the editor seeds before any step runs. */
export const SHELL_BINDINGS: ReadonlySet<string> = new Set([
  /** The object key the editor has checked is readable. Every file port wants this. */
  'source',
  /** The media pool key it came from, which is not the same string. */
  'sourceMediaKey',
  /**
   * The selected clip's id.
   *
   * Seeded for local timeline ops, and a clip id is NOT a file: a plan that
   * hands this to something expecting footage is refused before it runs.
   */
  'selection',
  'playhead',
  'timeline',
  /** `{use: name}` from VLLM_CONNECTION, for the nodes that need one. */
  'vllmConnection',
]);

/** Bindings a fanout sets on each child, which no step and no answer does. */
export const FANOUT_BINDINGS: ReadonlySet<string> = new Set(['item', 'index']);
