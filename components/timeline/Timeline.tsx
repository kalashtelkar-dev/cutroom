'use client';
/**
 * The timeline region.
 *
 * Presentational plus interaction maths, and nothing else: it takes a
 * `Timeline` and emits `EditOp[]`. It does not fetch, it does not mutate, it
 * does not know what a revision is. Whoever owns the document applies the ops
 * and hands back a new one, which is also what makes an assistant's edit and
 * a human's drag indistinguishable by the time they reach this component.
 *
 * Two rules hold the performance together and both are easy to break:
 *
 *  - The playhead never enters React state (Playhead.tsx).
 *  - A drag never enters React state either. While the pointer is down the
 *    dragged element's own style is written directly and the model is left
 *    alone; one `onEdit` goes out on pointer-up. Re-rendering the tree per
 *    pointermove is the other half of why web NLEs feel bad.
 */
import { readToken } from '../ui/tokens.ts';
import { DRAG_TYPE, planDrop, trackAtY } from '../../lib/media/drop.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ZERO, rateFps, toTimecode, rangesOverlap, rangeEnd, type Frames, type TimeRange } from '../../lib/time/frames.ts';
import {
  isClip, itemAt, placeTrack, snapTargets, timelineDuration,
} from '../../lib/timeline/document.ts';
import { addTrackOp } from '../../lib/timeline/addTrack.ts';
import type {
  Clip, ClipId, EditOp, Marker, MediaRef, PlacedItem, Timeline as TimelineDoc, Track, TrackId, TrackKind,
} from '../../lib/timeline/types.ts';
import type { ClipVariant } from './Clip.tsx';
import { Lane } from './Lane.tsx';
import { Playhead, PlayheadTimecode, usePlayheadController, usePlaying } from './Playhead.tsx';
import type { PlayheadController } from './Playhead.tsx';
import { Ruler } from './Ruler.tsx';
import { TrackHeaders } from './TrackHeaders.tsx';
import { ClipContextMenu, type ContextAction } from './ClipContextMenu.tsx';
import { addTransitionOps, removeTransitionOps } from '../../lib/timeline/transitions.ts';
import { useTimelineView } from './useTimelineView.ts';
import {
  bladeOps, dragMove, framesToPx, laneAtY, laneBoxes, lanesHeight, marqueeBox, marqueeHits,
  moveOps, nearestEdge, nextEdge, playheadLimit, pxToFrameAt, rippleDeleteOps, snapTolerance,
  trimClip, trimOps, type TrimEdge,
} from './interactions.ts';

const HEADER_WIDTH = 172;

/** Selection, blade, trim, dynamic trim. The toolbar's four modes. */
export type TimelineMode = 'select' | 'trim' | 'dynamic' | 'blade';

export interface TimelineProps {
  timeline: TimelineDoc;
  /**
   * Every edit leaves through here as a batch. The batch is one revision and
   * therefore one undo, a whole assistant run reverses in a single step.
   */
  onEdit: (ops: EditOp[], label: string) => void;
  selection?: ReadonlySet<ClipId>;
  onSelectionChange?: (ids: ReadonlySet<ClipId>) => void;
  onPlayheadChange?: (at: Frames) => void;
  /** Ids for clips and markers this component creates. Injected so tests are stable. */
  newId?: (prefix: string) => string;
  initialPlayhead?: Frames;
  /** For the things the timeline needs to say out loud, like a refused drop. */
  onNotify?: (message: string) => void;
  /**
   * Snapping, held by whoever owns the menu that claims to toggle it.
   *
   * Controlled when both are given, local otherwise. Two copies of this flag
   * is the bug it replaces: the View menu toggled one and the timeline read
   * the other, so the menu item did nothing at all.
   */
  snapping?: boolean;
  onSnappingChange?: (next: boolean) => void;
  /**
   * Handed the things only the timeline can do, once it can do them.
   *
   * Zoom lives in the view hook and select-all needs the placed items, so a
   * command in the menu bar cannot reach either without this. Called again
   * with null on unmount so nothing holds a stale closure.
   */
  onControls?: (controls: TimelineControls | null) => void;
  /**
   * The one playhead clock, when someone above owns it.
   *
   * Given, the viewer and the timeline move together and play means the same
   * thing in both. Not given, the timeline builds a private one and the
   * viewer's transport buttons move a playhead nothing else can see.
   */
  controller?: PlayheadController;
  /**
   * Linked selection. When true, selecting a video clip also selects the
   * audio clip that sits at the same position on a paired track, and vice
   * versa. When false, each clip is independent.
   */
  linked?: boolean;
}

export interface TimelineControls {
  zoomIn(): void;
  zoomOut(): void;
  zoomFit(): void;
  selectAll(): void;
}

interface DragState {
  placed: PlacedItem;
  edge: TrimEdge | null;
  el: HTMLElement;
  startX: number;
  startY: number;
  originalStyle: { left: string; width: string; transform: string; zIndex: string };
  targets: Frames[];
  tolerance: Frames;
  media: MediaRef | undefined;
  laneTop: number;
  toTrack: TrackId;
  moved: boolean;
  result: { start: Frames; sourceRange: TimeRange } | null;
}

/**
 * A band drag over empty lane space.
 *
 * `base` is the selection the drag started from, kept so that a shift-drag
 * adds to it rather than replacing it, and so that the set can be recomputed
 * from scratch on every move: a band that shrinks back over a clip has to
 * un-select it again.
 */
interface MarqueeState {
  pointerId: number;
  x0: number;
  y0: number;
  additive: boolean;
  base: ReadonlySet<ClipId>;
  applied: ReadonlySet<ClipId>;
  moved: boolean;
}

/** How far the pointer travels before a click becomes a band. */
const MARQUEE_SLOP_PX = 3;

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const defaultNewId = (prefix: string): string =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

export function Timeline({
  timeline, onEdit, selection, onSelectionChange, onPlayheadChange,
  newId = defaultNewId, initialPlayhead = ZERO,
  onNotify, snapping: snappingProp, onSnappingChange, onControls,
  controller, linked = true,
}: TimelineProps) {
  const view = useTimelineView(timeline, HEADER_WIDTH);
  const { reveal, scrollRef, zoomAt } = view;
  // Hooks cannot be conditional, so the private clock is always built and
  // simply unused when one is handed down.
  const ownPlayhead = usePlayheadController(timeline.rate, initialPlayhead);
  const playhead = controller ?? ownPlayhead;
  const playing = usePlaying(playhead);

  const [mode, setMode] = useState<TimelineMode>('select');
  const [localSnapping, setLocalSnapping] = useState(true);
  const snapping = snappingProp ?? localSnapping;
  const setSnapping = useCallback((next: boolean | ((s: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(snapping) : next;
    if (onSnappingChange) onSnappingChange(value);
    else setLocalSnapping(value);
  }, [onSnappingChange, snapping]);
  const [positionLock, setPositionLock] = useState(false);
  const [destination, setDestination] = useState<TrackId | null>(
    timeline.tracks.find((t) => t.kind === 'video')?.id ?? null,
  );
  const [internalSelection, setInternalSelection] = useState<ReadonlySet<ClipId>>(new Set());
  const selected = selection ?? internalSelection;
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; placed: PlacedItem } | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const laneStackRef = useRef<HTMLDivElement | null>(null);
  const snapLineRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const bandRef = useRef<HTMLDivElement | null>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);

  // ── derived, once per document change ─────────────────────────────────

  const perTrack = useMemo(
    () => timeline.tracks.map((track) => ({ track, placed: placeTrack(track) })),
    [timeline],
  );
  const boxes = useMemo(() => laneBoxes(timeline.tracks), [timeline]);
  const stackHeight = lanesHeight(boxes);
  const counts = useMemo(() => {
    const out: Record<TrackId, number> = {};
    for (const { track, placed } of perTrack) out[track.id] = placed.filter((p) => isClip(p.item)).length;
    return out;
  }, [perTrack]);
  const duration = timelineDuration(timeline);
  const soloed = timeline.tracks.some((t) => t.kind === 'audio' && t.solo);

  /** The lowest video track is the base layer; everything above it is b-roll. */
  const baseVideoTrack = useMemo(() => {
    const video = timeline.tracks.filter((t) => t.kind === 'video');
    return video.length ? video[video.length - 1].id : null;
  }, [timeline]);

  const setSelection = useCallback((ids: ReadonlySet<ClipId>) => {
    if (onSelectionChange) onSelectionChange(ids);
    else setInternalSelection(ids);
  }, [onSelectionChange]);

  // ── playhead wiring ───────────────────────────────────────────────────

  useEffect(() => { playhead.setScale(view.ppf); }, [playhead, view.ppf]);
  // the limit is the last frame that is IN the edit, not its length: ranges
  // are half-open, so parking on `duration` parks past every clip and blacks
  // the program viewer
  useEffect(() => { playhead.setLimit(playheadLimit(duration)); }, [playhead, duration]);
  useEffect(() => {
    playhead.setChase(reveal);
    return () => playhead.setChase(null);
  }, [playhead, reveal]);
  useEffect(
    () => (onPlayheadChange ? playhead.subscribe(onPlayheadChange) : undefined),
    [playhead, onPlayheadChange],
  );

  // ── geometry helpers that need the DOM ────────────────────────────────

  const frameAtClientX = useCallback((clientX: number): Frames => {
    const rect = laneStackRef.current?.getBoundingClientRect();
    if (!rect) return ZERO;
    return pxToFrameAt(Math.max(0, clientX - rect.left), view.ppf);
  }, [view.ppf]);

  const showSnapLine = useCallback((hit: Frames | null) => {
    const el = snapLineRef.current;
    if (!el) return;
    if (hit === null) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.transform = `translate3d(${framesToPx(hit, view.ppf)}px,0,0)`;
  }, [view.ppf]);

  // ── blade ─────────────────────────────────────────────────────────────

  const bladeOne = useCallback((placed: PlacedItem, at: Frames) => {
    const ops = bladeOps(placed, at, newId('clp'));
    if (ops.length) onEdit(ops, 'Blade');
  }, [newId, onEdit]);

  /**
   * Blade at the playhead cuts every auto-select, unlocked track at once,
   * which is what makes the A toggle in the header worth having: it is how
   * you keep the music bed whole while cutting the picture.
   */
  const bladeAtPlayhead = useCallback(() => {
    const at = playhead.get();
    const ops: EditOp[] = [];
    for (const { track } of perTrack) {
      if (track.locked || !track.autoSelect) continue;
      const hit = itemAt(track, at);
      if (hit && isClip(hit.item)) ops.push(...bladeOps(hit, at, newId('clp')));
    }
    if (ops.length) onEdit(ops, 'Blade at playhead');
  }, [perTrack, playhead, newId, onEdit]);

  const rippleDeleteSelection = useCallback(() => {
    const ops: EditOp[] = [];
    for (const { placed } of perTrack) {
      for (const p of placed) {
        if (isClip(p.item) && selected.has(p.item.id)) ops.push(...rippleDeleteOps(timeline, p));
      }
    }
    if (ops.length) {
      onEdit(ops, 'Ripple delete');
      setSelection(new Set());
    }
  }, [perTrack, selected, timeline, onEdit, setSelection]);

  // ── dragging: no React state until the pointer comes up ───────────────

  const onGrab = useCallback((
    e: React.PointerEvent<HTMLElement>,
    placed: PlacedItem,
    edge: TrimEdge | null,
  ) => {
    const track = timeline.tracks.find((t) => t.id === placed.trackId);
    if (!track || track.locked || !isClip(placed.item)) return;

    if (mode === 'blade' && !edge) {
      bladeOne(placed, frameAtClientX(e.clientX));
      return;
    }
    // trim mode makes the whole clip a way of saying "the near edge of this
    // clip", which is the point of a mode that is not selection: at a zoom
    // where a shot is 20px wide the two handles are not separately hittable
    const grabbed = edge ?? (mode === 'trim' ? nearestEdge(placed.range, frameAtClientX(e.clientX)) : null);
    if (positionLock && !grabbed) return;

    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-clip-id]');
    if (!el) return;

    const box = boxes.find((b) => b.trackId === placed.trackId);
    const targets = snapTargets(timeline, placed.item.id);
    // the playhead is a snap target too: parking a cut on it is the single
    // most common thing an editor does with snapping on
    targets.push(playhead.get());

    dragRef.current = {
      placed,
      edge: grabbed,
      el,
      startX: e.clientX,
      startY: e.clientY,
      originalStyle: {
        left: el.style.left,
        width: el.style.width,
        transform: el.style.transform,
        zIndex: el.style.zIndex,
      },
      targets: targets.sort((a, b) => a - b),
      tolerance: snapTolerance(view.ppf),
      media: timeline.media[placed.item.mediaKey],
      laneTop: box?.top ?? 0,
      toTrack: placed.trackId,
      moved: false,
      result: null,
    };
    el.style.zIndex = '9';
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, [boxes, bladeOne, frameAtClientX, mode, playhead, positionLock, timeline, view.ppf]);

  /**
   * Dropping a pool item onto a lane.
   *
   * The whole of "where does this land" is in lib/media/drop.ts, away from
   * React, because it is the part that can be wrong in a way you notice three
   * edits later. Here we only turn a pointer into a track and a frame.
   */
  const [dropTrack, setDropTrack] = useState<string | null>(null);

  const dropTargetAt = useCallback((clientX: number, clientY: number) => {
    const rect = laneStackRef.current?.getBoundingClientRect();
    if (!rect) return null;
    let top = 0;
    const withTops = boxes.map((b) => { const box = { ...b, top }; top += b.height; return box; });
    const trackId = trackAtY(withTops, clientY - rect.top);
    return trackId ? { trackId, at: frameAtClientX(clientX) } : null;
  }, [boxes, frameAtClientX]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();            // without this the browser refuses the drop
    e.dataTransfer.dropEffect = 'copy';
    setDropTrack(dropTargetAt(e.clientX, e.clientY)?.trackId ?? null);
  }, [dropTargetAt]);

  const onDrop = useCallback((e: React.DragEvent) => {
    const mediaKey = e.dataTransfer.getData(DRAG_TYPE);
    setDropTrack(null);
    if (!mediaKey) return;
    e.preventDefault();

    const target = dropTargetAt(e.clientX, e.clientY);
    if (!target) return;

    const plan = planDrop(timeline, target.trackId, target.at, mediaKey, newId);
    if ('error' in plan) { onNotify?.(plan.error); return; }

    const ops = plan.ops ?? [plan.op];
    onEdit(ops, `Add ${timeline.media[mediaKey]?.name ?? 'clip'}`);
    if (plan.nudged) {
      // say it rather than leave someone wondering why it is not where they let go
      onNotify?.('Dropped after the clip that was already there');
    }
  }, [dropTargetAt, timeline, newId, onEdit, onNotify]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      if (!d.moved && Math.abs(dx) < 1 && Math.abs(e.clientY - d.startY) < 1) return;
      d.moved = true;

      const shared = {
        ppf: view.ppf,
        targets: d.targets,
        tolerance: d.tolerance,
        snapping,
      };

      if (d.edge) {
        const r = trimClip({ ...shared, placed: d.placed, media: d.media, edge: d.edge, deltaPx: dx });
        d.result = { start: r.start, sourceRange: r.sourceRange };
        d.el.style.left = `${Math.round(framesToPx(r.start, view.ppf))}px`;
        d.el.style.width = `${Math.max(3, framesToPx(r.sourceRange.duration, view.ppf))}px`;
        // green is the active trim point, red means the handle is against a wall
        showSnapLine(r.hit);
        d.el.style.outline = r.clamped ? '1px solid var(--red)' : '1px solid var(--green)';
        return;
      }

      const r = dragMove({
        ...shared,
        origin: d.placed.range.start,
        duration: d.placed.range.duration,
        deltaPx: dx,
      });
      d.result = { start: r.start, sourceRange: (d.placed.item as Clip).sourceRange };
      d.el.style.left = `${Math.round(framesToPx(r.start, view.ppf))}px`;
      showSnapLine(r.hit);

      // vertical: which lane is the pointer over now?
      const rect = laneStackRef.current?.getBoundingClientRect();
      if (rect) {
        const lane = laneAtY(boxes, e.clientY - rect.top);
        const track = lane && timeline.tracks.find((t) => t.id === lane.trackId);
        // a clip can only cross to a compatible, unlocked track
        const ok = lane && track && !track.locked && track.kind === trackKindOf(d.placed, timeline);
        d.toTrack = ok ? lane.trackId : d.placed.trackId;
        const top = ok ? lane.top : d.laneTop;
        d.el.style.transform = `translate3d(0,${top - d.laneTop}px,0)`;
      }
    };

    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      showSnapLine(null);
      d.el.style.outline = '';
      // hand the element back to React exactly as React last left it, or the
      // next render diffs against a style it never wrote and skips the update
      d.el.style.left = d.originalStyle.left;
      d.el.style.width = d.originalStyle.width;
      d.el.style.transform = d.originalStyle.transform;
      d.el.style.zIndex = d.originalStyle.zIndex;
      if (d.el.hasPointerCapture?.(e.pointerId)) d.el.releasePointerCapture(e.pointerId);

      if (!d.moved || !d.result) return; // a click that never moved is not an edit
      if (d.edge) {
        const on = timeline.tracks.find((t) => t.id === d.placed.trackId);
        const ops = trimOps(d.placed, { ...d.result, hit: null, clamped: false }, on);
        if (ops.length) onEdit(ops, d.edge === 'in' ? 'Trim in' : 'Trim out');
      } else {
        const ops = moveOps(d.placed, d.result.start, d.toTrack);
        if (ops.length) onEdit(ops, 'Move clip');
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [boxes, onEdit, showSnapLine, snapping, timeline, view.ppf]);

  // ── marquee: a drag over empty lane space ─────────────────────────────

  /**
   * Pointer down on the lane stack that is not on a clip.
   *
   * Every clip stops here by owning its own `pointerdown`, so anything that
   * reaches this is empty lane, a gap, or the space past the last shot. It
   * arms a band; whether it becomes a band or a deselecting click is decided
   * on pointer-up by how far the pointer travelled.
   */
  const onBandStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-clip-id]')) return;
    const stack = laneStackRef.current;
    if (!stack) return;
    const rect = stack.getBoundingClientRect();
    const additive = e.shiftKey || e.metaKey;
    marqueeRef.current = {
      pointerId: e.pointerId,
      x0: e.clientX - rect.left,
      y0: e.clientY - rect.top,
      additive,
      base: additive ? new Set(selected) : new Set<ClipId>(),
      applied: selected,
      moved: false,
    };
    stack.setPointerCapture(e.pointerId);
    e.preventDefault();          // or the drag paints a text selection instead
  }, [selected]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const m = marqueeRef.current;
      const stack = laneStackRef.current;
      const band = bandRef.current;
      if (!m || !stack || !band) return;
      const rect = stack.getBoundingClientRect();
      const x1 = clamp(e.clientX - rect.left, 0, view.contentPx);
      const y1 = clamp(e.clientY - rect.top, 0, stackHeight);
      if (!m.moved
        && Math.abs(x1 - m.x0) < MARQUEE_SLOP_PX
        && Math.abs(y1 - m.y0) < MARQUEE_SLOP_PX) return;
      m.moved = true;

      const box = marqueeBox(m.x0, m.y0, x1, y1);
      band.style.display = 'block';
      band.style.transform = `translate3d(${box.left}px,${box.top}px,0)`;
      band.style.width = `${box.width}px`;
      band.style.height = `${box.height}px`;

      const next = new Set<ClipId>(m.base);
      for (const id of marqueeHits(perTrack, boxes, box, view.ppf)) next.add(id as ClipId);
      // the lanes repaint their canvases on a selection change, so only
      // publish one when the set actually moved
      if (!sameIds(next, m.applied)) {
        m.applied = next;
        setSelection(next);
      }
    };

    const onUp = (e: PointerEvent) => {
      const m = marqueeRef.current;
      if (!m) return;
      marqueeRef.current = null;
      const band = bandRef.current;
      if (band) band.style.display = 'none';
      const stack = laneStackRef.current;
      if (stack?.hasPointerCapture?.(e.pointerId)) stack.releasePointerCapture(e.pointerId);
      // a press on empty lane that never became a band is a click, and a
      // click on nothing selects nothing
      if (!m.moved && !m.additive) setSelection(new Set());
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [boxes, perTrack, setSelection, stackHeight, view.contentPx, view.ppf]);

  /**
   * Hand the menu bar what only this component can do.
   *
   * The object handed up is built ONCE and never replaced. `view` is a fresh
   * object every render, so an effect depending on it handed the parent a new
   * object each time, the parent stored it, that re-rendered us, and the loop
   * ran until React gave up with "Maximum update depth exceeded". The methods
   * read the current values out of a ref instead, so the identity is stable
   * and the behaviour is still live.
   */
  const latest = useRef({ view, perTrack, setSelection });
  useEffect(() => { latest.current = { view, perTrack, setSelection }; });

  const [controls] = useState<TimelineControls>(() => ({
    zoomIn: () => {
      const v = latest.current.view;
      v.setZoom(Math.min(1, v.zoom + 0.08));
    },
    zoomOut: () => {
      const v = latest.current.view;
      v.setZoom(Math.max(0, v.zoom - 0.08));
    },
    zoomFit: () => latest.current.view.fit(),
    selectAll: () => {
      const all = new Set<ClipId>();
      for (const { placed } of latest.current.perTrack) {
        for (const p of placed) if (isClip(p.item)) all.add(p.item.id);
      }
      latest.current.setSelection(all);
    },
  }));

  useEffect(() => {
    if (!onControls) return;
    onControls(controls);
    return () => onControls(null);
  }, [onControls, controls]);

  /**
   * Delete a track, clips and all.
   *
   * One batch, so one undo puts the track and everything that was on it back
   * exactly where it was. The last track of a kind is refused: a timeline
   * with no picture track has nowhere to drop anything, and the recovery is
   * not obvious from the empty screen you would be left looking at.
   */
  const removeTrack = useCallback((track: Track) => {
    const sameKind = timeline.tracks.filter((t) => t.kind === track.kind);
    if (sameKind.length <= 1) {
      onNotify?.(`${track.name} is the last ${track.kind} track, so it cannot be deleted`);
      return;
    }
    if (track.locked) {
      onNotify?.(`${track.name} is locked. Unlock it first.`);
      return;
    }
    const clips = placeTrack(track).filter((p) => isClip(p.item)).length;
    onEdit([{ op: 'remove_track', trackId: track.id }], `Delete ${track.name}`);
    if (destination === track.id) {
      setDestination(timeline.tracks.find((t) => t.kind === track.kind && t.id !== track.id)?.id ?? null);
    }
    onNotify?.(
      clips
        ? `Deleted ${track.name} and ${clips} clip${clips === 1 ? '' : 's'}. Undo puts them back.`
        : `Deleted ${track.name}`,
    );
  }, [timeline.tracks, onEdit, onNotify, destination]);

  // ── wheel zoom ────────────────────────────────────────────────────────
  // Native, not onWheel: React's wheel listener is passive, so preventDefault
  // inside it does nothing and the page zooms instead of the timeline.

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(e.deltaY > 0 ? 0.9 : 1.11, e.clientX);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scrollRef, zoomAt]);

  // ── keyboard ──────────────────────────────────────────────────────────

  const addMarker = useCallback((at?: Frames) => {
    // The ruler paints markers onto a canvas, which cannot resolve a custom
    // property, so a marker stores the resolved colour rather than the token.
    const colour = readToken('--orange');
    const pos = at !== undefined ? at : playhead.get();
    onEdit(
      [{ op: 'add_marker', marker: { id: newId('mk'), at: pos, name: '', colour } }],
      'Add marker',
    );
  }, [newId, onEdit, playhead]);

  const removeMarker = useCallback((marker: Marker) => {
    onEdit([{ op: 'remove_marker', markerId: marker.id }], 'Remove marker');
  }, [onEdit]);

  // deliberately re-registered every render: the handler closes over the mode,
  // the selection and the document, and a stale closure here would blade the
  // wrong clip. Adding one listener per render is cheaper than being wrong.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      // the timeline owns these keys only while it, or nothing, has focus
      const root = rootRef.current;
      if (root && target && target !== document.body && !root.contains(target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // shift-arrow steps a second: the nominal frame count, which is 30 at
      // 29.97 and not 29.97 frames
      const step = e.shiftKey ? Math.round(rateFps(timeline.rate)) : 1;
      switch (e.code) {
        case 'Space': e.preventDefault(); playhead.toggle(); break;
        case 'ArrowLeft': e.preventDefault(); playhead.nudge(-step); reveal(playhead.get()); break;
        case 'ArrowRight': e.preventDefault(); playhead.nudge(step); reveal(playhead.get()); break;
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault();
          const next = nextEdge(snapTargets(timeline), playhead.get(), e.code === 'ArrowDown' ? 1 : -1);
          if (next !== null) { playhead.seek(next); reveal(next); }
          break;
        }
        case 'KeyA': setMode('select'); break;
        case 'KeyT': setMode('trim'); break;
        case 'KeyW': setMode('dynamic'); break;
        case 'KeyB': if (mode === 'blade') bladeAtPlayhead(); else setMode('blade'); break;
        case 'KeyN': setSnapping((s) => !s); break;
        case 'KeyM': addMarker(); break;
        case 'Delete':
        case 'Backspace': e.preventDefault(); rippleDeleteSelection(); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── render ────────────────────────────────────────────────────────────

  const laneContentWidth = view.contentPx;

  return (
    <div
      ref={rootRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--tl)',
        boxShadow: 'var(--lift)',
      }}
    >
      <Toolbar
        mode={mode}
        setMode={setMode}
        snapping={snapping}
        setSnapping={setSnapping}
        positionLock={positionLock}
        setPositionLock={setPositionLock}
        playing={playing}
        onPlay={() => playhead.toggle()}
        onBlade={bladeAtPlayhead}
        onRipple={rippleDeleteSelection}
        onMarker={addMarker}
        onFit={view.fit}
        zoom={view.zoom}
        onZoom={view.setZoom}
        timecode={<PlayheadTimecode
          controller={playhead}
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--t1)',
            fontVariantNumeric: 'tabular-nums',
            padding: '0 8px',
          }}
        />}
      />

      <div
        ref={scrollRef}
        onScroll={view.onScroll}
        // the ground below the last lane is part of the timeline as far as
        // anyone clicking on it is concerned
        onPointerDown={(e) => { if (e.target === e.currentTarget) setSelection(new Set()); }}
        role="application"
        aria-label={`Timeline ${timeline.name}, ${toTimecode(duration, timeline.rate)} long`}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', width: HEADER_WIDTH + laneContentWidth }}>
          <TrackHeaders
            tracks={timeline.tracks}
            boxes={boxes}
            counts={counts}
            width={HEADER_WIDTH}
            destination={destination}
            onDestination={setDestination}
            onEdit={onEdit}
            onRemoveTrack={removeTrack}
            onAddTrack={(kind) => {
              const op = addTrackOp(timeline, kind);
              onEdit([op], `Add ${op.op === 'add_track' ? op.track.name : kind}`);
            }}
          />

          <div style={{ position: 'relative', width: laneContentWidth, flex: 'none' }}>
            <div style={{ position: 'sticky', top: 0, zIndex: 6 }}>
              <Ruler
                rate={timeline.rate}
                ppf={view.ppf}
                width={laneContentWidth}
                visible={view.visible}
                markers={timeline.markers}
                onScrub={(at) => playhead.seek(at)}
                onMarkerPick={(m) => playhead.seek(m.at)}
                onAddMarker={(at) => addMarker(at)}
                onRemoveMarker={removeMarker}
              />
            </div>

            <div
              ref={laneStackRef}
              // the drop target, named so the harness can drive the real drag
              // and drop path rather than reaching past it into state
              data-lane-stack=""
              onPointerDown={onBandStart}
              onDragOver={onDragOver}
              onDragLeave={() => setDropTrack(null)}
              onDrop={onDrop}
              onContextMenu={(e) => {
                const clipEl = (e.target as HTMLElement).closest<HTMLElement>('[data-clip-id]');
                if (!clipEl) return;
                e.preventDefault();
                const clipId = clipEl.dataset.clipId as ClipId;
                for (const { placed: items } of perTrack) {
                  for (const p of items) {
                    if (isClip(p.item) && p.item.id === clipId) {
                      setCtxMenu({ x: e.clientX, y: e.clientY, placed: p });
                      return;
                    }
                  }
                }
              }}
              style={{ position: 'relative', height: stackHeight }}
            >
              {/* The lane under the pointer, outlined. A drag with no target
                  feedback is a drag you have to guess the outcome of. */}
              {dropTrack ? (() => {
                let top = 0;
                for (const b of boxes) {
                  if (b.trackId === dropTrack) {
                    return (
                      <div
                        aria-hidden
                        style={{
                          position: 'absolute', left: 0, right: 0, top, height: b.height,
                          boxShadow: 'inset 0 0 0 2px var(--orange)',
                          background: 'color-mix(in srgb, var(--orange) 8%, transparent)',
                          pointerEvents: 'none', zIndex: 5,
                        }}
                      />
                    );
                  }
                  top += b.height;
                }
                return null;
              })() : null}
              {perTrack.map(({ track, placed }, i) => (
                <Lane
                  key={track.id}
                  track={track}
                  placed={placed}
                  media={timeline.media}
                  rate={timeline.rate}
                  ppf={view.ppf}
                  width={laneContentWidth}
                  height={boxes[i].height}
                  visible={view.visible}
                  variant={variantFor(track.kind, track.id === baseVideoTrack)}
                  selectedIds={selected}
                  silenced={soloed && track.kind === 'audio' && !track.solo}
                  onGrab={onGrab}
                  onRemoveTransition={(trackId, transitionId) => {
                    const ops = removeTransitionOps(timeline, trackId, transitionId);
                    if (ops.length) onEdit(ops, 'Remove transition');
                  }}
                  onSelect={(p, additive) => {
                    if (!isClip(p.item)) return;
                    const next = new Set(additive ? selected : []);
                    next.add(p.item.id);
                    // linked selection: picking a video clip also picks the
                    // audio clip at the same position, and vice versa
                    if (linked) {
                      const srcTrack = timeline.tracks.find((t) => t.id === p.trackId);
                      if (srcTrack) {
                        const pairKind = srcTrack.kind === 'video' ? 'audio' : srcTrack.kind === 'audio' ? 'video' : null;
                        if (pairKind) {
                          for (const { track: other, placed: otherPlaced } of perTrack) {
                            if (other.kind !== pairKind) continue;
                            for (const op of otherPlaced) {
                              if (!isClip(op.item)) continue;
                              // overlap: same media or overlapping time range
                              if (rangesOverlap(p.range, op.range)) {
                                next.add(op.item.id);
                              }
                            }
                          }
                        }
                      }
                    }
                    setSelection(next);
                  }}
                />
              ))}

              {/* The band. Written to directly during the drag, like the
                  snap line and the dragged clip: a rectangle that follows
                  the pointer through React state re-renders every lane. */}
              <div
                ref={bandRef}
                aria-hidden
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  display: 'none',
                  border: '1px solid var(--red)',
                  background: 'color-mix(in srgb, var(--red) 14%, transparent)',
                  pointerEvents: 'none',
                  zIndex: 5,
                  willChange: 'transform',
                }}
              />
            </div>

            <div
              ref={snapLineRef}
              aria-hidden
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                width: 1,
                background: 'var(--green)',
                display: 'none',
                pointerEvents: 'none',
                zIndex: 7,
                willChange: 'transform',
              }}
            />

            <Playhead controller={playhead} ppf={view.ppf} dynamic={mode === 'dynamic'} />
          </div>
        </div>
      </div>

      {ctxMenu ? (() => {
        const clip = ctxMenu.placed.item;
        if (!isClip(clip)) return null;
        const track = timeline.tracks.find((t) => t.id === ctxMenu.placed.trackId);
        const actions: ContextAction[] = [
          {
            label: 'Ripple Delete',
            hint: 'Del',
            run: () => {
              const ops = rippleDeleteOps(timeline, ctxMenu.placed);
              if (ops.length) {
                onEdit(ops, 'Ripple delete');
                setSelection(new Set());
              }
            },
          },
          {
            label: 'Blade at Playhead',
            hint: 'B',
            disabled: (() => {
              const at = playhead.get();
              return at <= ctxMenu.placed.range.start || at >= rangeEnd(ctxMenu.placed.range);
            })(),
            run: () => {
              const at = playhead.get();
              const ops = bladeOps(ctxMenu.placed, at, newId('clp'));
              if (ops.length) onEdit(ops, 'Blade');
            },
          },
          { label: '---', run: () => {} },
          {
            label: clip.enabled ? 'Disable Clip' : 'Enable Clip',
            run: () => {
              onEdit(
                [{ op: 'patch_clip', clipId: clip.id, set: { enabled: !clip.enabled } }],
                clip.enabled ? 'Disable clip' : 'Enable clip',
              );
            },
          },
          { label: '---', run: () => {} },
          {
            label: 'Add Cross Dissolve (24f)',
            hint: 'Dissolve',
            run: () => {
              const ops = addTransitionOps(timeline, ctxMenu.placed.trackId, clip.id, 'SMPTE_Dissolve', 24);
              if (ops.length) onEdit(ops, 'Add transition');
            },
          },
          { label: '---', run: () => {} },
          {
            label: `Select All on ${track?.name ?? 'Track'}`,
            run: () => {
              if (!track) return;
              const all = new Set<ClipId>();
              const items = placeTrack(track);
              for (const p of items) if (isClip(p.item)) all.add(p.item.id);
              setSelection(all);
            },
          },
        ];
        return (
          <ClipContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            clipId={clip.id}
            actions={actions}
            onClose={() => setCtxMenu(null)}
          />
        );
      })() : null}
    </div>
  );
}

function trackKindOf(placed: PlacedItem, timeline: TimelineDoc) {
  return timeline.tracks.find((t) => t.id === placed.trackId)?.kind;
}

function variantFor(kind: TrackKind, isBase: boolean): ClipVariant {
  if (kind === 'audio') return 'audio';
  return isBase ? 'video' : 'broll';
}

// ── toolbar ─────────────────────────────────────────────────────────────

interface ToolbarProps {
  mode: TimelineMode;
  setMode: (m: TimelineMode) => void;
  snapping: boolean;
  setSnapping: (fn: (s: boolean) => boolean) => void;
  positionLock: boolean;
  setPositionLock: (fn: (s: boolean) => boolean) => void;
  playing: boolean;
  onPlay: () => void;
  onBlade: () => void;
  onRipple: () => void;
  onMarker: () => void;
  onFit: () => void;
  zoom: number;
  onZoom: (z: number) => void;
  timecode: React.ReactNode;
}

function Toolbar(p: ToolbarProps) {
  return (
    <div
      style={{
        height: 34,
        flex: 'none',
        background: 'var(--head)',
        borderBottom: '1px solid var(--edge)',
        boxShadow: 'var(--lift)',
        position: 'relative',
        zIndex: 11,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '0 8px',
        overflowX: 'auto',
      }}
    >
      <TB on={p.playing} onClick={p.onPlay} label={p.playing ? 'Pause' : 'Play'} hint="Space">
        {p.playing
          ? <><rect x="4" y="3" width="3" height="10" /><rect x="9" y="3" width="3" height="10" /></>
          : <path d="M4 3l9 5-9 5z" fill="currentColor" stroke="none" />}
      </TB>

      <Sep />
      <TB on={p.mode === 'select'} onClick={() => p.setMode('select')} label="Selection mode" hint="Drag clips, trim edges. A">
        <path d="M3.5 2l9 5.5-3.9.8 2.3 4-1.6.9-2.3-4-2.6 3z" fill="currentColor" stroke="none" />
      </TB>
      <TB on={p.mode === 'trim'} onClick={() => p.setMode('trim')} label="Trim edit mode" hint="Edge-based trimming. T">
        <path d="M4 2v12M12 2v12M6.5 8h3" />
      </TB>
      <TB on={p.mode === 'dynamic'} onClick={() => p.setMode('dynamic')} label="Dynamic trim" hint="The playhead turns yellow. W">
        <path d="M8 1.8v12.4M5.4 5.4L2.6 8l2.8 2.6M10.6 5.4L13.4 8l-2.8 2.6" />
      </TB>
      <TB on={p.mode === 'blade'} onClick={() => p.setMode('blade')} label="Blade mode" hint="Click a clip to cut it. B">
        <path d="M8 1v9" /><circle cx="5" cy="12.5" r="2" /><circle cx="11" cy="12.5" r="2" />
      </TB>

      <Sep />
      <TB on={false} onClick={p.onBlade} label="Blade at playhead" hint="Cuts every auto-select track at once">
        <path d="M2 4h5v8H2zM9 4h5v8H9zM8 1v14" strokeDasharray="2.2 1.7" />
      </TB>
      <TB on={false} onClick={p.onRipple} label="Ripple delete" hint="Removes the selection and closes the hole. Delete">
        <rect x="9.6" y="4" width="5.2" height="8" rx="1" />
        <path d="M7.6 8H1.4M3.6 5.6L1.2 8l2.4 2.4" />
      </TB>

      <Sep />
      <TB on={p.snapping} onClick={() => p.setSnapping((s) => !s)} label="Snapping" hint="Edges stick to cuts, markers and the playhead. N">
        <path d="M4.4 2.6v5.4a3.6 3.6 0 007.2 0V2.6M4.4 6h3.2M11.6 6H8.4" />
      </TB>
      <TB on={p.positionLock} onClick={() => p.setPositionLock((s) => !s)} label="Position lock" hint="Clips can still be trimmed, but not moved">
        <rect x="3.5" y="7" width="9" height="6" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
      </TB>
      <TB on={false} onClick={p.onMarker} label="Add marker" hint="Markers mark a moment, not a clip. M">
        <path d="M4 2h8v9l-4-2.6L4 11z" fill="currentColor" stroke="none" />
      </TB>

      <span style={{ flex: 1, minWidth: 8 }} />
      {p.timecode}
      <Sep />
      <TB on={false} onClick={p.onFit} label="Fit timeline" hint="Zoom out until the whole edit fits">
        <path d="M2 5V2h3M14 5V2h-3M2 11v3h3M14 11v3h-3" />
      </TB>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={p.zoom}
        onChange={(e) => p.onZoom(parseFloat(e.target.value))}
        aria-label="Timeline zoom"
        style={{ width: 78, accentColor: 'var(--ctl-on)', cursor: 'pointer' }}
      />
    </div>
  );
}

const Sep = () => (
  <span aria-hidden style={{ width: 1, height: 18, background: 'var(--edge-soft)', margin: '0 6px', flex: 'none' }} />
);

function TB({
  on, onClick, label, hint, children,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      aria-label={label}
      title={`${label}, ${hint}`}
      style={{
        width: 26,
        height: 22,
        borderRadius: 4,
        border: 0,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        background: on ? 'var(--panel-2)' : 'transparent',
        color: on ? 'var(--orange)' : 'var(--t2)',
      }}
    >
      <svg
        viewBox="0 0 16 16"
        width={14}
        height={14}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {children}
      </svg>
    </button>
  );
}

export { HEADER_WIDTH };
