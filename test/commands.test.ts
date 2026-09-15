import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommands, type Actions } from '../lib/commands/registry.ts';
import { isEnabled, type CommandContext } from '../lib/commands/types.ts';
import { matchShortcut, formatShortcut, shouldHandle } from '../lib/commands/shortcuts.ts';
import { demoProject } from '../lib/fixtures/project.ts';
import { findClip } from '../lib/timeline/document.ts';
import { frames } from '../lib/time/frames.ts';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const noop = () => {};
function actions(): Actions & { calls: string[] } {
  const calls: string[] = [];
  const rec = (name: string) => (...args: unknown[]) => { calls.push(`${name}(${args.map(String).join(',')})`); };
  return {
    calls,
    edit: (ops, label) => calls.push(`edit:${label}`),
    undo: rec('undo'), redo: rec('redo'), seek: rec('seek'),
    job: async () => undefined,
    newProject: rec('new'), open: rec('open'),
    save: async () => { calls.push('save()'); }, saveAs: async () => { calls.push('saveAs()'); },
    importMedia: rec('import'), exportVideo: rec('export'),
    toggleSnapping: rec('snap'), toggleLinked: rec('link'),
    bladeAtPlayhead: rec('blade'), rippleDelete: rec('ripple'),
    addTrack: rec('addTrack'), zoomFit: rec('fit'), zoomIn: rec('in'), zoomOut: rec('out'),
    openWorkbench: rec('workbench'), openJobs: rec('jobs'), selectAll: rec('all'),
    showShortcuts: rec('shortcuts'),
    notify: rec('notify'),
  };
}

function ctx(over: Partial<CommandContext> = {}): CommandContext {
  const timeline = demoProject();
  return {
    timeline, playhead: frames(240), selection: new Set(), selected: null,
    canUndo: false, canRedo: false, undoLabel: null, redoLabel: null,
    savedId: null, dirty: false, busy: false, snapping: true, linked: true,
    ...over,
  };
}

describe('the command registry', () => {
  const commands = buildCommands(actions());

  test('every command has a unique id', () => {
    const ids = commands.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  /**
   * There is no menu bar, so a command with no key needs a control, and the
   * registry cannot see controls.
   *
   * So the ones without a key are named here with where they are clicked
   * instead. The list is the point: it is what stops a new keyless command
   * being added and reaching nothing at all, which under a menu bar was
   * impossible and now is one line of carelessness. A command that appears
   * here has to come and say where it lives.
   */
  test('a command with no key is one with a control, and says which', () => {
    const CLICKED_INSTEAD: Record<string, string> = {
      'clip.enable': 'right-click a clip: ClipContextMenu',
      'timeline.addVideo': 'the + button in the track headers',
      'timeline.addAudio': 'the + button in the track headers',
      'timeline.addSubtitle': 'the + button in the track headers',
      'timeline.linked': "the timeline toolbar's gear",
    };
    const mute = commands.filter((c) => !c.shortcut).map((c) => c.id).sort();
    assert.deepEqual(
      mute,
      Object.keys(CLICKED_INSTEAD).sort(),
      'a command with neither a key nor a named control cannot be run at all',
    );
  });

  test('no two commands claim the same shortcut', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const c of commands) {
      if (!c.shortcut) continue;
      const key = formatShortcut(c.shortcut, true);
      const prev = seen.get(key);
      if (prev) clashes.push(`${key} claimed by both ${prev} and ${c.id}`);
      else seen.set(key, c.id);
    }
    assert.deepEqual(clashes, []);
  });

});

describe('a shortcut that is printed is a shortcut that fires', () => {
  const commands = buildCommands(actions());

  test('the label and the binding come from one object', () => {
    // This is the bug the registry exists to prevent: a toolbar that
    // advertised Cmd Z, Shift Cmd Z and Alt D when nothing bound them.
    for (const c of commands) {
      if (!c.shortcut) continue;
      const printed = formatShortcut(c.shortcut, true);
      assert.ok(printed.length > 0, `${c.id} prints an empty shortcut`);
      const event = {
        key: c.shortcut.key,
        metaKey: Boolean(c.shortcut.mod),
        shiftKey: Boolean(c.shortcut.shift),
        altKey: Boolean(c.shortcut.alt),
      };
      assert.ok(matchShortcut(event, c.shortcut), `${c.id} prints ${printed} but does not match it`);
    }
  });

  test('modifiers are not optional in either direction', () => {
    const save = { key: 's', mod: true };
    assert.ok(matchShortcut({ key: 's', metaKey: true }, save));
    assert.ok(matchShortcut({ key: 's', ctrlKey: true }, save), 'Control on a PC is the same idea');
    assert.ok(!matchShortcut({ key: 's' }, save), 'a bare S must not save');
    assert.ok(!matchShortcut({ key: 's', metaKey: true, shiftKey: true }, save), 'Save As is not Save');
  });

  test('it reads the way the platform writes it', () => {
    assert.equal(formatShortcut({ key: 'z', mod: true, shift: true }, true), '⌘⇧Z');
    assert.equal(formatShortcut({ key: 'z', mod: true, shift: true }, false), 'Ctrl+Shift+Z');
    assert.equal(formatShortcut({ key: 'd', alt: true }, true), '⌥D');
    assert.equal(formatShortcut({ key: 'Backspace' }, true), 'Backspace');
  });
});

describe('typing must not trigger the editor', () => {
  const input = { tagName: 'INPUT' } as unknown as EventTarget;
  const div = { tagName: 'DIV' } as unknown as EventTarget;

  test('a bare key inside a text field belongs to the field', () => {
    // typing "b" into the assistant must not blade the timeline
    assert.equal(shouldHandle({ key: 'b' }, input), false);
    assert.equal(shouldHandle({ key: 'b' }, div), true);
  });

  test('but Cmd S still saves from inside a text field', () => {
    assert.equal(shouldHandle({ key: 's', metaKey: true }, input), true);
  });
});

describe('commands know when they do not apply', () => {
  const commands = buildCommands(actions());
  const find = (id: string) => commands.find((c) => c.id === id)!;

  test('undo says why it is unavailable rather than just being grey', () => {
    const c = find('edit.undo');
    assert.equal(c.disabledReason!(ctx()), 'nothing to undo');
    assert.equal(c.disabledReason!(ctx({ canUndo: true })), null);
  });

  test('ripple delete needs a selection', () => {
    const c = find('edit.delete');
    assert.equal(isEnabled(c, ctx()), false);
    const selected = findClip(demoProject(), 'clp_redrock_talent_3');
    assert.equal(isEnabled(c, ctx({ selected })), true);
  });

  test('export refuses an empty timeline', () => {
    const c = find('file.export');
    assert.equal(isEnabled(c, ctx()), true, 'the demo has clips');
    const empty = demoProject();
    empty.tracks = empty.tracks.map((t) => ({ ...t, items: [] }));
    assert.match(c.disabledReason!(ctx({ timeline: empty }))!, /nothing on the timeline/);
  });

  test('save is never disabled, because an inert Save teaches distrust', () => {
    assert.equal(isEnabled(find('file.save'), ctx({ dirty: false })), true);
  });

  test('a toggle reports its state', () => {
    assert.equal(find('timeline.snapping').checked!(ctx({ snapping: false })), false);
    assert.equal(find('timeline.snapping').checked!(ctx({ snapping: true })), true);
  });
});

describe('running a command does the thing', () => {
  test('each one reaches its action', () => {
    const a = actions();
    const commands = buildCommands(a);
    const run = (id: string, c = ctx()) => commands.find((x) => x.id === id)!.run(c);
    run('edit.undo'); run('clip.blade'); run('timeline.addVideo'); run('view.fit');
    assert.deepEqual(a.calls, ['undo()', 'blade()', 'addTrack(video)', 'fit()']);
  });

  test('toggling a clip emits the patch that undoes itself', () => {
    const a = actions();
    const commands = buildCommands(a);
    const selected = findClip(demoProject(), 'clp_redrock_talent_3');
    commands.find((c) => c.id === 'clip.enable')!.run(ctx({ selected }));
    assert.deepEqual(a.calls, ['edit:Disable clip']);
  });
});

describe('a shortcut has exactly one owner', () => {
  test('no component binds a key the registry already owns', () => {
    // One Cmd Z ran undo twice because the Shell bound it as well as the
    // registry: two entries popped, one committed, and the document and the
    // history stack disagreed from then on.
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    const offenders: string[] = [];
    for (const file of walk(join(root, 'components'))) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes("addEventListener('keydown'")) continue;
      for (const name of ['onUndo()', 'onRedo()', 'onOpenWorkbench()']) {
        if (text.includes(name)) offenders.push(`${relative(root, file)} calls ${name} near a keydown handler`);
      }
    }
    assert.deepEqual(offenders, [], `the registry owns undo, redo and the workbench key`);
  });
});
