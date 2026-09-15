'use client';
/**
 * Zoom, scroll and the visible time window.
 *
 * One scroller owns the whole timeline: the ruler is sticky to its top and
 * the track headers sticky to its left, so vertical and horizontal scroll are
 * synchronised by the compositor instead of by a scroll handler copying
 * `scrollTop` between two elements a frame late.
 *
 * The only thing this hook puts into React state is what changes the SHAPE of
 * the tree, the zoom and which frames are on screen. Scroll events are
 * coalesced to one per animation frame, because a trackpad fires them faster
 * than React can render and the answer would be stale either way.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Frames, TimeRange } from '../../lib/time/frames.ts';
import { timelineDuration } from '../../lib/timeline/document.ts';
import type { Timeline } from '../../lib/timeline/types.ts';
import {
  PPF_MAX, PPF_MIN, clampPpf, contentWidth, fitPpf, framesToPx, ppfFromZoom, visibleRange,
  zoomFromPpf,
} from './interactions.ts';

/** Keep the playhead this far inside the edge before the view chases it. */
const CHASE_MARGIN = 48;

export interface TimelineView {
  /** Pixels per frame. The single number that turns the model into geometry. */
  ppf: number;
  /** The same thing as a 0…1 slider position. */
  zoom: number;
  /** Width of the lane area, excluding the sticky header column. */
  laneWidth: number;
  /** Width of the scrollable lane content. */
  contentPx: number;
  /** The frames on screen, plus overscan. Only these get DOM nodes. */
  visible: TimeRange;
  /** The whole edit, for fit-to-window and for the end-of-timeline stop. */
  duration: Frames;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  setZoom: (z: number) => void;
  /** Zoom about a point, keeping the frame under it still. */
  zoomAt: (factor: number, clientX: number) => void;
  fit: () => void;
  /** Scroll the frame into view if it has left it. Used by playback and by nudges. */
  reveal: (f: Frames) => void;
}

export function useTimelineView(timeline: Timeline, headerWidth: number): TimelineView {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [ppf, setPpf] = useState(0.6);
  const [laneWidth, setLaneWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const rafRef = useRef(0);
  const fitted = useRef(false);

  const duration = useMemo(() => timelineDuration(timeline), [timeline]);
  const contentPx = useMemo(
    () => contentWidth(timeline, ppf, laneWidth),
    [timeline, ppf, laneWidth],
  );
  const visible = useMemo(
    () => visibleRange(scrollLeft, laneWidth, ppf),
    [scrollLeft, laneWidth, ppf],
  );

  // the lane area is the scroller minus the column the headers stick to
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setLaneWidth(Math.max(0, el.clientWidth - headerWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [headerWidth]);

  // one state update per animation frame, however fast the wheel spins
  const onScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setScrollLeft(scrollRef.current?.scrollLeft ?? 0);
    });
  }, []);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  const setZoom = useCallback((z: number) => {
    const el = scrollRef.current;
    // hold the centre of the view still, or zooming walks the edit off screen
    const centre = el ? (el.scrollLeft + (el.clientWidth - headerWidth) / 2) : 0;
    setPpf((prev) => {
      const next = ppfFromZoom(z);
      if (el) {
        const at = centre / prev;
        requestAnimationFrame(() => {
          el.scrollLeft = at * next - (el.clientWidth - headerWidth) / 2;
        });
      }
      return next;
    });
  }, [headerWidth]);

  const zoomAt = useCallback((factor: number, clientX: number) => {
    const el = scrollRef.current;
    if (!el) return;
    // the pointer is over a frame; that frame must not move while zooming
    const offset = clientX - el.getBoundingClientRect().left - headerWidth;
    const anchorPx = el.scrollLeft + offset;
    setPpf((prev) => {
      const next = clampPpf(prev * factor);
      const at = anchorPx / prev;
      requestAnimationFrame(() => { el.scrollLeft = at * next - offset; });
      return next;
    });
  }, [headerWidth]);

  const fit = useCallback(() => {
    const el = scrollRef.current;
    const width = el ? el.clientWidth - headerWidth : laneWidth;
    setPpf(fitPpf(duration, width));
    if (el) requestAnimationFrame(() => { el.scrollLeft = 0; });
  }, [duration, headerWidth, laneWidth]);

  /**
   * Fit once, the first time the lane width is known.
   *
   * A fixed starting zoom means the editor opens with the cut occupying
   * whatever fraction of the window it happens to. Opening on the whole edit
   * is what an editor expects, and the guard means one manual zoom is never
   * undone by a later resize.
   */
  useEffect(() => {
    if (fitted.current || laneWidth <= 0 || duration <= 0) return;
    fitted.current = true;
    setPpf(fitPpf(duration, laneWidth));
  }, [laneWidth, duration]);

  const reveal = useCallback((f: Frames) => {
    const el = scrollRef.current;
    if (!el) return;
    const x = framesToPx(f, ppf);
    const width = el.clientWidth - headerWidth;
    if (x < el.scrollLeft + CHASE_MARGIN || x > el.scrollLeft + width - CHASE_MARGIN) {
      el.scrollLeft = Math.max(0, x - width * 0.4);
    }
  }, [headerWidth, ppf]);

  return {
    ppf,
    zoom: zoomFromPpf(ppf),
    laneWidth,
    contentPx,
    visible,
    duration,
    scrollRef,
    onScroll,
    setZoom,
    zoomAt,
    fit,
    reveal,
  };
}

export { PPF_MAX, PPF_MIN };
