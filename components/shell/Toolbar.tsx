'use client';

/**
 * The interface toolbar.
 *
 * Panel toggles on the left, history in the middle, the project on the right.
 * The undo button names what it will undo, because an AI run lands as ONE
 * revision and one undo reverses the whole run, "Undo" alone does not tell
 * you whether you are about to lose a nudge or four minutes of pipeline.
 */

import { tip } from '../ui/Tooltip.tsx';
import { rateLabel, type Rate } from '@/lib/time/frames.ts';

export type PanelId = 'assistant' | 'pool' | 'inspector';

export interface ToolbarProps {
  projectName: string;
  rate: Rate;
  /**
   * Shown beside the frame rate when the owner knows it. There is no
   * resolution on the `Timeline` document yet, so the chrome says nothing
   * rather than inventing a number: the rate next to it is real, and one
   * true fact beside one invented one makes both unreadable.
   */
  resolution?: string;
  revision: number;
  /** Which panels are on screen. `pool` and `assistant` share one column. */
  active: Record<PanelId, boolean>;
  onTogglePanel: (id: PanelId) => void;
  onOpenPalette: () => void;
  onOpenWorkbench?: () => void;
  /** What undo/redo would do next, or null when the stack is empty. */
  undoLabel?: string | null;
  redoLabel?: string | null;
  onUndo?: () => void;
  onRedo?: () => void;
  historyDepth?: { undo: number; redo: number };
}

export function Toolbar({
  projectName,
  rate,
  resolution,
  revision,
  active,
  onTogglePanel,
  onOpenPalette,
  onOpenWorkbench,
  undoLabel = null,
  redoLabel = null,
  onUndo,
  onRedo,
  historyDepth = { undo: 0, redo: 0 },
}: ToolbarProps) {
  return (
    <>
      <style href="cutroom-toolbar" precedence="medium">{CSS}</style>
      <header className="cr-iface">
        <div className="cr-brand"><i aria-hidden="true" /><span>Cutroom</span></div>

        <PanelBtn
          on={active.assistant}
          label="Assistant"
          tipText="Say what you want done. The router picks the tool whose card claims your words."
          onClick={() => onTogglePanel('assistant')}
        >
          <path d="M14 9.5a2 2 0 01-2 2H6l-3.5 2.5V4a2 2 0 012-2h7.5a2 2 0 012 2z" />
        </PanelBtn>

        <PanelBtn
          on={active.pool}
          label="Media Pool"
          tipText="Everything this project can cut from."
          onClick={() => onTogglePanel('pool')}
        >
          <rect x="1.5" y="3" width="13" height="10" rx="1" />
          <path d="M1.5 6h13M5 3v10" />
        </PanelBtn>

        <PanelBtn
          on={false}
          label="Tools"
          tipText="Every timeline op, operation and pipeline in one searchable list."
          meta="Cmd / Ctrl + K"
          onClick={onOpenPalette}
        >
          <rect x="2" y="2" width="5" height="5" rx="1" />
          <rect x="9" y="2" width="5" height="5" rx="1" />
          <rect x="2" y="9" width="5" height="5" rx="1" />
          <path d="M11.5 9.5v4M9.5 11.5h4" />
        </PanelBtn>

        <span className="cr-tsep" />

        <PanelBtn
          on={active.inspector}
          label="Inspector"
          tipText="Transform, crop, composite and speed for the selected clip."
          onClick={() => onTogglePanel('inspector')}
        >
          <path d="M2 4h12M2 8h8M2 12h10" />
          <circle cx="12.5" cy="8" r="1.6" />
        </PanelBtn>

        <span className="cr-tsep" />

        <HistoryBtn
          label="Undo"
          what={undoLabel}
          meta="Cmd / Ctrl + Z"
          empty="Nothing to undo yet."
          onClick={onUndo}
        >
          <path d="M2.6 5.4h7.2a3.8 3.8 0 010 7.6H5.4" />
          <path d="M5.2 2.4L2.4 5.4l2.8 3" />
        </HistoryBtn>
        <HistoryBtn
          label="Redo"
          what={redoLabel}
          meta="Shift + Cmd / Ctrl + Z"
          empty="Nothing to redo."
          onClick={onRedo}
        >
          <path d="M13.4 5.4H6.2a3.8 3.8 0 000 7.6h4.4" />
          <path d="M10.8 2.4l2.8 3-2.8 3" />
        </HistoryBtn>

        {onOpenWorkbench ? (
          <>
            <span className="cr-tsep" />
            <PanelBtn
              on={false}
              label="Workbench"
              tipText="Where the pipelines and the routing are built and tested. Nothing there touches the timeline."
              meta="Alt / Opt + D"
              onClick={onOpenWorkbench}
            >
              <circle cx="4" cy="4" r="1.8" />
              <circle cx="12" cy="4" r="1.8" />
              <circle cx="8" cy="12" r="1.8" />
              <path d="M4 5.8v1.4a1 1 0 001 1h6a1 1 0 001-1V5.8M8 8.2v2" />
            </PanelBtn>
          </>
        ) : null}

        <span className="cr-sp" />

        <div className="cr-proj">
          <b>{projectName}</b>
          <span>{resolution ? `${resolution} · ` : ''}{rateLabel(rate)}</span>
          <span
            className="cr-rev"
            data-tip={tip(
              `Revision ${revision}`,
              'Every run lands as one revision in the append-only history. Restoring an earlier one is itself recorded, so an accidental undo is undoable too.',
              `${historyDepth.undo} undo · ${historyDepth.redo} redo`,
            )}
          >
            rev {revision}
          </span>
        </div>
      </header>
    </>
  );
}

function PanelBtn({
  on, label, tipText, meta, onClick, children,
}: {
  on: boolean;
  label: string;
  tipText: string;
  meta?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="cr-ibtn"
      aria-pressed={on}
      data-tip={tip(label, tipText, meta)}
      onClick={onClick}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden="true">
        {children}
      </svg>
      <span>{label}</span>
    </button>
  );
}

function HistoryBtn({
  label, what, meta, empty, onClick, children,
}: {
  label: string;
  what: string | null;
  meta: string;
  empty: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const can = !!what && !!onClick;
  return (
    <button
      type="button"
      className="cr-hbtn"
      disabled={!can}
      aria-label={what ? `${label} ${what}` : label}
      data-tip={tip(
        what ? `${label} ${what}` : label,
        what
          ? 'One step. An AI run is a single entry, so this reverses the whole run.'
          : empty,
        meta,
      )}
      onClick={onClick}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

const CSS = `
.cr-iface{
  height:40px;flex:none;background:var(--head);
  border-bottom:1px solid var(--edge);box-shadow:var(--lift),var(--sink);
  display:flex;align-items:center;gap:2px;padding:0 10px;
  position:relative;z-index:14;font-family:var(--ui);
}
.cr-brand{
  font-weight:700;font-size:14px;letter-spacing:.02em;
  margin-right:16px;display:flex;align-items:center;gap:7px;color:var(--t1);flex:none;
}
.cr-brand i{
  width:15px;height:15px;border-radius:4px;flex:none;display:block;
  background:linear-gradient(135deg, var(--orange), var(--orange-dim));
}
.cr-ibtn{
  display:flex;flex-direction:column;align-items:center;gap:2px;
  padding:4px 11px;border-radius:4px;color:var(--t2);min-width:52px;flex:none;
  background:none;border:0;cursor:pointer;font-family:inherit;
}
.cr-ibtn span{font-size:9.5px;letter-spacing:.03em;font-weight:500;white-space:nowrap}
.cr-ibtn:hover{background:var(--edge);color:var(--t1)}
.cr-ibtn[aria-pressed="true"]{color:var(--orange);border-bottom: 2px solid var(--orange);padding-bottom: 2px}
.cr-hbtn{
  width:27px;height:24px;border-radius:4px;color:var(--t2);flex:none;
  display:flex;align-items:center;justify-content:center;
  background:none;border:0;cursor:pointer;
}
.cr-hbtn:not(:disabled){background: color-mix(in srgb, var(--orange) 6%, transparent);}
.cr-hbtn:hover:not(:disabled){background:var(--edge);color:var(--t1)}
.cr-hbtn:disabled{opacity:.3;cursor:default}
.cr-tsep{width:1px;height:18px;background:var(--edge-soft);margin:0 6px;flex:none}
.cr-sp{flex:1}
.cr-proj{font-size:12px;color:var(--t2);display:flex;gap:9px;align-items:center;flex:none}
.cr-proj b{
  color:var(--t1);font-weight:600;max-width:34vw;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;
}
.cr-rev{
  font-family:var(--mono);font-size:10.5px;color:var(--orange);
  background:color-mix(in srgb, var(--orange) 12%, transparent);
  padding:1px 6px;border-radius:4px;
}
@media (max-width:860px){
  .cr-iface{height:auto;flex-wrap:wrap;padding:4px 8px;gap:1px}
  .cr-brand span{display:none}
  .cr-proj b{max-width:44vw}
}
`;
