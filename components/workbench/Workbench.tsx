'use client';

/**
 * The Tool Caller Workbench.
 *
 * The developer side of Cutroom. The editor's Assistant is where a user says
 * what they want; this is where whoever built the routing tunes what happens
 * next: which card claims which words, what that costs, and whether the edit
 * that fixed one phrase broke two others. Nothing in here touches the user's
 * timeline, and nothing in here calls a mutating editor-API endpoint.
 *
 * It is a full-screen overlay in the same window as the editor, like
 * devtools, opened with Alt+D and closed with Escape. Everything is cyan
 * (var(--wb)) so it is never in doubt which side of the curtain you are on:
 * red means you are editing someone's film, cyan means you are editing the
 * thing that edits the film.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Bench } from './Bench.tsx';
import { IntelEditor } from './IntelEditor.tsx';
import { Evals } from './Evals.tsx';
import { Pipelines } from './Pipelines.tsx';
import { TABS, useWorkbench, type WorkbenchStore, type WorkbenchTab } from './useWorkbench.ts';

export interface WorkbenchProps {
  open: boolean;
  onClose: () => void;
}

export function Workbench({ open, onClose }: WorkbenchProps) {
  const wb = useWorkbench();
  const panel = useRef<HTMLDivElement | null>(null);
  const tabStrip = useRef<HTMLDivElement | null>(null);

  /**
   * Escape closes, and so does the chord that opened it. The listener is on
   * the window rather than the panel because the thing with focus may be a
   * textarea three components down, and a developer hitting Escape means
   * "get me out", not "blur this field".
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e.altKey && e.code === 'KeyD')) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Focus moves into the overlay so a screen reader lands here, and so the
  // first Tab goes to the tabs rather than back to the editor behind them.
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  const onTabKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = TABS.findIndex((t) => t.id === wb.tab);
    const next = TABS[(at + step + TABS.length) % TABS.length];
    wb.setTab(next.id);
    const buttons = tabStrip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[TABS.indexOf(next)]?.focus();
  }, [wb]);

  if (!open) return null;

  return (
    <>
      <style href="cutroom-workbench" precedence="medium">{CSS}</style>
      <div
        className="wb-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Tool Caller Workbench"
        tabIndex={-1}
        ref={panel}
      >
        <header className="wb-head">
          <span className="wb-brand"><i />Tool Caller Workbench</span>
          <div className="wb-tabs" role="tablist" aria-label="Workbench sections" ref={tabStrip} onKeyDown={onTabKey}>
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`wb-tab-${t.id}`}
                aria-selected={wb.tab === t.id}
                aria-controls={`wb-pane-${t.id}`}
                tabIndex={wb.tab === t.id ? 0 : -1}
                className="wb-tab"
                onClick={() => wb.setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="wb-grow" />
          {wb.status ? <span className="wb-status" role="status">{wb.status}</span> : null}
          <span className="wb-kbd">Alt+D</span>
          <button type="button" className="wb-close" onClick={onClose} aria-label="Close the workbench, Escape">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="wb-body">
          {TABS.map((t) => (
            <div
              key={t.id}
              className="wb-pane"
              id={`wb-pane-${t.id}`}
              role="tabpanel"
              aria-labelledby={`wb-tab-${t.id}`}
              hidden={wb.tab !== t.id}
            >
              <Pane tab={t.id} wb={wb} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * Every pane stays mounted and hidden rather than unmounting.
 *
 * A graph you just built and a ranking you just ran are expensive to look at
 * again and free to keep; losing them on a tab switch would make the tabs
 * feel like four pages instead of one tool.
 */
function Pane({ tab, wb }: { tab: WorkbenchTab; wb: WorkbenchStore }) {
  if (tab === 'bench') return <Bench wb={wb} />;
  if (tab === 'intel') return <IntelEditor wb={wb} />;
  if (tab === 'evals') return <Evals wb={wb} />;
  return <Pipelines wb={wb} />;
}

const CSS = `
.wb-overlay{
  position:fixed;inset:0;z-index:100;background:var(--panel);color:var(--t1);
  display:flex;flex-direction:column;font-family:var(--ui);
}
.wb-overlay:focus{outline:none}
.wb-head{
  height:42px;flex:none;display:flex;align-items:center;gap:10px;padding:0 10px 0 12px;
  background:var(--head);border-bottom:1px solid var(--edge);
}
.wb-brand{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;white-space:nowrap}
.wb-brand i{width:7px;height:14px;border-radius:1px;background:var(--wb);display:block;flex:none}
.wb-tabs{display:flex;gap:4px;margin-left:6px}
.wb-tab{
  padding:6px 13px;font-size:12px;font-weight:600;color:var(--t3);border:0;border-radius:4px;
  background:none;cursor:pointer;font-family:inherit;white-space:nowrap;
}
.wb-tab:hover{color:var(--t2);background:var(--panel-2)}
.wb-tab[aria-selected="true"]{background:var(--wb);color:var(--app)}
.wb-grow{flex:1}
.wb-status{font-size:11px;color:var(--wb);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38ch}
.wb-kbd{
  font-family:var(--mono);font-size:10px;color:var(--t3);
  border:1px solid var(--edge-soft);padding:2px 6px;border-radius:4px;
}
.wb-close{
  width:26px;height:24px;border:0;border-radius:4px;background:none;color:var(--t2);
  display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none;
}
.wb-close svg{width:13px;height:13px;display:block}
.wb-close:hover{background:var(--edge);color:var(--t1)}

.wb-body{flex:1;min-height:0;overflow:hidden}
.wb-pane{display:flex;height:100%;min-height:0}
.wb-pane[hidden]{display:none}

.wb-col{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.wb-col + .wb-col{border-left:1px solid var(--edge)}
.wb-sec{
  padding:8px 12px;flex:none;display:flex;align-items:center;gap:8px;
  font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--t3);background:var(--app);border-bottom:1px solid var(--edge);
}
.wb-sec b{
  color:var(--wb);font-weight:500;letter-spacing:0;text-transform:none;font-size:10.5px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.wb-sec .wb-grow{flex:1}
.wb-scroll{flex:1;overflow-y:auto;min-height:0}

.wb-btn{
  font-family:inherit;font-size:11.5px;font-weight:600;padding:5px 12px;border-radius:4px;
  border:1px solid var(--edge-soft);background:none;color:var(--t2);cursor:pointer;white-space:nowrap;
}
.wb-btn:hover:not(:disabled){border-color:var(--wb);color:var(--t1)}
.wb-btn:disabled{opacity:.4;cursor:not-allowed}
.wb-btn.pri{background:var(--wb);border-color:var(--wb);color:var(--app)}
.wb-btn.pri:hover:not(:disabled){filter:brightness(1.14)}
.wb-btn.sm{padding:2px 9px;font-size:11px}
.wb-chk{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--t2);cursor:pointer}
.wb-chk input{accent-color:var(--wb);width:13px;height:13px}
.wb-sel{
  background:var(--app);border:1px solid var(--edge-soft);border-radius:4px;color:var(--t1);
  font-family:var(--mono);font-size:10.5px;padding:3px 5px;max-width:170px;
}
.wb-input{
  background:var(--app);border:1px solid var(--edge-soft);border-radius:4px;color:var(--t1);
  font-family:var(--ui);font-size:12.5px;padding:7px 9px;
}
.wb-input:focus{outline:none;border-color:var(--wb)}
.wb-empty{padding:18px 14px;color:var(--t3);font-size:11.5px;line-height:1.6;text-align:center}
.wb-note{
  padding:8px 12px;font-size:11.5px;line-height:1.5;color:var(--t2);
  border-bottom:1px solid var(--edge);
}
.wb-note b{color:var(--t1)}
.wb-note.wbb{background:var(--wb-wash);border-left:2px solid var(--wb)}
.wb-note.warn{
  background:color-mix(in srgb, var(--yellow) 9%, transparent);border-left:2px solid var(--yellow);
}
.wb-note.bad{
  background:color-mix(in srgb, var(--red) 9%, transparent);border-left:2px solid var(--red);
}
.wb-chip{
  font-family:var(--mono);font-size:9.5px;padding:1px 6px;border-radius:4px;flex:none;
  background:var(--edge);color:var(--t2);
}
.wb-chip.on{background:var(--wb-dim);color:var(--t1)}
.wb-chip.bad{background:color-mix(in srgb, var(--red) 22%, transparent);color:var(--red)}
.wb-mono{font-family:var(--mono);font-size:10.5px;font-variant-numeric:tabular-nums}
.wb-linkbtn{
  border:0;background:none;padding:0;margin:0;font:inherit;color:inherit;text-align:left;
  cursor:pointer;width:100%;
}
.wb-linkbtn:hover{color:var(--wb)}
`;
