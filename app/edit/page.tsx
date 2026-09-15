'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Shell } from '@/components/shell/Shell.tsx';
import { Timeline, type TimelineControls } from '@/components/timeline/Timeline.tsx';
import type { Tool } from '@/components/rail/tools.ts';
import type { ToolRunArgs } from '@/components/assistant/ToolRunCard.tsx';
import { emptyTimeline } from '@/lib/timeline/document.ts';
import { getTemplate } from '@/lib/timeline/templates.ts';
import { NewProjectDialog } from '@/components/shell/NewProjectDialog.tsx';
import { importFile, browserTransport } from '@/lib/media/import.ts';
import { saveProject, openProject, browserProjects, StaleProjectError, type SavedProject, type ProjectSummary } from '@/lib/project/store.ts';
import {
  browserSession, readSession, writeSession, type SessionStore,
} from '@/lib/project/session.ts';
import { mediaUsage, removeMediaOps, removeMediaLabel } from '@/lib/timeline/removeMedia.ts';
import { placeCuesOps, placeSrtOps } from '@/lib/subtitles/place.ts';
import { subtitleKeyOf } from '@/lib/subtitles/output.ts';
import { cuesInOutput } from '@/lib/subtitles/cues.ts';
import { RATES } from '@/lib/time/frames.ts';
import { applyEdits } from '@/lib/timeline/edits.ts';
import { addTrackOp } from '@/lib/timeline/addTrack.ts';
import { createHistory } from '@/lib/timeline/history.ts';
import { findClip, isClip, itemAt, placeTrack } from '@/lib/timeline/document.ts';
import { bladeOps, rippleDeleteOps } from '@/components/timeline/interactions.ts';
import type { EditOp, Timeline as TimelineDoc, ClipId } from '@/lib/timeline/types.ts';
import { frames, toTimecode, rateLabel, rangeEnd, type Frames } from '@/lib/time/frames.ts';
import { MenuBar, useCommandShortcuts } from '@/components/menu/MenuBar.tsx';
import { buildCommands, type Actions } from '@/lib/commands/registry.ts';
import type { CommandContext } from '@/lib/commands/types.ts';
import { matchShortcut, shouldHandle } from '@/lib/commands/shortcuts.ts';
import { createJobStore, runAsJob } from '@/lib/jobs/store.ts';
import { JobsPanel } from '@/components/jobs/JobsPanel.tsx';
import { Workbench } from '@/components/workbench/Workbench.tsx';
import { PlayheadController } from '@/components/timeline/Playhead.tsx';
import { ExportDialog, DEFAULT_EXPORT, toDelivery, type ExportSettings } from '@/components/export/ExportDialog.tsx';
import { runExport } from '@/lib/export/client.ts';
import type { ExportEvent, ExportResult } from '@/lib/export/types.ts';
import { timelineDuration } from '@/lib/timeline/document.ts';
import { paramsToEffects, effectsToParams, unrenderable } from '@/lib/inspector/effects.ts';
import type { ClipParams } from '@/components/inspector/types.ts';
import { useWorkbenchHotkey } from '@/components/workbench/useWorkbench.ts';
import { createExecutor } from '@/lib/executor/executor.ts';
import { browserTransport as executorBrowserTransport } from '@/lib/executor/browserTransport.ts';
import { reconcileOutputs } from '@/lib/timeline/reconcile.ts';
import { applyEvent, initialRun, type FoldedRun } from '@/lib/executor/fold.ts';
import { resolveToolSource, isRefusal } from '@/lib/tools/source.ts';
import { readBrollPlan, brollMarkerOps, brollSummary } from '@/lib/tools/broll-plan.ts';
import type { RunState, ExecutorEvent } from '@/lib/executor/types.ts';
import type { Plan } from '@/lib/router/plan.ts';
import { toolTier } from '@/components/rail/tools.ts';
import { getCard } from '@/lib/intel/index.ts';

/**
 * The editor.
 *
 * This is the one place that owns the document. Everything below takes a
 * timeline and emits `EditOp[]`, which keeps the components testable and
 * means there is exactly one function in the app that mutates state.
 *
 * A batch is one undo. That is not a convenience: it mirrors how the server
 * stores an edit (`POST /v1/timelines/{id}/edits`, all of them or none, one
 * revision), so an assistant run that moves fifty clips reverses in a single
 * step, here and there.
 */
/**
 * How long two changes to the same clip count as one gesture.
 *
 * Long enough to cover the gap between pointer moves on a slider, short
 * enough that two deliberate nudges stay two undos.
 */
const COALESCE_MS = 700;

export default function EditorPage() {
  /**
   * An empty project, not a sample one.
   *
   * The demo timeline still exists in lib/fixtures for the tests, which need
   * a document with real shapes in it. It has no business being someone's
   * starting state: an editor that opens holding someone else's footage is
   * asking you to delete it before you can begin.
   */
  const [doc, setDoc] = useState<TimelineDoc>(() => emptyTimeline('tl_untitled', 'Untitled', RATES.film));
  const [playhead, setPlayhead] = useState<Frames>(() => frames(0));
  const [selection, setSelection] = useState<ReadonlySet<ClipId>>(() => new Set());
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [saved, setSaved] = useState<SavedProject | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [revisions, setRevisions] = useState<{ id: string; name: string; list: Array<{ revision: number; createdAt?: string; name?: string }> } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  /** The media key the remove dialog is asking about. */
  const [removing, setRemoving] = useState<string | null>(null);
  /** The workbench is an overlay over the cut, opened like devtools. */
  const [benchOpen, setBenchOpen] = useState(false);

  /**
   * Export.
   *
   * `pipelineId` is kept for the life of the session so a second render
   * replaces the first project's pipeline instead of leaving another behind.
   * The previous attempt at this created one per compile and the account
   * still carries the litter.
   */
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSettings, setExportSettings] = useState<ExportSettings>(DEFAULT_EXPORT);
  const [exportProgress, setExportProgress] = useState<ExportEvent | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [snapping, setSnapping] = useState(true);
  /**
   * What only the timeline can do, once it has told us it can.
   *
   * State rather than a ref because the commands are rebuilt from it and a
   * ref read during render is a read of something React has not promised is
   * committed.
   */
  const [tlControls, setTlControls] = useState<TimelineControls | null>(null);
  const [linked, setLinked] = useState(true);
  const [runs, setRuns] = useState<RunState[]>([]);
  const [runTitles, setRunTitles] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  /**
   * One job store for the whole session. Everything the app does on your
   * behalf lands here with a log: an import, a save, a blade, a GPU run.
   */
  const [jobs] = useState(() => createJobStore());

  /**
   * The one playhead clock, owned here.
   *
   * Both the timeline and the viewer take it, so pressing play in the viewer
   * moves the timeline's playhead and vice versa. Built once with `useState`
   * rather than `useRef().current`, because a ref read during render is a
   * read of something React has not promised is committed.
   */
  const [clock] = useState(() => new PlayheadController(RATES.film, frames(0)));

  // a project opened at another rate: the clock counts in frames and has to
  // be told which frames they are, or playback runs at the wrong speed
  useEffect(() => { clock.rate = doc.rate; }, [clock, doc.rate]);

  // the document is the authority on where the playhead may go
  useEffect(() => { clock.setLimit(timelineDuration(doc)); }, [clock, doc]);

  // the clock moves continuously; React hears about the frames it lands on
  useEffect(() => clock.subscribe(setPlayhead), [clock]);

  /**
   * A playhead restored from the last session, parked until the document it
   * belongs to has arrived.
   *
   * Seeking straight away would land on zero every time: the clock is limited
   * by the timeline's duration, and at the moment the session is read the
   * timeline is still the empty one. This effect is declared after the one
   * that sets the limit, so within the commit that brings the document in the
   * limit moves first and the seek lands where it was left.
   *
   * It carries the document it belongs to, and waits for that exact document
   * to be the current one. Gating on anything looser does not work: in
   * development React runs mount effects twice, so this one fired once with
   * the restored frame already parked and the empty timeline still in state,
   * clamped the seek to zero against a limit of zero, and consumed the
   * number. The playhead then came back at the start every time while the
   * snapshot on disk plainly said frame 27.
   *
   * A ref rather than state, because nothing renders from it: as state it
   * would cost a render of the whole editor to deliver one number to a clock
   * that is not React's to begin with.
   */
  const pendingSeek = useRef<{ at: number; forDoc: TimelineDoc } | null>(null);
  useEffect(() => {
    const parked = pendingSeek.current;
    if (!parked || parked.forDoc !== doc) return;
    pendingSeek.current = null;
    clock.seek(frames(parked.at));
  }, [clock, doc]);

  /**
   * Created once and never replaced. `useState` with an initialiser rather
   * than `useRef().current`, because reading a ref during render is a read of
   * something React does not promise has been committed.
   */
  const [history] = useState(() => createHistory());
  /**
   * The stack is a ref, but the buttons that describe it are rendered, so its
   * shape is mirrored into state. Reading the ref during render would be a
   * torn read: React is free to render without the mutation having happened.
   */
  const [stack, setStack] = useState<{ undo: string[]; redo: string[] }>({ undo: [], redo: [] });
  const syncStack = useCallback(() => {
    setStack({ undo: [...history.labels.undo], redo: [...history.labels.redo] });
  }, [history]);

  /**
   * One notice at a time, cleared by an effect rather than by a timer handle
   * held in a ref. The id makes an identical repeated message still count as
   * a new one, so pressing the same failing button twice visibly does
   * something both times.
   */
  const note = useCallback((message: string) => {
    setToast({ id: Date.now(), text: message });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  /**
   * The only mutation in the app.
   *
   * Deliberately not written as a functional `setDoc(current => ...)`: React
   * may call an updater more than once, and this one pushes onto the undo
   * stack. Reading `doc` from the closure keeps the side effect exactly once.
   */
  const commit = useCallback((ops: EditOp[], label: string, opts: { coalesce?: boolean } = {}) => {
    try {
      let { timeline, inverse } = applyEdits(doc, ops);
      if (opts.coalesce) {
        // A coalesced tweak is part of the same continuous user gesture;
        // keep the revision stable so micro-slider ticks do not inflate rev.
        timeline = { ...timeline, revision: doc.revision };
      }
      history.push(label, inverse, opts.coalesce);
      setDoc(timeline);
      setDirty(true);
      syncStack();
      // a local patch is still a job: a list with holes in it is worse than
      // no list, because you cannot tell "nothing happened" from "not recorded".
      // A coalesced change is part of one gesture that is already recorded,
      // so it does not get its own line.
      if (!opts.coalesce) {
        const j = jobs.start('edit', label);
        j.log(`${ops.length} op${ops.length === 1 ? '' : 's'} applied`, 'info', ops.map((o) => o.op));
        j.setRevision(timeline.revision);
        jobs.finish(j.id, 'done');
      }
    } catch (e) {
      note((e as Error).message);   // atomic: a rejected batch changes nothing
    }
  }, [doc, history, note, syncStack, jobs]);

  /**
   * Inspector values reach the document.
   *
   * Coalesced by clip: dragging a slider fires on every pixel, and one undo
   * entry per pixel makes undo useless. Consecutive changes to the same clip
   * replace each other in the stack, so one drag is one undo, which is how
   * the rest of the editor behaves.
   *
   * The values that no operation can render (zoom, position, opacity, blend,
   * pan) are said out loud rather than written and silently ignored.
   */
  const lastParamClip = useRef<{ id: string; at: number } | null>(null);

  const onClipParams = useCallback((clipId: string, next: ClipParams) => {
    const placed = findClip(doc, clipId as ClipId);
    if (!placed || !isClip(placed.item)) return;
    const media = doc.media[placed.item.mediaKey];
    const { effects, skipped } = paramsToEffects(next, placed.item.effects, media);

    const now = Date.now();
    const prev = lastParamClip.current;
    const coalesce = prev?.id === clipId && now - prev.at < COALESCE_MS;
    lastParamClip.current = { id: clipId, at: now };

    commit(
      [{ op: 'patch_clip', clipId: clipId as ClipId, set: { effects } }],
      `Adjust ${placed.item.name}`,
      { coalesce },
    );

    if (skipped.length) note(skipped[0]);
  }, [doc, commit, note]);

  const step = useCallback((direction: 'undo' | 'redo') => {
    let next = doc;
    const label = history[direction]((ops) => {
      const result = applyEdits(next, ops);
      next = result.timeline;
      return result.inverse;
    });
    if (!label) { note(`Nothing to ${direction}`); return; }
    setDoc(next);
    syncStack();
    note(`${direction === 'undo' ? 'Undo' : 'Redo'} ${label}`);
  }, [doc, history, note, syncStack]);

  /**
   * What survives the tab closing.
   *
   * Everything here used to live in React state and nowhere else, so a
   * refresh threw away every import, every cut and every setting since the
   * last Save, and Save is something you have to remember to do. The copy is
   * the same OTIO document the server stores, written to the browser: not a
   * second format to keep in step, and read back through the same strict
   * reader, so a snapshot from an older build says what is wrong with it
   * rather than half-loading.
   *
   * It is a copy, not a home. The server is still where a project lives, and
   * this is deliberately not called a save anywhere in the interface.
   */
  const sessionRef = useRef<SessionStore | null>(null);
  const restoredRef = useRef(false);
  /** Said once. A failing write fails every time, and saying so every time is noise. */
  const writeFailedRef = useRef(false);
  const latest = useRef({ doc, saved, dirty, pipelineId: null as string | null, playhead: 0 });

  useEffect(() => {
    latest.current = { doc, saved, dirty, pipelineId, playhead };
  });

  /**
   * Restoring writes state from inside an effect, which the compiler flags,
   * and here that is the correct shape rather than a shortcut. The page is
   * server-rendered: a `useState` initialiser reaching for `localStorage`
   * runs on the server too, where there is none, and the client would then
   * render a different document than the HTML it is hydrating. Reading after
   * mount is what an effect is for. It runs once, guarded by a ref.
   */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    const store = browserSession();
    sessionRef.current = store;
    if (!store) return;   // private mode, or storage switched off. Not an error.

    const r = readSession(store, RATES.film);
    if (!r.found) return;
    if (!r.ok) {
      // left in place rather than deleted: it is the only copy of that work,
      // and a future build may be able to read it
      note(`Could not restore the last session: ${r.reason}`);
      return;
    }

    setDoc(r.state.timeline);
    setSaved(r.state.project);
    setDirty(r.state.dirty);
    setPipelineId(r.state.pipelineId);
    pendingSeek.current = { at: r.state.playhead, forDoc: r.state.timeline };
    const clips = r.state.timeline.tracks.reduce(
      (n, t) => n + t.items.filter((i) => i.kind === 'clip').length, 0);
    const pool = Object.keys(r.state.timeline.media).length;
    note(`Picked up ${r.state.timeline.name}: ${pool} file${pool === 1 ? '' : 's'}, ${clips} clip${clips === 1 ? '' : 's'}${r.state.dirty ? ', not saved to the server' : ''}`);
  }, [note]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /**
   * Trailing debounce, and that is load-bearing rather than tidy: the
   * playhead changes on every frame while something is playing, so each tick
   * cancels the pending write and the copy is made once, when the motion
   * stops, instead of forty times a second.
   */
  useEffect(() => {
    const store = sessionRef.current;
    if (!store || !restoredRef.current) return;
    const timer = setTimeout(() => {
      const r = writeSession(store, { timeline: doc, project: saved, dirty, pipelineId, playhead });
      if (!r.ok && !writeFailedRef.current) {
        writeFailedRef.current = true;
        note(`Could not keep a local copy of this project: ${r.reason}`);
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [doc, saved, dirty, pipelineId, playhead, note]);

  /**
   * Autosave to the server when the project has been saved at least once
   * and is currently dirty. Uses a 5-second trailing debounce so rapid edits
   * are batched into a single server save without interrupting the user.
   */
  useEffect(() => {
    if (!saved || !dirty) return;
    const timer = setTimeout(async () => {
      try {
        const r = await saveProject(doc, saved, browserProjects());
        setSaved(r.project);
        setDoc(r.timeline);
        setDirty(false);
        note(`Autosaved "${r.project.name}" (rev ${r.project.revision})`);
      } catch {
        // silent fail on network or conflict, don't interrupt editing
      }
    }, 5000);
    return () => clearTimeout(timer);
  }, [doc, saved, dirty, note]);

  /**
   * The tab going away does not wait 900ms, so the last state is written on
   * the way out. `pagehide` rather than `beforeunload`: it is the one that
   * fires on iOS and when a tab is put into the back/forward cache.
   */
  useEffect(() => {
    const flush = () => {
      const store = sessionRef.current;
      if (!store || !restoredRef.current) return;
      const l = latest.current;
      writeSession(store, {
        timeline: l.doc, project: l.saved, dirty: l.dirty,
        pipelineId: l.pipelineId, playhead: l.playhead,
      });
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  const selectedPlaced = useMemo(() => {
    const first = [...selection][0];
    return first ? findClip(doc, first) : null;
  }, [doc, selection]);

  /**
   * What the commands are allowed to do.
   *
   * Anything that talks to the server goes through `job`, so it is recorded
   * whether it succeeds or not. A list missing its failures is worse than no
   * list at all.
   */
  const actions: Actions = useMemo(() => ({
    edit: commit,
    undo: () => step('undo'),
    redo: () => step('redo'),
    seek: (to: number) => clock.seek(frames(Math.max(0, Math.round(to)))),
    job: async (kind, label, body) => {
      const r = await runAsJob(jobs, kind, label, async (job) => {
        job.log('starting');
        return body();
      });
      if (!r.ok) note(`${label} failed: ${r.error.message}`);
      setJobsOpen(true);
      return r.ok ? r.value : undefined;
    },
    newProject: () => {
      setNewProjectOpen(true);
    },

    open: () => {
      void runAsJob(jobs, 'open', 'List projects', async (job) => {
        const list = await browserProjects().list();
        job.log(`${list.length} project${list.length === 1 ? '' : 's'} on the server`);
        setProjects(list);
        return list.length;
      });
    },

    save: async () => {
      await runAsJob(jobs, 'save', saved ? `Save ${doc.name}` : `Save ${doc.name} (first time)`,
        async (job) => {
          if (!saved) job.log('no home on the server yet, creating one');
          try {
            const r = await saveProject(doc, saved, browserProjects());
            job.log(`revision ${r.project.revision}`, 'info', { id: r.project.id });
            job.setRevision(r.project.revision);
            setSaved(r.project);
            setDoc(r.timeline);
            setDirty(false);
            note(`Saved as revision ${r.project.revision}`);
            return r.project;
          } catch (e) {
            if (e instanceof StaleProjectError) {
              // Retrying with a fresh etag would overwrite whoever moved first,
              // so the honest answer is to stop and say so.
              note('Someone else changed this project. Reopen it and reapply.');
            }
            throw e;
          }
        });
    },

    saveAs: async () => {
      const name = window.prompt('Save as', `${doc.name} copy`)?.trim();
      if (!name) return;
      await runAsJob(jobs, 'save', `Save as "${name}"`, async (job) => {
        const next = { ...doc, name };
        const r = await saveProject(next, null, browserProjects());
        job.log(`new project ${r.project.id}, revision ${r.project.revision}`);
        setSaved(r.project); setDoc(r.timeline); setDirty(false);
        note(`Saved as "${name}"`);
        return r.project;
      });
    },
    importMedia: () => document.getElementById('cr-import-input')?.click(),
    exportVideo: () => {
      setExportResult(null);
      setExportError(null);
      setExportProgress(null);
      setExportOpen(true);
    },
    toggleSnapping: () => setSnapping((v) => !v),
    toggleLinked: () => setLinked((v) => !v),
    bladeAtPlayhead: () => {
      const at = clock.get();
      const ops: EditOp[] = [];
      for (const track of doc.tracks) {
        if (track.locked || !track.autoSelect) continue;
        const placed = itemAt(track, at);
        if (!placed || !isClip(placed.item)) continue;
        if (at <= placed.range.start || at >= rangeEnd(placed.range)) continue;
        ops.push(...bladeOps(placed, at, `clp_${Math.random().toString(36).slice(2, 10)}`));
      }
      if (!ops.length) { note('Nothing under the playhead to cut'); return; }
      commit(ops, 'Blade');
      note(`Cut ${ops.length / 2} clip${ops.length === 2 ? '' : 's'}`);
    },
    rippleDelete: () => {
      const first = [...selection][0];
      const placed = first ? findClip(doc, first) : null;
      if (!placed) { note('Select a clip to ripple delete'); return; }
      /**
       * A cue is deleted where it stands, not rippled.
       *
       * Rippling a subtitle track pulls every later cue earlier by the length
       * of the one removed, which puts all of them on the wrong words. The
       * hole is the right answer: nobody is speaking there. Without this the
       * batch would be empty and the toast would still say "Ripple deleted",
       * which a caption becoming selectable is what made reachable.
       */
      if (placed.item.kind === 'caption') {
        commit([{ op: 'remove_caption', captionId: placed.item.id }], 'Delete caption');
        setSelection(new Set());
        note('Caption deleted');
        return;
      }
      commit(rippleDeleteOps(doc, placed), 'Ripple delete');
      setSelection(new Set());
      note('Ripple deleted');
    },
    addTrack: (kind) => {
      const op = addTrackOp(doc, kind);
      commit([op], `Add ${op.op === 'add_track' ? op.track.name : kind}`);
    },
    zoomFit: () => { if (tlControls) tlControls.zoomFit(); else note('The timeline is not ready yet'); },
    zoomIn: () => { if (tlControls) tlControls.zoomIn(); else note('The timeline is not ready yet'); },
    zoomOut: () => { if (tlControls) tlControls.zoomOut(); else note('The timeline is not ready yet'); },
    openWorkbench: () => setBenchOpen(true),
    openJobs: () => setJobsOpen(true),
    selectAll: () => { if (tlControls) tlControls.selectAll(); else note('The timeline is not ready yet'); },
    notify: note,
  }), [commit, step, doc, jobs, note, saved, tlControls, clock, selection]);

  const commands = useMemo(() => buildCommands(actions), [actions]);

  /**
   * The inspector reads from the document, not from a copy beside it.
   *
   * Held anywhere else, a crop survives until the page reloads and then is
   * gone, and the next slider drag writes a default over it.
   */
  const clipParams = useMemo(() => {
    const out: Record<string, ClipParams> = {};
    for (const track of doc.tracks) {
      for (const item of track.items) {
        if (item.kind !== 'clip' || !item.effects.length) continue;
        out[item.id] = effectsToParams(item, doc.media[item.mediaKey]);
      }
    }
    return out;
  }, [doc]);

  const cmdContext: CommandContext = useMemo(() => ({
    timeline: doc,
    playhead,
    selection,
    selected: selectedPlaced,
    canUndo: stack.undo.length > 0,
    canRedo: stack.redo.length > 0,
    undoLabel: stack.undo[0] ?? null,
    redoLabel: stack.redo[0] ?? null,
    savedId: saved?.id ?? null,
    dirty,
    busy: false,
    snapping,
    linked,
  }), [doc, playhead, selection, selectedPlaced, stack, saved, dirty, snapping, linked]);

  // the same chord as the standalone route, so one habit works in both
  useWorkbenchHotkey(useCallback(() => setBenchOpen((o) => !o), []));

  useCommandShortcuts(
    commands,
    cmdContext,
    (e, c) => matchShortcut(e, c.shortcut),
    (e) => shouldHandle(e, e.target),
  );

  /**
   * Import, for real: presign, upload straight to storage, probe, then put it
   * in the pool as one edit so the whole import is a single undo.
   *
   * Files are done one at a time rather than in parallel. A browser will
   * happily open twenty uploads at once and starve every one of them, and the
   * progress of a queue is legible in a way that twenty bars are not.
   */
  const importFiles = useCallback(async (files: File[]) => {
    note(`Importing ${files.length} file${files.length === 1 ? '' : 's'}...`);
    const transport = browserTransport();
    const imported: EditOp[] = [];

    const r = await runAsJob(jobs, 'import', `Import ${files.length} file${files.length === 1 ? '' : 's'}`,
      async (job) => {
        const failures: string[] = [];
        for (const [i, file] of files.entries()) {
          job.log(`(${i + 1}/${files.length}) ${file.name}`);
          try {
            const result = await importFile(file, doc.rate, transport, job);
            imported.push(result.op);
          } catch (err) {
            // one bad file must not lose the good ones already uploaded
            failures.push(`${file.name}: ${(err as Error).message}`);
            job.log(`${file.name} failed`, 'error', (err as Error).message);
          }
        }
        if (failures.length && !imported.length) throw new Error(failures.join('; '));
        return { added: imported.length, failed: failures.length };
      });

    if (imported.length) {
      commit(imported, `Import ${imported.length} file${imported.length === 1 ? '' : 's'}`);
      note(`Imported ${imported.length} file${imported.length === 1 ? '' : 's'}`);
    } else if (!r.ok) {
      note(`Import failed: ${r.error.message}`);
    }
  }, [doc.rate, jobs, commit, note]);

  /**
   * Taking a file back out.
   *
   * Asked before it happens, always, and the question names what goes with
   * it: a file with three clips cut from it takes those three clips, and
   * finding that out afterwards is finding it out too late. One batch, so
   * one undo puts the file and every clip back.
   */
  const removingUsage = useMemo(
    () => (removing ? mediaUsage(doc, removing) : null),
    [doc, removing],
  );

  const confirmRemove = useCallback(() => {
    if (!removing) return;
    const usage = mediaUsage(doc, removing);
    setRemoving(null);
    if (!usage) { note('That file is no longer in the pool'); return; }

    const going = new Set(usage.clips.map((c) => c.item.id));
    commit(removeMediaOps(doc, removing), removeMediaLabel(usage));
    // a selection pointing at a clip that no longer exists is a selection the
    // inspector reads from and finds nothing behind
    if (going.size) setSelection((prev) => new Set([...prev].filter((id) => !going.has(id))));
    note(`${removeMediaLabel(usage)}. Undo puts it back.`);
  }, [removing, doc, commit, note]);

  const renameMedia = useCallback((key: string, newName: string) => {
    const existing = doc.media[key];
    if (!existing || !newName.trim()) return;
    commit([{ op: 'add_media', media: { ...existing, name: newName.trim() } }], `Rename ${existing.name}`);
    note(`Renamed to "${newName.trim()}"`);
  }, [doc.media, commit, note]);

  const reextractFrames = useCallback(async (key: string) => {
    const existing = doc.media[key];
    if (!existing) return;
    note(`Extracting thumbnails for ${existing.name}...`);
    try {
      const transport = browserTransport();
      if (!transport.thumbnails) throw new Error('thumbnails transport not available');
      const stills = await transport.thumbnails(existing.key, existing.kind === 'image' ? 1 : 8, existing.kind);
      commit([{ op: 'add_media', media: { ...existing, frames: stills } }], `Re-extract frames for ${existing.name}`);
      note(`Extracted ${stills.length} frames for ${existing.name}`);
    } catch (e) {
      note(`Frame extraction failed: ${(e as Error).message}`);
    }
  }, [doc.media, commit, note]);

  const replaceMedia = useCallback(async (key: string, file: File) => {
    const existing = doc.media[key];
    if (!existing) return;
    note(`Replacing ${existing.name} with ${file.name}...`);
    const transport = browserTransport();
    const r = await runAsJob(jobs, 'import', `Replace ${existing.name}`, async (job) => {
      return importFile(file, doc.rate, transport, job);
    });
    if (!r.ok) {
      note(`Replace failed: ${r.error.message}`);
      return;
    }
    const result = r.value;
    const patchOps: EditOp[] = [];
    for (const track of doc.tracks) {
      for (const item of track.items) {
        if (item.kind === 'clip' && item.mediaKey === key) {
          patchOps.push({
            op: 'patch_clip',
            clipId: item.id,
            set: { mediaKey: result.media.key },
          });
        }
      }
    }
    commit([result.op, ...patchOps], `Replace ${existing.name} with ${file.name}`);
    note(`Replaced ${existing.name} with ${file.name}`);
  }, [doc.media, doc.rate, doc.tracks, jobs, commit, note]);

  const relinkMedia = useCallback((key: string, newKey: string) => {
    const existing = doc.media[key];
    if (!existing || !newKey.trim()) return;
    const updated = { ...existing, key: newKey.trim() };
    const patchOps: EditOp[] = [];
    for (const track of doc.tracks) {
      for (const item of track.items) {
        if (item.kind === 'clip' && item.mediaKey === key) {
          patchOps.push({
            op: 'patch_clip',
            clipId: item.id,
            set: { mediaKey: newKey.trim() },
          });
        }
      }
    }
    commit([{ op: 'add_media', media: updated }, ...patchOps], `Relink ${existing.name}`);
    note(`Relinked ${existing.name} to ${newKey.trim()}`);
  }, [doc.media, doc.tracks, commit, note]);

  const openById = useCallback(async (id: string) => {
    setProjects(null);
    await runAsJob(jobs, 'open', 'Open project', async (job) => {
      const r = await openProject(id, browserProjects(), doc.rate);
      job.log(`${r.timeline.tracks.length} tracks, revision ${r.project.revision}`);
      setSaved(r.project);
      setDoc(r.timeline);
      setPipelineId(r.timeline.exportPipelineId ?? null);
      setDirty(false);
      setPlayhead(frames(0));
      history.clear();
      syncStack();
      note(`Opened ${r.project.name}`);
      return r.project;
    });
  }, [jobs, doc.rate, history, syncStack, note]);

  const refreshProjects = useCallback(async () => {
    try {
      const list = await browserProjects().list();
      setProjects(list);
    } catch {
      // ignore
    }
  }, []);

  const deleteProjectById = useCallback(async (id: string, name: string) => {
    if (!window.confirm(`Delete project "${name}"? This cannot be undone.`)) return;
    try {
      await browserProjects().delete(id);
      note(`Deleted ${name}`);
      await refreshProjects();
    } catch (e) {
      note(`Failed to delete: ${(e as Error).message}`);
    }
  }, [refreshProjects, note]);

  const renameProjectById = useCallback(async (id: string, currentName: string) => {
    const newName = window.prompt('Rename project to:', currentName);
    if (!newName || newName.trim() === '' || newName === currentName) return;
    try {
      await browserProjects().rename(id, newName.trim());
      note(`Renamed to ${newName.trim()}`);
      if (saved?.id === id) {
        setSaved((prev) => (prev ? { ...prev, name: newName.trim() } : null));
        setDoc((prev) => ({ ...prev, name: newName.trim() }));
      }
      await refreshProjects();
    } catch (e) {
      note(`Failed to rename: ${(e as Error).message}`);
    }
  }, [saved, refreshProjects, note]);

  const duplicateProjectById = useCallback(async (id: string, name: string) => {
    try {
      const copy = await browserProjects().duplicate(id, `${name} Copy`);
      note(`Created copy: ${copy.name}`);
      await refreshProjects();
    } catch (e) {
      note(`Failed to duplicate: ${(e as Error).message}`);
    }
  }, [refreshProjects, note]);

  const showRevisions = useCallback(async (id: string, name: string) => {
    try {
      const revs = await (browserProjects().listRevisions?.(id) ?? Promise.resolve([]));
      setRevisions({ id, name, list: revs });
    } catch (e) {
      note(`Could not load revisions: ${(e as Error).message}`);
    }
  }, [note]);

  const restoreRevisionById = useCallback(async (id: string, rev: number) => {
    if (!window.confirm(`Restore project to revision ${rev}?`)) return;
    try {
      await browserProjects().restoreRevision?.(id, rev);
      setRevisions(null);
      setProjects(null);
      await openById(id);
      note(`Restored to revision ${rev}`);
    } catch (e) {
      note(`Could not restore revision: ${(e as Error).message}`);
    }
  }, [openById, note]);

  /**
   * Render.
   *
   * One job with a log, like everything else here: the render is minutes long
   * and the panel is where someone looks to find out what it did, including
   * the compiler's warnings, which are the part worth reading afterwards.
   */
  const startExport = useCallback(async () => {
    setExportResult(null);
    setExportError(null);
    setExportProgress({ phase: 'compiling', message: 'Starting' });
    setJobsOpen(true);

    const r = await runAsJob(jobs, 'export', `Export ${doc.name}`, async (job) => {
      const out = await runExport(
        {
          timeline: doc,
          delivery: toDelivery(exportSettings),
          pipelineId: pipelineId ?? doc.exportPipelineId ?? null,
          name: doc.name,
          burnSubtitles: exportSettings.burnSubtitles,
          range: exportSettings.rangeMode === 'custom' && exportSettings.rangeDuration
            ? { start: exportSettings.rangeStart ?? 0, duration: exportSettings.rangeDuration }
            : undefined,
        },
        (e) => {
          setExportProgress(e);
          job.log(e.message, 'info', e.detail);
          if (typeof e.progress === 'number') job.progress(e.progress);
        },
      );
      job.log(`rendered ${out.key}`, 'info', { runId: out.runId, pipelineId: out.pipelineId });
      return out;
    });

    if (r.ok) {
      setExportResult(r.value);
      setPipelineId(r.value.pipelineId);
      setDoc((prev) => ({ ...prev, exportPipelineId: r.value.pipelineId }));
      setExportProgress(null);
      note('Rendered');
    } else {
      setExportError(r.error.message);
      setExportProgress(null);
    }
  }, [doc, exportSettings, jobs, note, pipelineId]);

  /**
   * A rung 1 tool: a local patch, applied now.
   *
   * These three are the only tools that touch nothing but the document, which
   * is why they can run at all. Everything above rung 1 needs the executor
   * and a published pipeline, and `runTool` says so rather than pretending.
   */
  const runLocalTool = useCallback((tool: Tool) => {
    const at = clock.get();

    if (tool.id === 'timeline-blade') {
      // every unlocked track the playhead is over, which is what a blade does
      const ops: EditOp[] = [];
      for (const track of doc.tracks) {
        if (track.locked || !track.autoSelect) continue;
        const placed = itemAt(track, at);
        if (!placed || !isClip(placed.item)) continue;
        if (at <= placed.range.start || at >= rangeEnd(placed.range)) continue;
        ops.push(...bladeOps(placed, at, `clp_${Math.random().toString(36).slice(2, 10)}`));
      }
      if (!ops.length) { note('Nothing under the playhead to cut'); return; }
      commit(ops, 'Blade');
      note(`Cut ${ops.length / 2} clip${ops.length === 2 ? '' : 's'}`);
      return;
    }

    if (tool.id === 'timeline-ripple') {
      const first = [...selection][0];
      const placed = first ? findClip(doc, first) : null;
      if (!placed) { note('Select a clip to ripple delete'); return; }
      commit(rippleDeleteOps(doc, placed), 'Ripple delete');
      setSelection(new Set());
      return;
    }

    if (tool.id === 'timeline-punch') {
      const first = [...selection][0];
      const placed = first ? findClip(doc, first) : null;
      if (!placed || !isClip(placed.item)) { note('Select a clip to punch in on'); return; }
      // The card asks for scale 1.18, and there is no scale operation in the
      // catalogue. Saying so beats writing an effect the render drops.
      note('Punch in needs a scale operation, which the editor API does not have');
      return;
    }

    note(`${tool.name} has no local implementation yet`);
  }, [clock, doc, selection, commit, note]);

  /**
   * Run a plan from the assistant.
   *
   * Executes through the executor engine: Rung 1 steps execute as local
   * document patches via applyLocal and commit(), while Rung 2+ steps run
   * through the browser transport and stream live progress.
   */
  /**
   * What a finished pipeline run actually produced, put where it can be seen.
   *
   * A run that ends with a note saying "completed" and nothing on the
   * timeline has not delivered anything. `broll-b1` hands back JSON, so its
   * cutaways land as markers against the clip the pipeline read, which is why
   * the media key travels with the plan: the plan counts in the SOURCE
   * file's seconds and only that clip knows where those seconds sit on the
   * timeline. Returns the line to show, or null to leave the default.
   */
  const placePlanResult = useCallback(async (
    runIds: string[],
    extra: Record<string, unknown>,
    title: string,
  ): Promise<string | null> => {
    const mediaKey = typeof extra.sourceMediaKey === 'string' ? extra.sourceMediaKey : null;
    if (!runIds.length || !mediaKey) return null;

    /** The clip a pipeline read, which is the only thing that can place its times. */
    const clipForMedia = (key: string) => doc.tracks
      .filter((t) => t.kind === 'video')
      .flatMap((t) => placeTrack(t).map((pl) => ({ ...pl, trackId: t.id })))
      .find((pl) => isClip(pl.item) && pl.item.mediaKey === key) ?? null;

    for (const runId of runIds) {
      let output: Record<string, unknown> | null = null;
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
        const body = await res.json().catch(() => null);
        if (!res.ok || !body) continue;
        output = (body.output ?? null) as Record<string, unknown> | null;
      } catch {
        continue;   // the run finished; not being able to re-read it is not a failure of the run
      }
      if (!output) continue;

      /**
       * Subtitles: the words onto the timeline, not just a file in the pool.
       *
       * This is the step that was missing. The transcription succeeded, a
       * subtitle track was added, and the cues were left sitting in an object
       * nobody read, so the run said "done" over an empty track.
       *
       * The times are in the SOURCE file's seconds, so they are offset by
       * where that clip actually sits on the timeline, exactly as the B-roll
       * markers are.
       *
       * The reply's cues come before the file the same run wrote. whisperx
       * fills lines rather than honouring the segments it aligned, so that
       * file is two eight-second blocks where the aligned result is six
       * sentences (`lib/subtitles/cues.ts` carries the measurement), and the
       * reply is already in hand, so the better answer is also the cheaper
       * one. The file stays as the fallback, for an imported SRT and for a
       * pipeline that returns nothing else.
       */
      const cues = cuesInOutput(output, doc.rate);
      const srtKey = cues.length ? null : subtitleKeyOf(output);

      // A run that transcribed silence is a real answer, and "completed" over
      // an empty subtitle track is the exact failure this fold exists to stop.
      if (!cues.length && !srtKey
        && ('degenerate' in output || 'transcript' in output || 'language' in output)) {
        return `${title}: no speech was found, so there is nothing to caption`;
      }

      if (cues.length || srtKey) {
        const clip = clipForMedia(mediaKey);
        if (!clip) return `${title}: the clip it read is no longer on the timeline`;
        try {
          const offset = frames(clip.range.start - (isClip(clip.item) ? clip.item.sourceRange.start : 0));
          // one batch, which is one undo: the track it needs is made inside it
          const place = { offset, seed: runId.slice(-8), createTrack: true };

          let ops: EditOp[];
          let count: number;
          if (srtKey) {
            const res = await fetch(`/api/outputs/read?key=${encodeURIComponent(srtKey)}`);
            const body = await res.json().catch(() => null);
            if (!res.ok || typeof body?.text !== 'string') {
              return `${title}: the subtitles were made and could not be read back (${body?.error ?? res.status})`;
            }
            const fromFile = placeSrtOps(doc, body.text, doc.rate, place);
            ops = fromFile.ops;
            count = fromFile.cues.length;
          } else {
            ops = placeCuesOps(doc, cues, place);
            count = cues.length;
          }

          if (!count) return `${title}: no speech was found, so there is nothing to caption`;
          commit(ops, `${title}: ${count} caption${count === 1 ? '' : 's'}`);
          return `${title}: ${count} caption${count === 1 ? '' : 's'} on the timeline`;
        } catch (e) {
          return `${title}: the subtitles were made and could not be placed: ${(e as Error).message}`;
        }
      }

      const plan = readBrollPlan(output.broll_plan);
      if (!plan) continue;

      // the clip the pipeline read, which is the one that can place its times
      const clip = clipForMedia(mediaKey);
      if (!clip) {
        return `${title}: planned ${plan.broll.length}, but the clip it read is no longer on the timeline`;
      }

      const stamp = Date.now().toString(36);
      const { ops, placed, outside } = brollMarkerOps(
        plan, clip, doc.rate, (i) => `mrk_${stamp}_${i}`,
      );
      if (ops.length) commit(ops, `${title}: ${placed} marker${placed === 1 ? '' : 's'}`);
      return `${title}: ${brollSummary(plan, placed, outside)}`;
    }
    return null;
  }, [doc, commit]);

  const executePlan = useCallback(async (plan: Plan, extra: Record<string, unknown> = {}) => {
    if (busy) return;
    setBusy(true);

    const title = plan.intent || plan.cardId;
    const transport = executorBrowserTransport();
    /**
     * The API's run ids, which are not the executor's.
     *
     * A pipeline whose output is JSON emits no job outputs at all, so the
     * folded run has nothing in it to show and the result has to be read back
     * from the run itself. `job.queued` is the only event carrying the id the
     * server knows it by.
     */
    const pipelineRuns: string[] = [];

    const exec = createExecutor({
      transport,
      emit: (event: ExecutorEvent) => {
        if (event.type === 'job.queued' && event.engine === 'pipeline') {
          if (!pipelineRuns.includes(event.jobId)) pipelineRuns.push(event.jobId);
        }
        setRuns((prev) => {
          const runId = event.runId;
          const idx = prev.findIndex((r) => r.runId === runId);
          const base = (idx >= 0 ? prev[idx] : initialRun(runId, event.at)) as FoldedRun;
          const updated = applyEvent(base, event);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = updated;
            return next;
          }
          return [...prev, updated];
        });
      },
      applyLocal: async (step, stepId, bound) => {
        if (step.kind === 'timeline-op') {
          if (step.op === 'blade') {
            const at = typeof bound.at === 'number' ? (bound.at as Frames) : clock.get();
            const ops: EditOp[] = [];
            for (const track of doc.tracks) {
              if (track.locked || !track.autoSelect) continue;
              const placed = itemAt(track, at);
              if (!placed || !isClip(placed.item)) continue;
              if (at <= placed.range.start || at >= rangeEnd(placed.range)) continue;
              ops.push(...bladeOps(placed, at, `clp_${Math.random().toString(36).slice(2, 10)}`));
            }
            if (ops.length > 0) {
              commit(ops, 'Blade');
              return { ops, revision: doc.revision + 1 };
            }
            return { ops: [], revision: doc.revision };
          }
          if (step.op === 'ripple' || step.op === 'ripple_delete') {
            const first = [...selection][0];
            const placed = first ? findClip(doc, first) : null;
            if (placed) {
              const ops = rippleDeleteOps(doc, placed);
              if (ops.length > 0) {
                commit(ops, 'Ripple delete');
                setSelection(new Set());
                return { ops, revision: doc.revision + 1 };
              }
            }
            return { ops: [], revision: doc.revision };
          }
          if (step.op === 'punch') {
            note('Punch in needs a scale operation, which the editor API does not have');
            return { ops: [], revision: doc.revision };
          }
        }
        return { ops: [], revision: doc.revision };
      },
    });

    try {
      const selectedClip = selectedPlaced && isClip(selectedPlaced.item) ? selectedPlaced.item.id : null;
      const result = await exec.run(
        { cardId: plan.cardId, steps: plan.steps },
        {
          bindings: {
            selection: selectedClip,
            playhead: clock.get(),
            timeline: doc,
            ...extra,
          },
        },
      );

      setRunTitles((prev) => ({ ...prev, [result.runId]: title }));

      if (result.status === 'done') {
        const allOutputs = result.steps.flatMap((s) => s.outputs);
        if (allOutputs.length > 0) {
          const recOps = reconcileOutputs(doc, allOutputs, {
            selected: selectedPlaced,
            playhead: clock.get(),
            label: plan.cardId,
          });
          if (recOps.length > 0) {
            commit(recOps, `Apply ${plan.cardId}`);
          }
        }
        const said = await placePlanResult(pipelineRuns, extra, title);
        note(said ?? `Plan completed: ${title}`);
      } else if (result.status === 'failed') {
        /**
         * "the job failed" is not a reason.
         *
         * The executor sees a step fail; the run itself knows WHY, and the
         * code it carries is the difference between "re-import that file" and
         * "try again later". Reading it back costs one request on a path that
         * has already failed.
         */
        let why = result.error ?? 'Unknown error';
        for (const runId of pipelineRuns) {
          try {
            const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
            const body = await res.json().catch(() => null);
            const err = body?.error as { code?: string; message?: string } | string | null;
            const code = typeof err === 'object' && err ? err.code : undefined;
            const message = typeof err === 'string' ? err : err?.message;
            if (code === 'input_unreachable') {
              why = 'the file it was given is not in storage any more, import it again';
            } else if (message) {
              why = message;
            }
            if (code || message) break;
          } catch {
            // the run failed and we cannot re-read it; the executor's word stands
          }
        }
        note(`${title} failed: ${why}`);
      }
    } catch (err) {
      note(`Execution error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [busy, clock, doc, selection, selectedPlaced, commit, note, placePlanResult]);

  /** Ask whether an object is still readable. Null means we could not tell. */
  const checkMedia = useCallback(async (
    key: string,
  ): Promise<{ reachable: boolean | null; reason?: string }> => {
    try {
      const res = await fetch('/api/media/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) return { reachable: null };
      return { reachable: body.reachable ?? null, reason: body.reason };
    } catch {
      return { reachable: null };   // offline is not proof the file is gone
    }
  }, []);

  /**
   * A tool above rung 1.
   *
   * Rung 2 cards are a single operation. Rung 3 and above run a published
   * pipeline, and a pipeline reads one file, so the target the arm card
   * offered has to become an object key before anything can start. That is
   * `resolveToolSource`, and its refusals are the honest answers: a tool
   * pointed at a selection with nothing selected, or at a timeline that cuts
   * between several sources, has no single file to read.
   *
   * This used to say "needs a published pipeline, which this account does not
   * have yet" for everything above rung 2, without looking at the card's
   * pipelineId or asking the account anything.
   */
  const runTool = useCallback(async (tool: Tool, args: ToolRunArgs) => {
    const card = getCard(tool.cardId);
    const on = args?.target ? ` on ${args.target}` : '';
    if (!card || !card.steps.length) {
      note(`${tool.name}${on} has no plan to run`);
      return;
    }

    const tier = toolTier(tool);
    if (tier === 1) {
      void executePlan({
        cardId: card.id,
        intent: tool.name,
        rationale: tool.name,
        rung: 2,
        cost: card.cost,
        steps: card.steps,
        margin: 10,
        fragile: false,
      });
      return;
    }

    const pipelineStep = card.steps.find((s) => s.kind === 'pipeline');
    if (pipelineStep && !pipelineStep.pipelineId) {
      note(`${tool.name} names no pipeline to run, so its card is not finished`);
      return;
    }

    let extra: Record<string, unknown> = {};
    if (pipelineStep) {
      const source = resolveToolSource(doc, selectedPlaced, args?.target ?? '');
      if (isRefusal(source)) {
        note(`${tool.name}: ${source.error}`);
        return;
      }

      /**
       * Read the file before paying to read it properly.
       *
       * A document outlives its bytes, and a key that has been swept looks
       * exactly like one that has not until something opens it. Finding that
       * out from a pipeline costs minutes of GPU and reports "the job
       * failed"; finding it out here costs a few seconds of cpu and can name
       * the file. The proxy and the original are two keys for the same
       * footage and they expire separately, so a gone proxy is not a gone
       * clip: try the other before giving up.
       */
      note(`${tool.name}: checking "${source.name}"`);
      const candidates = [source.key, source.fallbackKey].filter((k): k is string => !!k);
      let usable: string | null = null;
      let why = 'that file is not in storage any more';
      for (const key of candidates) {
        const verdict = await checkMedia(key);
        if (verdict.reachable !== false) { usable = key; break; }  // null means unknown, so try it
        why = verdict.reason ?? why;
      }
      if (!usable) {
        note(`${tool.name}: "${source.name}" cannot be read, ${why}. Import it again to run this.`);
        return;
      }
      extra = { source: usable, sourceMediaKey: source.mediaKey };
    }

    void executePlan({
      cardId: card.id,
      intent: tool.name,
      rationale: `${tool.name}${on}`,
      rung: Math.min(4, Math.max(1, card.rung)) as Plan['rung'],
      cost: card.cost,
      steps: card.steps,
      margin: 10,
      fragile: false,
    }, extra);
  }, [executePlan, note, doc, selectedPlaced, checkMedia]);

  return (
    <>
      <MenuBar
        commands={commands}
        context={cmdContext}
        projectName={doc.name}
        dirty={dirty}
      />
      <input
        id="cr-import-input"
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';   // so choosing the same file twice still fires
          if (files.length) void importFiles(files);
        }}
      />
      <Shell
        timeline={doc}
        playhead={playhead}
        selection={selectedPlaced}
        runs={runs}
        runTitles={runTitles}
        busy={busy}
        onSeek={(at) => clock.seek(at)}
        controller={clock}
        onRunLocalTool={runLocalTool}
        onRunTool={runTool}
        onRunPlan={executePlan}
        onUndo={() => step('undo')}
        onRedo={() => step('redo')}
        undoLabel={stack.undo[0] ?? null}
        redoLabel={stack.redo[0] ?? null}
        historyDepth={{ undo: stack.undo.length, redo: stack.redo.length }}
        onNotify={note}
        onOpenWorkbench={() => setBenchOpen(true)}
        clipParams={clipParams}
        onClipParamsChange={onClipParams}
        onRemoveMedia={setRemoving}
        onRenameMedia={renameMedia}
        onReplaceMedia={replaceMedia}
        onRelinkMedia={relinkMedia}
        onReextractFrames={reextractFrames}
      >
        <Timeline
          timeline={doc}
          onEdit={commit}
          selection={selection}
          onSelectionChange={setSelection}
          onPlayheadChange={setPlayhead}
          controller={clock}
          initialPlayhead={playhead}
          onNotify={note}
          snapping={snapping}
          onSnappingChange={setSnapping}
          onControls={setTlControls}
          linked={linked}
        />
      </Shell>
      {projects ? (
        <div className="cr-open" role="dialog" aria-modal="true" aria-label="Open project">
          <div className="cr-open-box">
            <header>
              <b>Open project</b>
              <span className="sp" />
              <button type="button" onClick={() => setProjects(null)} aria-label="Close">✕</button>
            </header>
            {projects.length === 0 ? (
              <p className="none">No projects on the server yet. Save this one to make the first.</p>
            ) : (
              <ol>
                {projects.map((p) => (
                  <li key={p.id}>
                    <div className="cr-open-row">
                      <button
                        type="button"
                        className="cr-open-main"
                        onClick={() => void openById(p.id)}
                      >
                        <span className="nm">{p.name}</span>
                        <span className="meta">
                          {p.clipCount} clip{p.clipCount === 1 ? '' : 's'} · rev {p.revision}
                          {p.durationSec ? ` · ${p.durationSec.toFixed(1)}s` : ''}
                        </span>
                      </button>
                      <div className="cr-open-actions">
                        <button
                          type="button"
                          className="cr-open-act"
                          title="Rename project"
                          onClick={(e) => { e.stopPropagation(); void renameProjectById(p.id, p.name); }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="cr-open-act"
                          title="Duplicate project"
                          onClick={(e) => { e.stopPropagation(); void duplicateProjectById(p.id, p.name); }}
                        >
                          Duplicate
                        </button>
                        <button
                          type="button"
                          className="cr-open-act"
                          title="View revision history"
                          onClick={(e) => { e.stopPropagation(); void showRevisions(p.id, p.name); }}
                        >
                          Revisions
                        </button>
                        <button
                          type="button"
                          className="cr-open-act del"
                          title="Delete project"
                          onClick={(e) => { e.stopPropagation(); void deleteProjectById(p.id, p.name); }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      ) : null}
      {revisions ? (
        <div className="cr-open" role="dialog" aria-modal="true" aria-label="Revisions">
          <div className="cr-open-box">
            <header>
              <b>Revisions: {revisions.name}</b>
              <span className="sp" />
              <button type="button" onClick={() => setRevisions(null)} aria-label="Close">✕</button>
            </header>
            {revisions.list.length === 0 ? (
              <p className="none">No revision history found on the server.</p>
            ) : (
              <ol>
                {revisions.list.slice().reverse().map((r) => {
                  const isCurrent = saved?.id === revisions.id && saved?.revision === r.revision;
                  return (
                    <li key={r.revision}>
                      <div className="cr-open-row">
                        <div className="cr-open-main">
                          <span className="nm">Revision {r.revision}</span>
                          <span className="meta">
                            {r.createdAt ? new Date(r.createdAt).toLocaleString() : 'Saved revision'}
                            {r.name ? ` · ${r.name}` : ''}
                          </span>
                        </div>
                        <div className="cr-open-actions">
                          {isCurrent ? (
                            <span className="cr-rev-cur">Current</span>
                          ) : (
                            <button
                              type="button"
                              className="cr-open-act"
                              onClick={() => void restoreRevisionById(revisions.id, r.revision)}
                            >
                              Restore
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      ) : null}
      {removingUsage ? (
        <div className="cr-open" role="dialog" aria-modal="true" aria-label="Remove media">
          <div className="cr-open-box cr-confirm">
            <header>
              <b>Remove {removingUsage.media.name}?</b>
              <span className="sp" />
              <button type="button" onClick={() => setRemoving(null)} aria-label="Close">✕</button>
            </header>
            <div className="cr-cbody">
              {removingUsage.clips.length === 0 ? (
                <p>Nothing in the cut uses this file, so only the file goes.</p>
              ) : (
                <>
                  <p>
                    {removingUsage.clips.length} clip
                    {removingUsage.clips.length === 1 ? '' : 's'} cut from it
                    {removingUsage.trackIds.length > 1
                      ? `, across ${removingUsage.trackIds.length} tracks,`
                      : ''}{' '}
                    will go with it.
                  </p>
                  <ul className="cr-cwhat">
                    {removingUsage.clips.slice(0, 6).map((c) => (
                      <li key={c.item.id}>
                        <span className="nm">{isClip(c.item) ? c.item.name : c.item.id}</span>
                        <span className="meta">
                          {doc.tracks.find((t) => t.id === c.trackId)?.name ?? c.trackId}
                          {' · '}
                          {toTimecode(c.range.start, doc.rate)}
                        </span>
                      </li>
                    ))}
                    {removingUsage.clips.length > 6 ? (
                      <li className="more">and {removingUsage.clips.length - 6} more</li>
                    ) : null}
                  </ul>
                  <p className="cr-cnote">
                    The rest of the cut stays where it is: the clips leave holes rather
                    than pulling everything after them back.
                  </p>
                </>
              )}
              <p className="cr-cnote">One undo puts it all back.</p>
            </div>
            <footer className="cr-cfoot">
              <button type="button" className="cr-cbtn" onClick={() => setRemoving(null)}>Cancel</button>
              <button type="button" className="cr-cbtn cr-cgo" onClick={confirmRemove}>
                {removingUsage.clips.length === 0
                  ? 'Remove'
                  : `Remove file and ${removingUsage.clips.length} clip${removingUsage.clips.length === 1 ? '' : 's'}`}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreate={(name, rate, templateId) => {
          const newDoc = emptyTimeline(`tl_${Date.now().toString(36)}`, name, rate, templateId);
          setDoc(newDoc);
          setSaved(null);
          setDirty(false);
          setPlayhead(frames(0));
          note(`Created project with ${getTemplate(templateId).name} layout`);
        }}
      />
      <JobsPanel store={jobs} open={jobsOpen} onOpen={() => setJobsOpen(true)} onClose={() => setJobsOpen(false)} />
      <Workbench open={benchOpen} onClose={() => setBenchOpen(false)} />
      <ExportDialog
        open={exportOpen}
        projectName={doc.name}
        clipCount={doc.tracks.reduce((n, t) => n + t.items.filter((i) => i.kind === 'clip').length, 0)}
        durationLabel={`${toTimecode(timelineDuration(doc), doc.rate)} at ${rateLabel(doc.rate)}`}
        settings={exportSettings}
        onSettings={setExportSettings}
        progress={exportProgress}
        result={exportResult}
        error={exportError}
        onStart={() => void startExport()}
        onClose={() => setExportOpen(false)}
      />
      {toast ? <div className="cutroom-toast" key={toast.id}>{toast.text}</div> : null}
    </>
  );
}
