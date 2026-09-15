'use client';

/**
 * The app frame.
 *
 * Toolbar across the top; below it the rail, the browser column, the viewer
 * and the inspector; below that the timeline, which another part of the app
 * fills, the shell only gives it the room.
 *
 * The shell owns the geometry and the modes, and nothing else. Every edit is
 * a callback: it seeks, it arms a tool, it reports a routed prompt, and the
 * owner decides what any of that does to the document. That is what makes the
 * same frame usable against a fixture and against a live timeline.
 */

import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode,
} from 'react';
import { Toolbar, type PanelId } from './Toolbar.tsx';
import { isTyping, shellShortcut } from './shortcuts.ts';
import { DRAG_TYPE } from '../../lib/media/drop.ts';
import { ToolRail } from '../rail/ToolRail.tsx';
import { ToolPalette } from '../rail/ToolPalette.tsx';
import {
  buildTools, runsLocally, toolContextFrom, trackFacts, type Tool,
} from '../rail/tools.ts';
import { Assistant, type RouteReply } from '../assistant/Assistant.tsx';
import type { ToolRunArgs } from '../assistant/ToolRunCard.tsx';
import { Viewer } from '../viewer/Viewer.tsx';
import { Inspector, DEFAULT_CLIP_PARAMS, type ClipParams } from '../inspector/Inspector.tsx';
import { Resizer } from '../ui/Resizer.tsx';
import { TooltipLayer, tip } from '../ui/Tooltip.tsx';
import type { PlayheadController } from '../timeline/Playhead.tsx';
import {
  fitTimelineHeight, TIMELINE_MIN_HEIGHT, VIEWER_MIN_HEIGHT,
} from '../timeline/interactions.ts';
import { isClip } from '@/lib/timeline/document.ts';
import { rateLabel, toTimecode, type Frames } from '@/lib/time/frames.ts';
import type { MediaRef, PlacedItem, Timeline } from '@/lib/timeline/types.ts';
import type { RunState } from '@/lib/executor/types.ts';
import type { Plan } from '@/lib/router/plan.ts';

export interface ShellProps {
  timeline: Timeline;
  playhead: Frames;
  /**
   * The playhead clock the timeline is driving. Pass it and the viewer's
   * transport moves the timeline's playhead, because there is then one clock
   * in the app rather than one per panel. Without it the viewer runs its own
   * against `playhead` and `onSeek`, and the two disagree the moment either
   * one plays.
   */
  controller?: PlayheadController;
  selection?: PlacedItem | null;
  runs?: RunState[];
  runTitles?: Record<string, string>;
  /** True while a run is in flight: the composer and run card stand down. */
  busy?: boolean;
  onSeek: (at: Frames) => void;
  /** A rung-1 tool: a document patch, so it runs on the click with no card. */
  onRunLocalTool?: (tool: Tool) => void;
  /** A dearer tool, confirmed on its run card. */
  onRunTool?: (tool: Tool, args: ToolRunArgs) => void;
  onRouted?: (prompt: string, reply: RouteReply) => void;
  /** Execute a plan from the assistant. */
  onRunPlan?: (plan: Plan) => void;
  /** A file picked in the pool. It loads in Source either way; this is notice. */
  onSelectMedia?: (key: string) => void;
  /**
   * Take a file back out of the project. Left off, the pool shows no remove
   * affordance at all, rather than one that reports it cannot.
   */
  onRemoveMedia?: (key: string) => void;
  onRenameMedia?: (key: string, newName: string) => void;
  onReplaceMedia?: (key: string, file: File) => void;
  onRelinkMedia?: (key: string, newKey: string) => void;
  onReextractFrames?: (key: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  undoLabel?: string | null;
  redoLabel?: string | null;
  historyDepth?: { undo: number; redo: number };
  /**
   * The inspector's per-clip values, by clip id, when the owner holds them.
   * Give this and `onClipParamsChange` and the numbers reach the document and
   * the undo stack; leave them off and they live in the shell, where they are
   * a preview the viewer paints from and nothing else.
   */
  clipParams?: Record<string, ClipParams>;
  onClipParamsChange?: (clipId: string, next: ClipParams) => void;
  onOpenWorkbench?: () => void;
  /** Navigate back to the projects gallery. */
  onNavigateProjects?: () => void;
  /**
   * Opens the export dialog. Left off, the toolbar shows no Export button at
   * all rather than one that reports it cannot.
   */
  onExport?: () => void;
  /** Files chosen or dropped anywhere the pool accepts them. */
  onImportFiles?: (files: File[]) => void;
  /** Opens the host's file picker, for the pool's and the toolbar's Import. */
  onPickFiles?: () => void;
  /** Opens the jobs and logs panel, from the toolbar. */
  onOpenJobs?: () => void;
  /** What autosave is doing, shown beside the project name. */
  saveState?: string | null;
  /**
   * Takes over saying things out loud. One message, one place on screen: when
   * this is given the shell stops rendering its own toast, because two toasts
   * at the same fixed position are one message printed twice. Leave it off and
   * the shell keeps its own, which is what makes it usable on its own.
   */
  onNotify?: (message: string) => void;
  /** The timeline panel. */
  children?: ReactNode;
}

const BROWSER_DEFAULT = 288;
const INSPECTOR_DEFAULT = 284;

const subscribeToResize = (cb: () => void) => {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
};

export function Shell({
  timeline,
  playhead,
  controller,
  selection = null,
  runs = [],
  runTitles,
  busy = false,
  onSeek,
  onRunLocalTool,
  onRunTool,
  onRouted,
  onRunPlan,
  onSelectMedia,
  onRemoveMedia,
  onRenameMedia,
  onReplaceMedia,
  onRelinkMedia,
  onReextractFrames,
  onUndo,
  onRedo,
  undoLabel = null,
  redoLabel = null,
  historyDepth,
  clipParams,
  onClipParamsChange,
  onOpenWorkbench,
  onNavigateProjects,
  onExport,
  onImportFiles,
  onPickFiles,
  onOpenJobs,
  saveState,
  onNotify,
  children,
}: ShellProps) {
  /**
   * The inspector starts closed, like the pool.
   *
   * It has nothing to say until a clip is picked, and until then it is a
   * column of empty state taking width off the viewer and the timeline. The
   * toolbar button opens it, and it stays open for the rest of the session.
   */
  const [panels, setPanels] = useState<Record<PanelId, boolean>>({
    assistant: false, pool: true, inspector: false,
  });
  const [browserW, setBrowserW] = useState(BROWSER_DEFAULT);
  const [inspectorW, setInspectorW] = useState(INSPECTOR_DEFAULT);
  /** null until dragged: the timeline opens at a share of the window. */
  const [timelineDrag, setTimelineDrag] = useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [armed, setArmed] = useState<Tool | null>(null);
  const [probingMedia, setProbingMedia] = useState<MediaRef | null>(null);
  const [localParams, setLocalParams] = useState<Record<string, ClipParams>>({});
  /**
   * The file picked in the pool, and the timeline selection it was picked
   * against.
   *
   * Both halves, because a pool pick and a clip selection are two answers to
   * the same question, "what is in the Source monitor", and the later one
   * should win. Comparing the recorded selection with the current one is a
   * derivation, so selecting a clip drops the pool pick during the render
   * that brings the clip in, with no effect chasing it a frame later.
   */
  const [poolPick, setPoolPick] = useState<{ key: string; against: string | null } | null>(null);
  const [viewerMode, setViewerMode] = useState<'source' | 'timeline'>('timeline');
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [viewerFocused, setViewerFocused] = useState(true);

  const params = clipParams ?? localParams;
  const setParams = useCallback((id: string, next: ClipParams) => {
    if (onClipParamsChange) onClipParamsChange(id, next);
    else setLocalParams((p) => ({ ...p, [id]: next }));
  }, [onClipParamsChange]);

  const browserShown = panels.assistant || panels.pool;

  /**
   * Which of the two to bring back, remembered across a collapse.
   *
   * Written in an effect and not during render. A ref assignment while
   * rendering is a side effect, and React may render without committing:
   * `MenuBar.tsx` has the same note on the same mistake.
   */
  const lastBrowserTab = useRef<'assistant' | 'pool'>('pool');
  useEffect(() => {
    if (browserShown) lastBrowserTab.current = panels.pool ? 'pool' : 'assistant';
  }, [browserShown, panels.pool]);

  /**
   * Why Export cannot run, in the same words the File menu used before the
   * button took its place. A render of nothing is not worth the GPU, and the
   * button says so on hover rather than going quiet.
   */
  const exportDisabled = timeline.tracks.some((t) => t.items.some((i) => i.kind === 'clip'))
    ? null
    : 'there is nothing on the timeline to export';
  const tab: 'assistant' | 'pool' = panels.pool && !panels.assistant ? 'pool' : 'assistant';

  // Not memoised, deliberately. The card registry is mutable, the workbench
  // edits frontmatter and adds cards, and a list snapshotted at mount is a
  // tool describing itself out of a card that has since changed. It is a map
  // and a sort over eight cards.
  const tools = buildTools();
  // The counts walk every item on every track, so they hang off the document;
  // only the playhead half is recomputed on a seek.
  const facts = useMemo(() => trackFacts(timeline), [timeline]);
  const context = useMemo(
    () => toolContextFrom(facts, timeline, playhead, selection),
    [facts, timeline, playhead, selection],
  );

  // The viewport bounds the resizers. Subscribed rather than measured into
  // state, so the server and the first client render agree and there is no
  // state update chasing a value React can read directly.
  const vw = useSyncExternalStore(subscribeToResize, () => window.innerWidth, () => 1440);
  const vh = useSyncExternalStore(subscribeToResize, () => window.innerHeight, () => 900);
  /**
   * The timeline is docked at the bottom and is as tall as its tracks.
   *
   * A fixed fraction of the window meant a four track cut sat above a hand's
   * width of empty ground, with the viewer squeezed to hold it. `fitTimelineHeight`
   * sums the lanes that exist, so adding a track grows the panel by exactly
   * that track and the viewer keeps the rest. A drag still wins, and the
   * resizer's reset puts it back on the tracks rather than on a number.
   */
  const fittedTimelineH = fitTimelineHeight(timeline.tracks, vh);
  const timelineH = timelineDrag ?? fittedTimelineH;

  // One owner. The host's toast and the shell's sit at the same fixed
  // position, so whichever is going to speak has to be the only one that does.
  const say = useCallback((text: string) => {
    if (onNotify) { onNotify(text); return; }
    setToast({ id: Date.now(), text });
  }, [onNotify]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  /**
   * The palette's key, and only that.
   *
   * Undo, redo and the workbench are commands, and the command registry binds
   * them once for the whole application. Binding them here as well meant one
   * Cmd Z ran undo twice: it popped two history entries and committed the
   * second, so the document and the stack disagreed from then on.
   *
   * A shortcut belongs to exactly one owner. The palette is the Shell's
   * because the Shell owns the palette; everything on a menu belongs to the
   * registry, which is what makes the printed label and the binding the same
   * object.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shellShortcut(e, isTyping(e.target)) !== 'palette') return;
      e.preventDefault();
      setPaletteOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /**
   * Picking a tool.
   *
   * An unmet precondition says why out loud instead of doing nothing, a
   * button that silently ignores you is the worst outcome of the three. A
   * rung-1 tool runs on the click; anything dearer arms a run card first,
   * because GPU minutes deserve a confirmation and 20ms does not.
   */
  const pick = useCallback(
    (tool: Tool, reason: string | null) => {
      if (reason) { say(`${tool.name}, ${reason}`); return; }
      setPaletteOpen(false);
      if (runsLocally(tool)) {
        setArmed(null);
        if (onRunLocalTool) onRunLocalTool(tool);
        else say(`${tool.name} is not wired to the document yet`);
        return;
      }
      setPanels((p) => ({ ...p, assistant: true, pool: false }));
      setArmed(tool);
    },
    [say, onRunLocalTool],
  );

  const togglePanel = useCallback((id: PanelId) => {
    setPanels((p) => {
      if (id === 'inspector') return { ...p, inspector: !p.inspector };
      // the two browser tabs share one column: clicking the one already on
      // screen closes the column, clicking the other swaps to it
      const other: PanelId = id === 'assistant' ? 'pool' : 'assistant';
      if (p[id]) return { ...p, [id]: false };
      return { ...p, [id]: true, [other]: false };
    });
  }, []);

  const selectedId = selection && isClip(selection.item) ? selection.item.id : null;
  const selectedName = selection && isClip(selection.item) ? selection.item.name : null;
  const media = selection && isClip(selection.item)
    ? timeline.media[selection.item.mediaKey] ?? null
    : null;

  // the pick survives only while the timeline selection it was made against
  // is still the selection, and only while the file is still in the pool
  const pickedKey = poolPick && poolPick.against === selectedId && timeline.media[poolPick.key]
    ? poolPick.key
    : null;
  const pickedMedia = pickedKey ? timeline.media[pickedKey] : null;

  /**
   * A pool file as something the Source monitor can show.
   *
   * Source takes a `PlacedItem`, because normally it is showing a clip with
   * handles either side of the cut. A file that is not in the cut has no
   * clip, so one is made covering the whole of it: the handles are then the
   * whole file, which is exactly right for looking at a file you have not
   * used yet.
   */
  const pickedItem: PlacedItem | null = useMemo(() => (
    pickedMedia
      ? {
        item: {
          id: `pool:${pickedMedia.key}`,
          kind: 'clip',
          name: pickedMedia.name,
          mediaKey: pickedMedia.key,
          sourceRange: pickedMedia.available,
          enabled: true,
          effects: [],
        },
        trackId: 'pool',
        index: 0,
        range: pickedMedia.available,
      }
      : null
  ), [pickedMedia]);

  const firstVideoTrack = timeline.tracks.find((t) => t.kind === 'video');
  const armedTargets = [
    'Whole timeline',
    selectedName ? `Selected clip, ${selectedName}` : 'Selected clip (none yet)',
    firstVideoTrack ? `${firstVideoTrack.name} only` : 'Top video track only',
    'From the playhead on',
  ];

  return (
    <>
      <style href="cutroom-shell" precedence="medium">{CSS}</style>
      <div className="cr-app">
        <Toolbar
          projectName={timeline.name}
          rate={timeline.rate}
          resolution={timeline.width && timeline.height ? `${timeline.width}x${timeline.height}` : undefined}
          revision={timeline.revision}
          active={panels}
          onTogglePanel={togglePanel}
          onOpenWorkbench={onOpenWorkbench}
          onNavigateProjects={onNavigateProjects}
          onImport={onPickFiles}
          onOpenJobs={onOpenJobs}
          saveState={saveState}
          onExport={onExport}
          exportDisabled={exportDisabled}
          undoLabel={undoLabel}
          redoLabel={redoLabel}
          onUndo={onUndo}
          onRedo={onRedo}
          historyDepth={historyDepth}
        />

        <div className="cr-upper">
          <ToolRail
            tools={tools}
            context={context}
            armedToolId={armed?.id ?? null}
            onPick={pick}
            onOpenPalette={() => setPaletteOpen(true)}
          />

          {browserShown ? (
            <>
              <aside
                className="cr-browser"
                style={{ width: browserW }}
                data-focused={!viewerFocused ? 'true' : undefined}
                onPointerDown={() => setViewerFocused(false)}
              >
                {/*
                  Media Pool first.

                  It is the tab this column opens on and the one every cut
                  starts in: you import before you ask for anything. Reading
                  order is left to right, so the default sat second.
                */}
                <div className="cr-btabs" role="tablist" aria-label="Browser">
                  <button
                    type="button"
                    role="tab"
                    className="cr-btab"
                    aria-selected={tab === 'pool'}
                    data-on={tab === 'pool' ? 'true' : undefined}
                    onClick={() => setPanels((p) => ({ ...p, pool: true, assistant: false }))}
                  >
                    Media Pool
                  </button>
                  <button
                    type="button"
                    role="tab"
                    className="cr-btab"
                    aria-selected={tab === 'assistant'}
                    data-on={tab === 'assistant' ? 'true' : undefined}
                    onClick={() => setPanels((p) => ({ ...p, assistant: true, pool: false }))}
                  >
                    Assistant
                  </button>
                  <span className="cr-bsp" />
                  <button
                    type="button"
                    className="cr-bcollapse"
                    aria-label="Collapse the browser"
                    data-tip={tip(
                      'Collapse',
                      'Gives the column back to the viewer and the timeline. The strip it leaves behind opens it again.',
                    )}
                    onClick={() => setPanels((p) => ({ ...p, assistant: false, pool: false }))}
                  >
                    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M9.5 3.5L5 8l4.5 4.5" />
                    </svg>
                  </button>
                </div>

                <div className="cr-bbody">
                  {tab === 'assistant' ? (
                    <Assistant
                      runs={runs}
                      runTitles={runTitles}
                      armed={armed}
                      armedTargets={armedTargets}
                      disabledTargets={selectedName ? [] : [1]}
                      busy={busy}
                      onArmedRun={(tool, args) => {
                        setArmed(null);
                        if (onRunTool) onRunTool(tool, args);
                        else say(`${tool.name} is not wired to an executor yet`);
                      }}
                      onArmedCancel={() => setArmed(null)}
                      onRouted={onRouted}
                      onRunPlan={onRunPlan}
                    />
                  ) : (
                    <MediaPool
                      timeline={timeline}
                      selectedKey={pickedKey}
                      onSelect={(key) => {
                        // picking the same file twice puts Source back on the
                        // selected clip, so the tile is a toggle and not a trap
                        const same = pickedKey === key;
                        setPoolPick(same ? null : { key, against: selectedId });
                        setViewerMode(same ? 'timeline' : 'source');
                        onSelectMedia?.(key);
                      }}
                      onRemove={onRemoveMedia}
                      onProbe={(m) => setProbingMedia(m)}
                      onImportFiles={onImportFiles}
                      onPickFiles={onPickFiles}
                    />
                  )}
                </div>
              </aside>

              <Resizer
                orientation="vertical"
                size={browserW}
                min={200}
                max={Math.min(560, Math.round(vw * 0.45))}
                defaultSize={BROWSER_DEFAULT}
                label="Resize browser panel"
                onResize={setBrowserW}
                onReset={() => say('Panel reset to its default width')}
              />
            </>
          ) : (
            /**
             * The way back.
             *
             * The toolbar used to hold the only controls that opened this
             * column, and they went because the tabs inside it said the same
             * two words. A collapse with no matching expand would have been
             * the worse half of that trade, so the strip it leaves is the
             * button: narrow, always there, and it reopens whichever of the
             * two panels was last up.
             */
            <button
              type="button"
              className="cr-bopen"
              aria-label="Open the browser"
              data-tip={tip('Assistant and Media Pool', 'The column you collapsed. It comes back where you left it.')}
              onClick={() => setPanels((p) => ({ ...p, [lastBrowserTab.current]: true }))}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6.5 3.5L11 8l-4.5 4.5" />
              </svg>
            </button>
          )}

          <div className="cr-viewers">
            <Viewer
              timeline={timeline}
              playhead={playhead}
              controller={controller}
              onSeek={onSeek}
              source={pickedItem ?? selection}
              sourceMedia={pickedMedia ?? media}
              mode={viewerMode}
              onModeChange={setViewerMode}
              paramsFor={(id) => params[id] ?? DEFAULT_CLIP_PARAMS}
              focused={viewerFocused}
              onFocus={() => setViewerFocused(true)}
            />
          </div>

          {panels.inspector ? (
            <>
              <Resizer
                orientation="vertical"
                size={inspectorW}
                min={200}
                max={Math.min(520, Math.round(vw * 0.4))}
                defaultSize={INSPECTOR_DEFAULT}
                invert
                label="Resize inspector"
                onResize={setInspectorW}
                onReset={() => say('Inspector reset to its default width')}
              />
              <div className="cr-inspwrap" style={{ width: inspectorW }}>
                <Inspector
                  clip={selection}
                  rate={timeline.rate}
                  media={media}
                  params={(selectedId && params[selectedId]) || DEFAULT_CLIP_PARAMS}
                  onChange={(next) => { if (selectedId) setParams(selectedId, next); }}
                />
              </div>
            </>
          ) : null}
        </div>

        <Resizer
          orientation="horizontal"
          size={timelineH}
          min={TIMELINE_MIN_HEIGHT}
          max={Math.max(TIMELINE_MIN_HEIGHT, vh - VIEWER_MIN_HEIGHT)}
          defaultSize={fittedTimelineH}
          invert
          label="Resize timeline"
          onResize={setTimelineDrag}
          // null, not the fitted number: back on the tracks, so the next one
          // added grows the panel again instead of scrolling inside a height
          // somebody's double-click happened to pin
          onReset={() => { setTimelineDrag(null); say('Timeline fitted to its tracks'); }}
        />

        <div className="cr-tlwrap" style={{ height: timelineH }}>{children}</div>
      </div>

      <ToolPalette
        open={paletteOpen}
        tools={tools}
        context={context}
        onPick={pick}
        onClose={() => setPaletteOpen(false)}
      />

      <TooltipLayer />

      {onNotify ? null : (
        <div className="cr-toast" data-show={toast ? 'true' : undefined} role="status" aria-live="polite">
          {toast?.text ?? ''}
        </div>
      )}

      {probingMedia ? (
        <MediaProbeDialog
          media={timeline.media[probingMedia.key] ?? probingMedia}
          timeline={timeline}
          usedCount={timeline.tracks.reduce((acc, t) => acc + t.items.filter((i) => i.kind === 'clip' && i.mediaKey === probingMedia.key).length, 0)}
          onClose={() => setProbingMedia(null)}
          onRename={onRenameMedia}
          onReplaceFile={onReplaceMedia}
          onRelinkKey={onRelinkMedia}
          onReextractFrames={onReextractFrames}
          onRemove={onRemoveMedia}
        />
      ) : null}
    </>
  );
}

// ── media pool ──────────────────────────────────────────────────────────

/**
 * Everything the project can cut from. Durations are the *available* range,
 * what exists in the source, not what any clip currently uses, because that
 * is the number that tells you whether there is handle to trim into.
 */
function MediaPool({
  timeline,
  selectedKey,
  onSelect,
  onRemove,
  onProbe,
  onImportFiles,
  onPickFiles,
}: {
  timeline: Timeline;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  onRemove?: (key: string) => void;
  onProbe?: (media: MediaRef) => void;
  onImportFiles?: (files: File[]) => void;
  onPickFiles?: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [list, setList] = useState(false);
  const [over, setOver] = useState(false);

  /**
   * Files dropped from the desktop, which is not the drag this panel already
   * had.
   *
   * A pool tile is itself draggable, onto the timeline, and that drag carries
   * `DRAG_TYPE` and a media key. This one carries `Files`. Reading the types
   * list rather than the payload is what keeps the two apart: a tile dragged
   * within the pool must not read as an import, and a file from Finder must
   * not be mistaken for a tile.
   */
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!onImportFiles || !hasFiles(e)) return;
    e.preventDefault();               // without this the browser opens the file
    e.dataTransfer.dropEffect = 'copy';
    setOver(true);
  }, [onImportFiles]);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (!onImportFiles || !hasFiles(e)) return;
    e.preventDefault();
    setOver(false);
    const files = [...e.dataTransfer.files];
    if (files.length) onImportFiles(files);
  }, [onImportFiles]);

  const all = Object.values(timeline.media);
  const q = filter.trim().toLowerCase();
  const shown = q ? all.filter((m) => m.name.toLowerCase().includes(q)) : all;

  /**
   * How many clips are cut from each file.
   *
   * Shown on the tile, because it is the number that decides what removing
   * the file means: on a tile reading "3" the remove button is about to take
   * three clips out of the cut, and the person should know that before the
   * dialog rather than from it.
   */
  const uses = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const track of timeline.tracks) {
      for (const item of track.items) {
        if (item.kind !== 'clip') continue;
        counts[item.mediaKey] = (counts[item.mediaKey] ?? 0) + 1;
      }
    }
    return counts;
  }, [timeline.tracks]);

  return (
    <div
      className="cr-pool"
      data-over={over ? 'true' : undefined}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      // dragleave fires when the pointer crosses onto a child, so the ring
      // is dropped only when the pointer has actually left the panel
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={onDrop}
    >
      <div className="cr-poolbar">
        <input
          value={filter}
          spellCheck={false}
          placeholder="Filter media…"
          aria-label="Filter media"
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="cr-poolct">{shown.length}/{all.length}</span>
        <span className="cr-poolvw">
          <button
            type="button"
            aria-label="Thumbnail view"
            aria-pressed={!list}
            data-on={!list ? 'true' : undefined}
            data-tip={tip('Thumbnails', 'Every asset as a tile, the fastest way to recognise footage.')}
            onClick={() => setList(false)}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
              <rect x="2" y="2" width="5" height="5" /><rect x="9" y="2" width="5" height="5" />
              <rect x="2" y="9" width="5" height="5" /><rect x="9" y="9" width="5" height="5" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="List view"
            aria-pressed={list}
            data-on={list ? 'true' : undefined}
            data-tip={tip('List', 'Names, durations and types in rows. Better once the pool is large.')}
            onClick={() => setList(true)}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
              <path d="M2 4h12M2 8h12M2 12h12" />
            </svg>
          </button>
        </span>
      </div>

      {all.length === 0 ? (
        <p className="cr-poolnone">
          {/*
            It used to say "or drop a file on the timeline", which was not
            true: the timeline's drop accepts a pool tile and ignores a file
            from the desktop. This panel is the one that takes files, so this
            is the one that says so.
          */}
          Nothing imported yet. Drop files here, or use Import in the toolbar.
        </p>
      ) : shown.length === 0 ? (
        <p className="cr-poolnone">Nothing in the pool matches “{filter}”.</p>
      ) : (
        <div className="cr-grid" data-list={list ? 'true' : undefined}>
          {shown.map((m) => {
            const used = uses[m.key] ?? 0;
            return (
              /**
               * A tile is two controls, not one. The remove button cannot be
               * nested inside the tile button (a button inside a button is
               * not a button), so the tile is a group and the two sit side by
               * side, which is also what lets the keyboard reach both.
               */
              <div
                className="cr-mtile"
                key={m.key}
                data-on={selectedKey === m.key ? 'true' : undefined}
              >
                <button
                  type="button"
                  className="cr-mclip"
                  draggable
                  /**
                   * A pool item is the drag source. The payload is the media key
                   * and nothing else: the timeline already has the pool, so
                   * sending the whole MediaRef would let a stale copy of it land
                   * in the document.
                   */
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, m.key);
                    e.dataTransfer.setData('text/plain', m.name);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => onSelect?.(m.key)}
                  aria-pressed={selectedKey === m.key}
                  // the harness drags by key, and reading it off the element is
                  // how it drives the same drop path a person does
                  data-key={m.key}
                  data-tip={tip(
                    m.name,
                    `${m.kind} · ${m.available.duration} frames available · ${used === 0 ? 'not used in the cut' : `${used} clip${used === 1 ? '' : 's'} in the cut`} · click to load in Source, drag onto a track`,
                    m.key,
                  )}
                >
                  <span className="cr-th" data-kind={m.kind}>
                    {/* The real first frame. No frames means a plain slab: an
                        invented picture where someone's footage belongs is worse
                        than an empty one, because the empty one is honest. */}
                    {m.frames?.length ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/media/frame?key=${encodeURIComponent(m.frames[0])}`} alt="" loading="lazy" />
                    ) : null}
                    <span className="cr-dur">{toTimecode(m.available.duration, timeline.rate)}</span>
                    {used > 0 ? <span className="cr-muse">{used}</span> : null}
                  </span>
                  <span className="cr-nm">{m.name}</span>
                  <span className="cr-mmeta">{m.kind}</span>
                </button>
                {onProbe ? (
                  <button
                    type="button"
                    className="cr-minfo"
                    aria-label={`Inspect ${m.name}`}
                    data-key={m.key}
                    data-tip={tip(
                      'Probe and details',
                      'View file probe details, rename, relink, or re-extract thumbnails.',
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      onProbe(m);
                    }}
                  >
                    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                      <circle cx="8" cy="8" r="6" />
                      <path d="M8 7v4M8 5h.01" />
                    </svg>
                  </button>
                ) : null}
                {onRemove ? (
                  <button
                    type="button"
                    className="cr-mx"
                    aria-label={`Remove ${m.name} from the project`}
                    data-key={m.key}
                    data-tip={tip(
                      'Remove from the project',
                      used === 0
                        ? 'Nothing is cut from this file, so only the file goes.'
                        : `Takes ${used} clip${used === 1 ? '' : 's'} with it, as one undo.`,
                    )}
                    onClick={() => onRemove(m.key)}
                  >
                    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MediaProbeDialog({
  media,
  timeline,
  usedCount,
  onClose,
  onRename,
  onReplaceFile,
  onRelinkKey,
  onReextractFrames,
  onRemove,
}: {
  media: MediaRef;
  timeline: Timeline;
  usedCount: number;
  onClose: () => void;
  onRename?: (key: string, newName: string) => void;
  onReplaceFile?: (key: string, file: File) => void;
  onRelinkKey?: (key: string, newKey: string) => void;
  onReextractFrames?: (key: string) => void;
  onRemove?: (key: string) => void;
}) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(media.name);
  const [relinking, setRelinking] = useState(false);
  const [newKey, setNewKey] = useState(media.key);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const durationStr = toTimecode(media.available.duration, timeline.rate);
  const fpsStr = rateLabel(media.rate ?? timeline.rate);
  const resStr = media.width && media.height ? `${media.width} x ${media.height}` : 'Audio only';
  const framesCount = media.frames?.length ?? 0;

  return (
    <div className="cr-open" role="dialog" aria-modal="true" aria-labelledby="cr-probe-title">
      <div className="cr-open-box" style={{ maxWidth: 480 }}>
        <header className="cr-open-head">
          <h2 id="cr-probe-title" style={{ fontSize: 13, fontWeight: 600 }}>Media details & probe</h2>
          <button type="button" className="cr-open-x" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="cr-open-body" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--t3)', marginBottom: 4 }}>NAME</div>
            {editingName ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={{
                    flex: 1, background: 'var(--app)', border: '1px solid var(--orange)',
                    borderRadius: 4, padding: '4px 8px', color: 'var(--t1)', fontSize: 12,
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  className="cr-btn"
                  onClick={() => {
                    if (name.trim() && name !== media.name) {
                      onRename?.(media.key, name.trim());
                    }
                    setEditingName(false);
                  }}
                >
                  Save
                </button>
                <button type="button" className="cr-btn" onClick={() => { setName(media.name); setEditingName(false); }}>
                  Cancel
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{media.name}</span>
                {onRename ? (
                  <button
                    type="button"
                    onClick={() => setEditingName(true)}
                    style={{ background: 'none', border: 0, color: 'var(--orange)', fontSize: 11, cursor: 'pointer' }}
                  >
                    Rename
                  </button>
                ) : null}
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px 12px', fontSize: 11.5 }}>
            <span style={{ color: 'var(--t3)' }}>Key</span>
            <span style={{ fontFamily: 'var(--mono)', wordBreak: 'break-all', color: 'var(--t2)' }}>{media.key}</span>

            <span style={{ color: 'var(--t3)' }}>Kind</span>
            <span style={{ color: 'var(--t1)', textTransform: 'capitalize' }}>{media.kind}</span>

            <span style={{ color: 'var(--t3)' }}>Resolution</span>
            <span style={{ color: 'var(--t1)' }}>{resStr}</span>

            <span style={{ color: 'var(--t3)' }}>Duration</span>
            <span style={{ color: 'var(--t1)' }}>{durationStr} ({media.available.duration} frames)</span>

            <span style={{ color: 'var(--t3)' }}>Frame rate</span>
            <span style={{ color: 'var(--t1)' }}>{fpsStr}</span>

            <span style={{ color: 'var(--t3)' }}>Proxy stream</span>
            <span style={{ color: media.proxy ? 'var(--green)' : 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 10.5 }}>
              {media.proxy ? media.proxy : 'None (stepped frame scrub)'}
            </span>

            <span style={{ color: 'var(--t3)' }}>Thumbnails</span>
            <span style={{ color: framesCount > 0 ? 'var(--t1)' : 'var(--red)' }}>
              {framesCount > 0 ? `${framesCount} frames extracted` : 'None extracted'}
            </span>

            <span style={{ color: 'var(--t3)' }}>Timeline usage</span>
            <span style={{ color: 'var(--t1)' }}>
              {usedCount === 0 ? 'Not used in cut' : `${usedCount} clip${usedCount === 1 ? '' : 's'} on timeline`}
            </span>
          </div>

          {relinking ? (
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>ENTER NEW STORAGE KEY</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  style={{
                    flex: 1, background: 'var(--app)', border: '1px solid var(--orange)',
                    borderRadius: 4, padding: '4px 8px', color: 'var(--t1)', fontSize: 11, fontFamily: 'var(--mono)',
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  className="cr-btn"
                  onClick={() => {
                    if (newKey.trim() && newKey !== media.key) {
                      onRelinkKey?.(media.key, newKey.trim());
                    }
                    setRelinking(false);
                  }}
                >
                  Relink
                </button>
                <button type="button" className="cr-btn" onClick={() => setRelinking(false)}>Cancel</button>
              </div>
            </div>
          ) : null}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, paddingTop: 12, borderTop: '1px solid var(--edge)' }}>
            {onReextractFrames ? (
              <button
                type="button"
                className="cr-btn"
                style={{ fontSize: 11 }}
                onClick={() => onReextractFrames(media.key)}
              >
                Re-extract thumbnails
              </button>
            ) : null}

            {onReplaceFile ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) onReplaceFile(media.key, file);
                    onClose();
                  }}
                />
                <button
                  type="button"
                  className="cr-btn"
                  style={{ fontSize: 11 }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Replace file...
                </button>
              </>
            ) : null}

            {onRelinkKey ? (
              <button
                type="button"
                className="cr-btn"
                style={{ fontSize: 11 }}
                onClick={() => setRelinking((r) => !r)}
              >
                Relink key...
              </button>
            ) : null}

            {onRemove ? (
              <button
                type="button"
                className="cr-btn"
                style={{ fontSize: 11, color: 'var(--red)', marginLeft: 'auto' }}
                onClick={() => {
                  onClose();
                  onRemove(media.key);
                }}
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

const CSS = `
.cr-app{display:flex;flex-direction:column;height:100vh;min-height:560px;background:var(--app)}
.cr-upper{flex:1 1 auto;display:flex;min-height:0}

.cr-browser{
  flex:none;background:var(--panel);display:flex;flex-direction:column;
  min-height:0;min-width:0;position:relative;
}
.cr-browser::before{
  content:"";position:absolute;top:0;left:0;right:0;height:2px;
  background:var(--orange);opacity:0;z-index:3;
}
.cr-browser[data-focused]::before{opacity:1}
/* 28px so the browser, the viewer and the inspector share one top line */
.cr-btabs{
  display:flex;height:28px;flex:none;background:var(--head);
  border-bottom:1px solid var(--edge);box-shadow:var(--lift);
}
.cr-btab{
  flex:1;height:100%;min-width:0;padding:0 4px;font-size:11px;font-weight:600;color:var(--t2);
  letter-spacing:.02em;border:0;border-bottom:2px solid transparent;
  background:none;cursor:pointer;font-family:inherit;
}
.cr-btab+.cr-btab{box-shadow:inset 1px 0 0 var(--edge)}
.cr-btab:hover{color:var(--t1)}
.cr-btab[data-on]{color:var(--t1);border-bottom-color:var(--orange);background:var(--panel)}
.cr-bbody{flex:1;min-height:0;display:flex;flex-direction:column}

.cr-viewers{flex:1;display:flex;min-width:0;background:var(--app)}
.cr-inspwrap{flex:none;min-width:0;display:flex}

.cr-tlwrap{
  flex:none;display:flex;flex-direction:column;background:var(--tl);
  box-shadow:var(--lift);min-height:0;overflow:hidden;
}

/* ── media pool ── */
.cr-pool{display:flex;flex-direction:column;min-height:0;flex:1;font-family:var(--ui)}
.cr-poolbar{
  display:flex;align-items:center;gap:8px;padding:7px 10px;flex:none;
  border-bottom:1px solid var(--edge);background:var(--panel-2);box-shadow:var(--lift);
}
.cr-poolbar input{
  flex:1;min-width:0;background:var(--app);border:1px solid var(--edge-soft);border-radius:4px;
  color:var(--t1);font-family:var(--ui);font-size:11.5px;padding:3px 7px;
}
.cr-poolbar input:focus{outline:none;border-color:var(--orange)}
.cr-poolct{font-family:var(--mono);font-size:10px;color:var(--t3);flex:none}
.cr-poolvw{display:flex;gap:1px;flex:none}
.cr-poolvw button{
  width:20px;height:19px;border-radius:4px;color:var(--t3);
  display:flex;align-items:center;justify-content:center;
  background:none;border:0;cursor:pointer;padding:0;
}
.cr-poolvw button[data-on]{color:var(--orange);background:var(--edge-soft)}
.cr-poolnone{padding:20px 12px;font-size:12px;color:var(--t3);text-align:center;border: 1px dashed var(--edge-soft); border-radius: 8px; margin: 20px 12px;}
.cr-poolimp{
  display:flex;align-items:center;gap:5px;flex:none;
  font:inherit;font-size:11.5px;font-weight:600;color:var(--t1);
  background:var(--edge);border:1px solid var(--edge-soft);border-radius:4px;
  padding:3px 8px;cursor:pointer;
}
.cr-poolimp:hover{background:var(--edge-soft)}
/* the whole panel is the drop target, so the whole panel is what lights up:
   a small zone inside a large empty panel is a target people miss */
.cr-pool{position:relative}
.cr-pool[data-over]::after{
  content:'Drop to import';
  position:absolute;inset:6px;z-index:5;pointer-events:none;
  display:flex;align-items:center;justify-content:center;
  font-size:12px;font-weight:600;color:var(--t1);
  border:2px dashed var(--red);border-radius:8px;
  background:color-mix(in srgb, var(--red) 12%, transparent);
}
.cr-grid{
  display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));
  gap:7px;padding:10px;overflow:auto;min-height:0;align-content:start;
}
.cr-mtile{position:relative;min-width:0}
.cr-mclip{background:none;border:0;padding:0;cursor:pointer;text-align:left;font-family:inherit;width:100%;display:block}
/* The remove button is quiet until the tile is under the pointer or the
   keyboard, because a grid of crosses reads as a grid of warnings. */
.cr-mx{
  position:absolute;top:3px;right:3px;width:17px;height:17px;border-radius:3px;
  display:flex;align-items:center;justify-content:center;padding:0;border:0;cursor:pointer;
  background:color-mix(in srgb, var(--app) 78%, transparent);color:var(--t2);
  opacity:0;transition:opacity .12s;
}
.cr-mtile:hover .cr-mx,.cr-mx:focus-visible{opacity:1}
.cr-mx:hover{background:var(--red);color:var(--on-accent)}
.cr-minfo{
  position:absolute;top:3px;right:22px;width:17px;height:17px;border-radius:3px;
  display:flex;align-items:center;justify-content:center;padding:0;border:0;cursor:pointer;
  background:color-mix(in srgb, var(--app) 78%, transparent);color:var(--t2);
  opacity:0;transition:opacity .12s;
}
.cr-mtile:hover .cr-minfo,.cr-minfo:focus-visible{opacity:1}
.cr-minfo:hover{background:var(--orange);color:var(--on-accent)}
.cr-mtile[data-on] .cr-th{border-color:var(--orange);box-shadow:0 0 0 1px var(--orange)}
.cr-mtile[data-on] .cr-nm{color:var(--t1)}
/* How many clips are cut from this file. Absent when the answer is none. */
.cr-muse{
  position:absolute;left:2px;bottom:2px;font-family:var(--mono);font-size:8.5px;
  background:color-mix(in srgb, var(--app) 72%, transparent);
  padding:0 3px;border-radius:1px;color:var(--t2);
}
.cr-th{
  display:block;aspect-ratio:16/9;border-radius:4px;overflow:hidden;
  border:1px solid var(--edge);position:relative;
  background:linear-gradient(135deg, var(--clip-v), var(--clip-v-bar));
  transition: transform 0.15s, border-color 0.15s;
}
.cr-th[data-kind="audio"]{background:linear-gradient(135deg, var(--clip-a), var(--clip-a-bar))}
.cr-th[data-kind="image"]{background:linear-gradient(135deg, var(--clip-b), var(--clip-b-bar))}
.cr-mclip:hover .cr-th{border-color:var(--edge-soft);transform: scale(1.03)}
.cr-mclip:focus-visible .cr-th{border-color:var(--orange)}
.cr-dur{
  position:absolute;right:2px;bottom:2px;font-family:var(--mono);font-size:8.5px;
  background:color-mix(in srgb, var(--app) 72%, transparent);
  padding:0 3px;border-radius:1px;color:var(--t2);
}
.cr-nm{
  display:block;font-size:9.5px;color:var(--t2);margin-top:3px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;
}
.cr-mmeta{display:none;font-family:var(--mono);font-size:9.5px;color:var(--t3);flex:none}
.cr-grid[data-list]{display:block;padding:4px 0}
.cr-grid[data-list] .cr-mclip{display:flex;align-items:center;gap:8px;padding:3px 52px 3px 10px;width:100%}
.cr-grid[data-list] .cr-mclip:hover{background:var(--panel-2)}
.cr-grid[data-list] .cr-mtile[data-on]{background:var(--panel-2)}
.cr-grid[data-list] .cr-mx{top:50%;transform:translateY(-50%);right:8px}
.cr-grid[data-list] .cr-minfo{top:50%;transform:translateY(-50%);right:28px}
.cr-grid[data-list] .cr-muse{display:none}
.cr-grid[data-list] .cr-th{width:46px;flex:none}
.cr-grid[data-list] .cr-dur{display:none}
.cr-grid[data-list] .cr-nm{margin-top:0;flex:1;min-width:0;font-size:11px}
.cr-grid[data-list] .cr-mmeta{display:block}

/* ── toast ── */
.cr-toast{
  position:fixed;bottom:22px;left:50%;transform:translateX(-50%);
  background:var(--head);border:1px solid var(--edge-soft);border-left:2px solid var(--orange);
  padding:9px 14px;border-radius:4px;font-size:12px;color:var(--t1);z-index:140;
  box-shadow:0 8px 24px color-mix(in srgb, var(--app) 50%, transparent);
  opacity:0;pointer-events:none;transition:opacity .2s;
  max-width:min(460px,88vw);font-family:var(--ui);
}
.cr-toast[data-show]{opacity:1}

@media (max-width:860px){
  .cr-app{height:auto;min-height:100vh}
  .cr-upper{flex-direction:column;height:auto}
  /* stacked at this width, so the inline sizes a drag set on a wider screen
     are overridden rather than left to squash the column */
  .cr-browser{width:auto!important;height:340px;border-bottom:1px solid var(--edge)}
  .cr-viewers{height:340px;flex:none}
  .cr-inspwrap{width:auto!important;height:300px;border-top:1px solid var(--edge)}
  .cr-tlwrap{height:340px!important}
}
`;
