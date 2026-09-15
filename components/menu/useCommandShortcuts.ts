'use client';

/**
 * Binding the command registry to the keyboard.
 *
 * This was the bottom of `MenuBar.tsx`. The menu bar itself is gone: File,
 * Edit, Clip, Timeline, View and Help were each either duplicating a control
 * on screen or holding one thing nobody could find, and the things worth
 * reaching now have buttons. What the registry was really for outlived it,
 * which is this: one list of everything the app can do, bound once.
 *
 * A command with no button is NOT unreachable. Every one of them still has
 * its key, which is why deleting the menus did not mean deleting the
 * commands: `Cmd+N`, `Cmd+O` and `Cmd+A` have no affordance on screen and
 * still work, and `help.shortcuts` is the sheet that says so.
 */
import { useEffect, useRef } from 'react';
import { isEnabled, type Command, type CommandContext } from '../../lib/commands/types.ts';

/**
 * Bind every command's shortcut, once.
 *
 * One listener over the registry rather than a handler per component: a
 * shortcut defined in two places is a shortcut that fires twice, and a
 * component that owns a binding takes it away when it unmounts.
 */
export function useCommandShortcuts(
  commands: Command[],
  context: CommandContext,
  matches: (e: KeyboardEvent, c: Command) => boolean,
  allow: (e: KeyboardEvent) => boolean,
): void {
  const latest = useRef({ commands, context });
  // written in an effect, not during render: a ref assignment during render
  // is a side effect, and React may render without committing.
  useEffect(() => { latest.current = { commands, context }; }, [commands, context]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!allow(e)) return;
      const { commands: cmds, context: ctx } = latest.current;
      for (const c of cmds) {
        if (!c.shortcut || !matches(e, c)) continue;
        e.preventDefault();
        if (isEnabled(c, ctx)) void c.run(ctx);
        return;   // first match wins; the registry test forbids duplicates
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [matches, allow]);
}
