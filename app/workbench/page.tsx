'use client';

/**
 * The workbench on its own route.
 *
 * In the editor it is an overlay over someone's film, opened with Alt+D like
 * devtools. Here there is no film underneath, which makes it the page to
 * leave open on a second monitor while tuning the routing, and the page to
 * send someone who has never seen the thing.
 */

import { useCallback, useState } from 'react';
import { Workbench } from '@/components/workbench/Workbench.tsx';
import { useWorkbenchHotkey } from '@/components/workbench/useWorkbench.ts';

export default function WorkbenchPage() {
  const [open, setOpen] = useState(true);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  useWorkbenchHotkey(toggle);

  return (
    <>
      <style href="cutroom-workbench-page" precedence="medium">{CSS}</style>
      <Workbench open={open} onClose={() => setOpen(false)} />
      {open ? null : (
        <main className="wbx-shut">
          <h1>Tool Caller Workbench</h1>
          <p>
            Closed. There is no editor behind this route, so Escape leaves you here
            rather than back at a timeline.
          </p>
          <button type="button" className="wbx-reopen" onClick={() => setOpen(true)}>
            Reopen, or press Alt+D
          </button>
          <p className="wbx-links">
            The editor is at <a href="/edit">/edit</a>, where the same overlay opens over the cut.
          </p>
        </main>
      )}
    </>
  );
}

const CSS = `
.wbx-shut{
  height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:12px;padding:24px;text-align:center;font-family:var(--ui);background:var(--app);
}
.wbx-shut h1{margin:0;font-size:17px;font-weight:700;color:var(--t1)}
.wbx-shut p{margin:0;max-width:46ch;font-size:12.5px;line-height:1.6;color:var(--t2)}
.wbx-reopen{
  font-family:inherit;font-size:12px;font-weight:600;padding:7px 15px;border-radius:4px;
  border:1px solid var(--wb);background:var(--wb);color:var(--app);cursor:pointer;
}
.wbx-reopen:hover{filter:brightness(1.14)}
.wbx-links{font-size:11.5px;color:var(--t3)}
.wbx-links a{color:var(--wb)}
`;
