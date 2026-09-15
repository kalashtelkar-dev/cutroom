/**
 * Commands.
 *
 * One object per thing the application can do. The menu renders it, the
 * keyboard binds it, and the toolbar buttons call it, so a shortcut printed
 * next to a menu item is the shortcut that actually fires. That is not a
 * nicety: the review of the first build found a toolbar advertising Cmd Z,
 * Shift Cmd Z and Alt D when nothing in the app bound any of them. A registry
 * makes that class of lie impossible rather than unlikely.
 *
 * `enabled` and `checked` are predicates over a context rather than stored
 * flags, because the answer changes with the selection and the playhead and
 * there is no moment at which it would be correct to cache it.
 */
import type { Timeline, PlacedItem, ClipId } from '../timeline/types.ts';
import type { Frames } from '../time/frames.ts';

export interface Shortcut {
  /** A KeyboardEvent.key value, compared case-insensitively. */
  key: string;
  /** Command on a Mac, Control elsewhere. One flag, because it is one idea. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** Everything a command needs to decide whether it applies, and to do its job. */
export interface CommandContext {
  timeline: Timeline;
  playhead: Frames;
  selection: ReadonlySet<ClipId>;
  selected: PlacedItem | null;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** True once the project has a home on the server to save back to. */
  savedId: string | null;
  dirty: boolean;
  busy: boolean;
  snapping: boolean;
  linked: boolean;
}

export interface Command {
  id: string;
  label: string;
  /**
   * What kind of thing it is. It grouped the menu items and drew the rules
   * between them; with the menus gone it is what the command palette sorts
   * on, and it is worth keeping for that alone: "destructive things apart
   * from safe ones" is a fact about the command, not about a menu.
   */
  group: string;
  shortcut?: Shortcut;
  /** Why it is unavailable, shown in place of the shortcut. Null means fine. */
  disabledReason?: (ctx: CommandContext) => string | null;
  /** For toggles. Undefined means the item is not a toggle. */
  checked?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void | Promise<void>;
}

export const isEnabled = (c: Command, ctx: CommandContext): boolean =>
  c.disabledReason ? c.disabledReason(ctx) === null : true;
