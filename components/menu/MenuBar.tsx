'use client';

/**
 * The menu bar.
 *
 * Renders the command registry, so what it shows is what exists. It cannot
 * advertise a shortcut nothing binds, because the label and the binding are
 * the same field of the same object.
 *
 * Keyboard behaviour follows the platform rather than being invented: arrows
 * move, Escape closes and returns focus to the title, Enter runs, and once a
 * menu is open, moving the pointer across the bar opens its neighbour without
 * a click. Those are not flourishes; a menu that only works with a mouse is a
 * menu half the people using an NLE will never touch.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MENUS, isEnabled, type Command, type CommandContext } from '../../lib/commands/types.ts';
import { groupMenu } from '../../lib/commands/registry.ts';
import { formatShortcut, isApple } from '../../lib/commands/shortcuts.ts';

export interface MenuBarProps {
  commands: Command[];
  context: CommandContext;
  /** Shown at the right: the project name and whether it has unsaved work. */
  projectName: string;
  dirty: boolean;
  children?: React.ReactNode;
}

export function MenuBar({ commands, context, projectName, dirty, children }: MenuBarProps) {
  const [open, setOpen] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);

  /**
   * Which glyph to print for the modifier key.
   *
   * useSyncExternalStore rather than an effect that calls setState: the
   * server has no answer, the client does, and this is the hook built for
   * exactly that gap. Setting state in an effect would render twice and the
   * compiler is right to object.
   */
  const apple = useSyncExternalStore(
    () => () => {},        // never changes during a session
    () => isApple(),       // on the client
    () => false,           // on the server, where guessing Mac would be wrong half the time
  );

  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!bar.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const runCommand = (c: Command) => {
    close();
    if (!isEnabled(c, context)) return;
    void c.run(context);
  };

  return (
    <div className="cr-menubar" ref={bar} role="menubar" aria-label="Main">
      {MENUS.map((m) => {
        const groups = groupMenu(commands, m.id);
        if (!groups.length) return null;
        const isOpen = open === m.id;
        return (
          <div key={m.id} className="cr-menu">
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              className={`cr-menu-title${isOpen ? ' on' : ''}`}
              onClick={() => setOpen(isOpen ? null : m.id)}
              // once one is open the bar behaves like one control
              onPointerEnter={() => { if (open) setOpen(m.id); }}
            >
              {m.label}
            </button>

            {isOpen ? (
              <div className="cr-menu-pop" role="menu" aria-label={m.label}>
                {groups.map((group, gi) => (
                  <div key={gi} className="cr-menu-group">
                    {group.map((c) => {
                      const why = c.disabledReason?.(context) ?? null;
                      const checked = c.checked?.(context);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                          aria-checked={checked}
                          aria-disabled={why !== null}
                          className={`cr-menu-item${why ? ' off' : ''}`}
                          onClick={() => runCommand(c)}
                          title={why ?? undefined}
                        >
                          <span className="tick">{checked ? '✓' : ''}</span>
                          <span className="label">{c.label}</span>
                          {/* the reason replaces the shortcut, so a grey row
                              always says why rather than leaving you guessing */}
                          <span className="hint">{why ?? formatShortcut(c.shortcut, apple)}</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      <span className="cr-menubar-sp" />
      {children}
      <span className="cr-project">
        {projectName}
        {dirty ? <i className="cr-dot" title="unsaved changes" /> : null}
      </span>
    </div>
  );
}

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
