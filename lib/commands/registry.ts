/**
 * Every command the application has.
 *
 * One list. The menu bar renders it, the keyboard binds it, and the toolbar
 * calls into it, so a shortcut printed beside a menu item is the shortcut that
 * fires. Nothing can advertise a binding that does not exist, because the
 * label and the binding are the same field of the same object.
 *
 * `run` receives an `Actions` bag rather than reaching for application state:
 * the registry stays pure and testable, and the page decides what "save"
 * actually means.
 */
import type { Command, CommandContext } from './types.ts';
import type { EditOp } from '../timeline/types.ts';
import { frames } from '../time/frames.ts';

/**
 * What a command is allowed to do.
 *
 * Deliberately small. A command that needs something not on this list is a
 * command that wants to reach around the document, which is how a second
 * source of truth gets started.
 */
export interface Actions {
  edit(ops: EditOp[], label: string): void;
  undo(): void;
  redo(): void;
  seek(to: number): void;
  /** Anything that talks to the server: it runs as a job and keeps a log. */
  job(kind: string, label: string, body: () => Promise<unknown>): Promise<unknown>;
  newProject(): void;
  open(): void;
  save(): Promise<void>;
  saveAs(): Promise<void>;
  importMedia(): void;
  exportVideo(): void;
  toggleSnapping(): void;
  toggleLinked(): void;
  bladeAtPlayhead(): void;
  rippleDelete(): void;
  addTrack(kind: 'video' | 'audio' | 'subtitle'): void;
  zoomFit(): void;
  zoomIn(): void;
  zoomOut(): void;
  openWorkbench(): void;
  openJobs(): void;
  selectAll(): void;
  notify(message: string): void;
}

const needsSelection = (ctx: CommandContext) =>
  ctx.selected ? null : 'select a clip first';

const needsSaved = (ctx: CommandContext) =>
  ctx.savedId ? null : 'this project has not been saved yet';

export function buildCommands(a: Actions): Command[] {
  return [
    // ── File ────────────────────────────────────────────────────────────
    { id: 'file.new', label: 'New Project', menu: 'file', group: 'project',
      shortcut: { key: 'n', mod: true },
      run: () => a.newProject() },
    { id: 'file.open', label: 'Open Project...', menu: 'file', group: 'project',
      shortcut: { key: 'o', mod: true },
      run: () => a.open() },
    { id: 'file.save', label: 'Save', menu: 'file', group: 'project',
      shortcut: { key: 's', mod: true },
      // Save is never disabled on a clean project: people press it to be sure,
      // and an inert Save teaches them the app is unreliable.
      run: () => a.save() },
    { id: 'file.saveAs', label: 'Save As...', menu: 'file', group: 'project',
      shortcut: { key: 's', mod: true, shift: true },
      run: () => a.saveAs() },

    { id: 'file.import', label: 'Import Media...', menu: 'file', group: 'media',
      shortcut: { key: 'i', mod: true },
      run: () => a.importMedia() },
    { id: 'file.export', label: 'Export Video...', menu: 'file', group: 'media',
      shortcut: { key: 'e', mod: true },
      disabledReason: (ctx) =>
        ctx.timeline.tracks.some((t) => t.items.some((i) => i.kind === 'clip'))
          ? null : 'there is nothing on the timeline to export',
      run: () => a.exportVideo() },

    { id: 'file.jobs', label: 'Jobs and Logs', menu: 'file', group: 'inspect',
      shortcut: { key: 'j', mod: true, shift: true },
      run: () => a.openJobs() },

    // ── Edit ────────────────────────────────────────────────────────────
    { id: 'edit.undo', label: 'Undo', menu: 'edit', group: 'history',
      shortcut: { key: 'z', mod: true },
      disabledReason: (ctx) => (ctx.canUndo ? null : 'nothing to undo'),
      run: () => a.undo() },
    { id: 'edit.redo', label: 'Redo', menu: 'edit', group: 'history',
      shortcut: { key: 'z', mod: true, shift: true },
      disabledReason: (ctx) => (ctx.canRedo ? null : 'nothing to redo'),
      run: () => a.redo() },

    { id: 'edit.selectAll', label: 'Select All', menu: 'edit', group: 'select',
      shortcut: { key: 'a', mod: true },
      run: () => a.selectAll() },

    { id: 'edit.delete', label: 'Ripple Delete', menu: 'edit', group: 'destructive',
      shortcut: { key: 'Backspace' },
      disabledReason: needsSelection,
      run: () => a.rippleDelete() },

    // ── Clip ────────────────────────────────────────────────────────────
    { id: 'clip.blade', label: 'Blade at Playhead', menu: 'clip', group: 'cut',
      shortcut: { key: 'b' },
      run: () => a.bladeAtPlayhead() },
    { id: 'clip.enable', label: 'Enable Clip', menu: 'clip', group: 'state',
      disabledReason: needsSelection,
      checked: (ctx) => (ctx.selected?.item.kind === 'clip' ? ctx.selected.item.enabled : false),
      run: (ctx) => {
        const item = ctx.selected?.item;
        if (!item || item.kind !== 'clip') return;
        a.edit([{ op: 'patch_clip', clipId: item.id, set: { enabled: !item.enabled } }],
          item.enabled ? 'Disable clip' : 'Enable clip');
      } },

    // ── Timeline ────────────────────────────────────────────────────────
    { id: 'timeline.addVideo', label: 'Add Video Track', menu: 'timeline', group: 'tracks',
      run: () => a.addTrack('video') },
    { id: 'timeline.addAudio', label: 'Add Audio Track', menu: 'timeline', group: 'tracks',
      run: () => a.addTrack('audio') },
    { id: 'timeline.addSubtitle', label: 'Add Subtitle Track', menu: 'timeline', group: 'tracks',
      run: () => a.addTrack('subtitle') },

    { id: 'timeline.snapping', label: 'Snapping', menu: 'timeline', group: 'toggles',
      shortcut: { key: 'n' },
      checked: (ctx) => ctx.snapping,
      run: () => a.toggleSnapping() },
    { id: 'timeline.linked', label: 'Linked Selection', menu: 'timeline', group: 'toggles',
      checked: (ctx) => ctx.linked,
      run: () => a.toggleLinked() },

    { id: 'timeline.start', label: 'Go to Start', menu: 'timeline', group: 'move',
      shortcut: { key: 'Home' },
      run: () => a.seek(0) },
    { id: 'timeline.marker', label: 'Add Marker', menu: 'timeline', group: 'move',
      shortcut: { key: 'm' },
      run: (ctx) => a.edit(
        [{ op: 'add_marker', marker: { id: `mk_${ctx.playhead}`, at: frames(ctx.playhead), name: '', colour: 'var(--orange)' } }],
        'Add marker') },

    // ── View ────────────────────────────────────────────────────────────
    { id: 'view.fit', label: 'Zoom to Fit', menu: 'view', group: 'zoom',
      shortcut: { key: 'z', shift: true },
      run: () => a.zoomFit() },
    { id: 'view.zoomIn', label: 'Zoom In', menu: 'view', group: 'zoom',
      shortcut: { key: '=', mod: true },
      run: () => a.zoomIn() },
    { id: 'view.zoomOut', label: 'Zoom Out', menu: 'view', group: 'zoom',
      shortcut: { key: '-', mod: true },
      run: () => a.zoomOut() },

    { id: 'view.workbench', label: 'Tool Caller Workbench', menu: 'view', group: 'panels',
      shortcut: { key: 'd', alt: true },
      run: () => a.openWorkbench() },

    // ── Help ────────────────────────────────────────────────────────────
    { id: 'help.shortcuts', label: 'Keyboard Shortcuts', menu: 'help', group: 'about',
      shortcut: { key: '/', mod: true },
      run: () => a.notify('Every shortcut in the app is listed in the menus beside its command.') },
  ];
}

/** Commands for one menu, in declaration order, grouped for separators. */
export function groupMenu(commands: Command[], menu: string): Command[][] {
  const mine = commands.filter((c) => c.menu === menu);
  const out: Command[][] = [];
  let current: Command[] = [];
  let group: string | null = null;
  for (const c of mine) {
    if (group !== null && c.group !== group) { out.push(current); current = []; }
    group = c.group;
    current.push(c);
  }
  if (current.length) out.push(current);
  return out;
}
