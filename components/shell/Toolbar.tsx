'use client';

/**
 * The interface toolbar.
 *
 * History on the left, then Export, the project, and the Inspector button at
 * the far end, where the panel it opens is.
 * The undo button names what it will undo, because an AI run lands as ONE
 * revision and one undo reverses the whole run, "Undo" alone does not tell
 * you whether you are about to lose a nudge or four minutes of pipeline.
 *
 * Assistant and Media Pool are NOT here. They were, and the column they open
 * carries tabs with the same two words on them, so the same two panels were
 * named twice within an inch of each other and neither reading was the
 * obvious one. The tabs won: they sit on the thing they switch and they show
 * which of the two is up. Collapsing the column is theirs too.
 *
 * Export is a button rather than a File menu item because it is the one
 * thing here that finishes the work, and it is now the only control in this
 * row that spends money, which is the other reason it is on its own at the
 * end and coloured.
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
  onOpenWorkbench?: () => void;
  /** Navigate back to the projects gallery. */
  onNavigateProjects?: () => void;
  /** Opens the host's file picker. Takes the place the brand used to hold. */
  onImport?: () => void;
  /** Opens the jobs and logs panel. */
  onOpenJobs?: () => void;
  /**
   * What autosave is doing, beside the project name.
   *
   * The menu bar used to carry a dot for unsaved work. Nothing saves by hand
   * any more, so what a person needs is not "you have unsaved work" but
   * whether the thing keeping it is keeping up.
   */
  saveState?: string | null;
  /** Opens the export dialog. */
  onExport?: () => void;
  /** Why Export cannot run, or null when it can. Shown instead of the tooltip. */
  exportDisabled?: string | null;
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
  onOpenWorkbench,
  onNavigateProjects,
  onImport,
  onOpenJobs,
  saveState = null,
  onExport,
  exportDisabled = null,
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
        <a
          href="/"
          className="cr-nav-projects"
          data-tip={tip(
            'Projects',
            'Return to the projects gallery.',
          )}
          onClick={(e) => {
            if (onNavigateProjects) {
              e.preventDefault();
              onNavigateProjects();
            }
          }}
        >
          <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 13L5 8l5-5" />
          </svg>
          <span>Projects</span>
        </a>
        <span className="cr-tsep" />
        {/*
          Import, where the logo was.

          The brand told you which app you were in, which you knew, and it sat
          in the one corner a person's eye goes to first. Import is the first
          thing anyone does to an empty project, and it had been three levels
          into a File menu that no longer exists.
        */}
        {onImport ? (
          <button type="button" className="cr-import" data-tip={tip(
            'Import media',
            'Bring files into the project. Dropping them on the Media Pool does the same thing.',
            'Cmd / Ctrl + I',
          )} onClick={onImport}>
            <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.45} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 2.2v7.6M5.2 7l2.8 2.8L10.8 7" />
              <path d="M2.6 11v1.8a1 1 0 001 1h8.8a1 1 0 001-1V11" />
            </svg>
            Import
          </button>
        ) : null}

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

        {onOpenJobs ? (
          <>
            <span className="cr-tsep" />
            <PanelBtn
              on={false}
              label="Jobs"
              tipText="Every job this session has run, with its log. The place to look when something took longer than it should have."
              meta="Shift + Cmd / Ctrl + J"
              onClick={onOpenJobs}
            >
              <path d="M2.4 3.6h11.2M2.4 8h11.2M2.4 12.4h7" />
              <circle cx="12.6" cy="12.4" r="1.5" />
            </PanelBtn>
          </>
        ) : null}

        {onOpenWorkbench ? (
          <>
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

        {onExport ? (
          <button
            type="button"
            className="cr-export"
            // still clickable when it cannot run: a disabled button cannot
            // tell you why, and why is the only thing you want from it
            aria-disabled={exportDisabled ? true : undefined}
            data-off={exportDisabled ? 'true' : undefined}
            data-tip={tip(
              'Export',
              exportDisabled ?? 'Render the timeline to a file. Compiles the cut to a graph, checks it, then spends the GPU.',
              'Cmd / Ctrl + E',
            )}
            onClick={onExport}
          >
            <svg
              viewBox="0 0 16 16"
              width={14}
              height={14}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.45}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 10.5V2.2M5.2 5l2.8-2.8L10.8 5" />
              <path d="M2.6 10v2.8a1 1 0 001 1h8.8a1 1 0 001-1V10" />
            </svg>
            Export
          </button>
        ) : null}

        {/*
          Two groups, not four loose words.

          What this is (the name, and whether it is safe) and what it will be
          (the frame, the rate, the revision) were a single row of four items
          at four sizes in three fonts, which reads as a list of unrelated
          facts. They are now an identity and a spec, set apart by a gap and
          by the spec being mono: numbers line up under each other and the
          name stays the thing your eye lands on.
        */}
        <div className="cr-proj">
          <span className="cr-ident">
            <b title={projectName}>{projectName}</b>
            {saveState ? <span className="cr-save">{saveState}</span> : null}
          </span>
          <span className="cr-spec">
            <span className="cr-fmt">
              {resolution ? `${resolution} · ` : ''}{rateLabel(rate)}
            </span>
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
          </span>
        </div>

        {/*
          The inspector button sits at the end of the row because the panel it
          opens is at the end of the window. It used to be on the left, next to
          the brand, pointing at a column on the far right.
        */}
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
.cr-nav-projects{
  display:flex;align-items:center;gap:5px;flex:none;
  font:inherit;font-size:12px;font-weight:600;color:var(--t2);
  background:none;border:1px solid transparent;border-radius:4px;
  padding:4px 8px;text-decoration:none;cursor:pointer;
  transition:all .15s;
}
.cr-nav-projects:hover{background:var(--edge);color:var(--t1);border-color:var(--edge-soft)}
.cr-nav-projects:focus-visible{outline:2px solid var(--t1);outline-offset:2px}
/* Not coloured like Export. Both are one click from real work, but one of
   them spends money and the difference has to be visible at a glance. */
.cr-import{
  display:flex;align-items:center;gap:6px;flex:none;
  font:inherit;font-size:12px;font-weight:600;color:var(--t1);
  background:var(--edge);border:1px solid var(--edge-soft);border-radius:4px;
  padding:5px 11px;margin-right:12px;cursor:pointer;
}
.cr-import:hover{background:var(--edge-soft)}
.cr-import:focus-visible{outline:2px solid var(--t1);outline-offset:2px}
.cr-ibtn{
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
  height:34px;padding:0 11px;border-radius:4px;color:var(--t2);min-width:52px;flex:none;
  background:none;border:0;border-bottom:2px solid transparent;cursor:pointer;font-family:inherit;
}
.cr-ibtn span{font-size:9.5px;letter-spacing:.03em;font-weight:500;white-space:nowrap;line-height:1}
.cr-ibtn:hover{background:var(--edge);color:var(--t1)}
/* the underline is always there and usually invisible, so lighting it cannot
   move the icon by the two pixels it takes up */
.cr-ibtn[aria-pressed="true"]{color:var(--orange);border-bottom-color:var(--orange)}
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
.cr-save{font-size:10.5px;color:var(--t3);flex:none;white-space:nowrap}
/* Red is the action colour, and this is the action: the one control in the
   row that finishes the work and the only one that spends anything. */
.cr-export{
  display:flex;align-items:center;gap:6px;flex:none;
  font:inherit;font-size:12px;font-weight:600;color:var(--t1);
  background:var(--red);border:0;border-radius:4px;
  padding:5px 11px;margin-right:14px;cursor:pointer;
}
.cr-export:hover{filter:brightness(1.12)}
.cr-export:focus-visible{outline:2px solid var(--t1);outline-offset:2px}
/* unrunnable, not hidden and not inert: it still answers why on hover */
.cr-export[data-off]{background:var(--edge);color:var(--t3)}
.cr-export[data-off]:hover{filter:none}
/* one centre line for the whole cluster, whatever the sizes inside it */
.cr-proj{display:flex;align-items:center;gap:14px;flex:none;min-width:0;line-height:1}
.cr-ident{display:flex;align-items:center;gap:7px;min-width:0}
.cr-proj b{
  font-size:12.5px;color:var(--t1);font-weight:600;max-width:26vw;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;line-height:1.35;
}
.cr-spec{display:flex;align-items:center;gap:7px;flex:none}
.cr-fmt{
  font-family:var(--mono);font-size:10.5px;color:var(--t3);white-space:nowrap;
  font-variant-numeric:tabular-nums;
}
/* the chip and the text beside it are the same height, so neither rides high */
.cr-rev{
  font-family:var(--mono);font-size:10.5px;color:var(--orange);
  background:color-mix(in srgb, var(--orange) 12%, transparent);
  height:17px;padding:0 6px;border-radius:3px;
  display:inline-flex;align-items:center;font-variant-numeric:tabular-nums;
}
@media (max-width:860px){
  .cr-iface{height:auto;flex-wrap:wrap;padding:4px 8px;gap:1px}
  .cr-proj b{max-width:44vw}
}
`;
