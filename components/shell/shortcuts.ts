/**
 * The shell's global keys.
 *
 * A shortcut printed on a tooltip and bound nowhere is worse than no shortcut
 * at all: it is a promise the app breaks every time someone believes it. So
 * the list of chords lives here, one function, and the toolbar's meta strings
 * and the Shell's `keydown` handler both answer to it.
 *
 * Only 'palette' is still consumed by the Shell. Undo, redo and the workbench
 * are on menus, so the command registry owns their keys; binding them here as
 * well made one Cmd Z undo twice.
 *
 * Kept out of the component so it can be tested without a browser.
 */

export type ShellAction = 'palette' | 'undo' | 'redo' | 'workbench';

/** The shape of a KeyboardEvent this needs, so a test can hand it one. */
export interface KeyChord {
  key: string;
  /**
   * The physical key. Alt+D on macOS arrives as key "∂", so a chord with Alt
   * in it has to be read off the hardware or it does not fire on half the
   * machines it is advertised on.
   */
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** True while the keystroke belongs to something the person is typing into. */
export function isTyping(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  return typeof el.tagName === 'string' && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

const letter = (e: KeyChord, ch: string): boolean =>
  e.key.toLowerCase() === ch || e.code === `Key${ch.toUpperCase()}`;

/**
 * Which shell action a keystroke asks for, or null.
 *
 * `typing` suppresses everything except the palette: undo inside a text field
 * is the field's own undo, and stealing it loses what the person typed. The
 * palette chord is exempt because no text field wants Cmd K and the composer
 * is the place you are most likely to reach for it.
 */
export function shellShortcut(e: KeyChord, typing = false): ShellAction | null {
  const mod = !!e.metaKey || !!e.ctrlKey;

  if (mod && !e.altKey && letter(e, 'k')) return 'palette';
  if (typing) return null;
  if (mod && !e.altKey && letter(e, 'z')) return e.shiftKey ? 'redo' : 'undo';
  if (e.altKey && !e.metaKey && !e.ctrlKey && (e.code === 'KeyD' || e.key.toLowerCase() === 'd')) {
    return 'workbench';
  }
  return null;
}
