/**
 * The little numeric field beside each slider.
 *
 * A field that re-formats and clamps on every keystroke cannot be typed into.
 * To reach 0.5 on a control whose minimum is 0.25 you first type "0", which
 * parses to 0, clamps to 0.25 and replaces what you typed before you get to
 * the decimal point; to reach -12 you first type "-", which is not a number
 * at all. So the text is a draft while you are editing it, and it only
 * becomes a value when you say so: Enter, or leaving the field.
 *
 * Held here rather than in the component so the rules can be tested without
 * a DOM, and so every numeric field in the app agrees on them.
 */

export interface NumericBounds {
  min: number;
  max: number;
}

export const clampTo = (v: number, { min, max }: NumericBounds): number =>
  (v < min ? min : v > max ? max : v);

/**
 * The value a draft commits to, or null when it says nothing numeric.
 *
 * `Number`, not `parseFloat`: "12x" is a typo, not 12, and a field that
 * silently keeps the digits it liked from a fumbled paste is worse than one
 * that refuses. A draft that commits to null leaves the value alone.
 */
export function commitDraft(text: string, bounds: NumericBounds): number | null {
  const t = text.trim();
  if (!t) return null;
  const v = Number(t);
  if (!Number.isFinite(v)) return null;
  return clampTo(v, bounds);
}

// ── the field as a state machine ────────────────────────────────────────

export interface FieldState {
  /** What is being typed, or null when the field is showing the value. */
  draft: string | null;
  value: number;
}

export type FieldAction =
  /** A keystroke. Never parsed, never clamped: it is text until it is not. */
  | { t: 'type'; text: string }
  /** Enter, or the field losing focus. */
  | { t: 'commit' }
  /** Escape: the draft never happened. */
  | { t: 'cancel' }
  /** The value changed elsewhere, from the slider or a reset. */
  | { t: 'value'; value: number };

export function nextField(s: FieldState, a: FieldAction, bounds: NumericBounds): FieldState {
  switch (a.t) {
    case 'type':
      return { ...s, draft: a.text };
    case 'commit': {
      if (s.draft === null) return s;
      const v = commitDraft(s.draft, bounds);
      return { draft: null, value: v ?? s.value };
    }
    case 'cancel':
      return { ...s, draft: null };
    case 'value':
      // the outside number is the truth now, so whatever was half-typed goes
      return { draft: null, value: a.value };
  }
}

/** What the field shows: the draft while there is one, the value otherwise. */
export const fieldText = (s: FieldState, format: (v: number) => string): string =>
  s.draft ?? format(s.value);
