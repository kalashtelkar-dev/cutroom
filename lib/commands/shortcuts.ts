/**
 * Matching and printing shortcuts.
 *
 * Printing and matching come from the same `Shortcut`, so a label can never
 * drift from the binding. `mod` is one flag rather than separate meta and
 * ctrl, because "the modifier key" is one idea that renders differently.
 */
import type { Shortcut } from './types.ts';

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * Apple platforms use Command, everything else uses Control.
 *
 * Read from the browser when there is one. On the server there is no answer,
 * and guessing Mac would print the wrong glyph to half of all readers, so the
 * caller passes what it knows and the default is the neutral one.
 */
export function isApple(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function matchShortcut(e: KeyLike, s: Shortcut | undefined): boolean {
  if (!s) return false;
  if (e.key.toLowerCase() !== s.key.toLowerCase()) return false;
  const mod = Boolean(e.metaKey || e.ctrlKey);
  if (Boolean(s.mod) !== mod) return false;
  if (Boolean(s.shift) !== Boolean(e.shiftKey)) return false;
  if (Boolean(s.alt) !== Boolean(e.altKey)) return false;
  return true;
}

const NAMED: Record<string, string> = {
  arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓',
  ' ': 'Space', enter: 'Enter', backspace: 'Backspace', delete: 'Del',
  escape: 'Esc', home: 'Home', end: 'End', tab: 'Tab',
};

export function formatShortcut(s: Shortcut | undefined, apple = isApple()): string {
  if (!s) return '';
  const parts: string[] = [];
  if (s.mod) parts.push(apple ? '⌘' : 'Ctrl');
  if (s.alt) parts.push(apple ? '⌥' : 'Alt');
  if (s.shift) parts.push(apple ? '⇧' : 'Shift');
  const k = s.key.toLowerCase();
  parts.push(NAMED[k] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key));
  return apple ? parts.join('') : parts.join('+');
}

/**
 * Whether a keystroke should reach the application at all.
 *
 * Typing "b" into the assistant must not blade the timeline. An unmodified
 * key inside a text field belongs to the field; a modified one (Cmd S) is
 * still the application's, because that is what every editor does.
 */
export function shouldHandle(e: KeyLike, target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return true;
  const tag = el.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  if (!typing) return true;
  return Boolean(e.metaKey || e.ctrlKey);
}
