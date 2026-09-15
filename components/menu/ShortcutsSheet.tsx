'use client';

/**
 * Every key the app binds, read off the registry that binds them.
 *
 * `help.shortcuts` used to answer with a sentence: "Every shortcut in the app
 * is listed in the menus beside its command." That was true, and then the
 * menus were removed and it became a lie that still ran, still looked like a
 * feature, and pointed at nothing. A command whose whole job is to tell you
 * where to look has to be changed when the place stops existing, so it opens
 * this instead.
 *
 * It matters more than it did. Under a menu bar, a key was a convenience next
 * to a label you could read. Now New, Open and Select All have no control at
 * all, and this sheet is the only place they are written down.
 *
 * Built from `buildCommands`, so it cannot list a binding that does not fire
 * or miss one that does. There is no second list to maintain.
 */
import { useEffect, useRef } from 'react';

import { formatShortcut, isApple } from '../../lib/commands/shortcuts.ts';
import type { Command } from '../../lib/commands/types.ts';

export interface ShortcutsSheetProps {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}

/**
 * The headings, in the order a person would look for them.
 *
 * Keyed off the command id's prefix, which is the grouping the registry
 * already carries. A prefix with no heading here still shows, under its own
 * name: a new command must not be able to fall out of this list silently,
 * which is exactly what a fixed list of sections would let it do.
 */
const SECTIONS: Record<string, string> = {
  file: 'Project and media',
  edit: 'Editing',
  clip: 'Clip',
  timeline: 'Timeline',
  view: 'View',
  help: 'Help',
};

export function ShortcutsSheet({ open, commands, onClose }: ShortcutsSheetProps) {
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => { if (open) box.current?.focus(); }, [open]);

  if (!open) return null;

  const apple = isApple();
  const bound = commands.filter((c) => c.shortcut);
  const order = [...new Set([...Object.keys(SECTIONS), ...bound.map((c) => c.id.split('.')[0])])];

  return (
    <>
      <style href="cutroom-shortcuts" precedence="medium">{CSS}</style>
      <div className="cr-ks" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onPointerDown={onClose}>
        <div
          className="cr-ks-box"
          ref={box}
          tabIndex={-1}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <header>
            <b>Keyboard shortcuts</b>
            <span className="sp" />
            <button type="button" onClick={onClose} aria-label="Close">Esc</button>
          </header>

          <div className="cr-ks-body">
            {order.map((prefix) => {
              const mine = bound.filter((c) => c.id.split('.')[0] === prefix);
              if (!mine.length) return null;
              return (
                <section key={prefix}>
                  <h3>{SECTIONS[prefix] ?? prefix}</h3>
                  {mine.map((c) => (
                    <div className="cr-ks-row" key={c.id}>
                      <span>{c.label.replace(/\.\.\.$/, '')}</span>
                      <kbd>{formatShortcut(c.shortcut, apple)}</kbd>
                    </div>
                  ))}
                </section>
              );
            })}
          </div>

          {/*
            Said here rather than left to be discovered. These three lost their
            menu and gained no button, so this line is the whole of how anyone
            finds out they exist.
          */}
          <p className="cr-ks-note">
            New, Open and Select All have no button anywhere. These keys are the only way to them.
          </p>
        </div>
      </div>
    </>
  );
}

const CSS = `
.cr-ks{
  position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;
  background:rgb(0 0 0 / .55);font-family:var(--ui);padding:24px;
}
.cr-ks-box{
  width:min(560px,100%);max-height:80vh;display:flex;flex-direction:column;
  background:var(--panel);border:1px solid var(--edge);border-radius:8px;
  box-shadow:var(--lift);outline:none;overflow:hidden;
}
.cr-ks-box header{
  display:flex;align-items:center;gap:8px;padding:11px 13px;flex:none;
  border-bottom:1px solid var(--edge);background:var(--panel-2);
}
.cr-ks-box header b{font-size:13px;color:var(--t1)}
.cr-ks-box header .sp{flex:1}
.cr-ks-box header button{
  font:inherit;font-family:var(--mono);font-size:10.5px;color:var(--t3);
  background:var(--edge);border:0;border-radius:4px;padding:3px 7px;cursor:pointer;
}
.cr-ks-body{overflow-y:auto;padding:4px 13px 10px;min-height:0}
.cr-ks-body h3{
  font-size:9.5px;font-weight:700;letter-spacing:.11em;text-transform:uppercase;
  color:var(--t3);margin:14px 0 5px;
}
.cr-ks-row{
  display:flex;align-items:center;gap:12px;padding:4px 0;font-size:12.5px;color:var(--t2);
}
.cr-ks-row span{flex:1;min-width:0}
.cr-ks-row kbd{
  font-family:var(--mono);font-size:11px;color:var(--t1);flex:none;
  background:var(--edge);border-radius:4px;padding:2px 7px;
}
.cr-ks-note{
  margin:0;padding:9px 13px;flex:none;font-size:11.5px;line-height:1.5;color:var(--t3);
  border-top:1px solid var(--edge);background:var(--panel-2);
}
`;
