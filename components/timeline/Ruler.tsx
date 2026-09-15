'use client';
/**
 * The ruler.
 *
 * Canvas, because a tick every few pixels across a two-hour timeline is tens
 * of thousands of elements and each one would be a layout box for a line.
 *
 * The canvas is the width of the VIEWPORT, not of the edit, and it is
 * translated to sit under the visible window. A canvas as wide as an hour at
 * full zoom would be 86,400,000 pixels, which no browser will allocate, and
 * at any zoom, painting only what is on screen is the difference between a
 * scroll that keeps up and one that does not.
 */
import { useEffect, useRef } from 'react';
import { frames, rangeEnd, toTimecode, type Frames, type Rate, type TimeRange } from '../../lib/time/frames.ts';
import type { Marker } from '../../lib/timeline/types.ts';
import { tokenReader } from '../ui/tokens.ts';
import { chooseTicks, framesToPx, pxToFrameAt, ticksIn, RULER_HEIGHT } from './interactions.ts';

// one home for the number: the shell sizes the timeline panel from it too
export { RULER_HEIGHT };

/** Canvases wider than this are refused by some browsers; window before then. */
const MAX_CANVAS_PX = 8192;

export interface RulerProps {
  rate: Rate;
  ppf: number;
  /** Full scrollable width of the lane content. */
  width: number;
  /** The frames on screen. Only these are painted. */
  visible: TimeRange;
  markers: readonly Marker[];
  /** Scrubbing. Fired continuously while the pointer is down. */
  onScrub: (at: Frames) => void;
  /** Fired when scrubbing ends. */
  onScrubEnd?: () => void;
  /** Clicking a marker parks the playhead on it rather than scrubbing. */
  onMarkerPick?: (marker: Marker) => void;
  /** Double clicking creates a marker at that frame. */
  onAddMarker?: (at: Frames) => void;
  /** Right clicking a marker removes it. */
  onRemoveMarker?: (marker: Marker) => void;
}

export function Ruler({
  rate, ppf, width, visible, markers, onScrub, onScrubEnd, onMarkerPick,
  onAddMarker, onRemoveMarker,
}: RulerProps) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const hoverLine = useRef<HTMLDivElement | null>(null);

  const originPx = framesToPx(visible.start, ppf);
  const windowPx = Math.min(MAX_CANVAS_PX, Math.max(1, framesToPx(visible.duration, ppf)));

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(windowPx * dpr);
    cv.height = Math.round(RULER_HEIGHT * dpr);
    const c = cv.getContext('2d');
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);

    // one computed-style read per paint: getComputedStyle forces a recalc
    const token = tokenReader();

    c.fillStyle = token('--ruler');
    c.fillRect(0, 0, windowPx, RULER_HEIGHT);

    /**
     * Measure the label before choosing the tick spacing.
     *
     * A guessed minimum leaves the labels overlapping at some zoom levels and
     * wastefully sparse at others, and it changes with the font. Asking the
     * canvas how wide "00:00:00:00" actually is gets it right at every zoom
     * and survives a font change.
     */
    c.font = `10px ${token('--mono')}`;
    const labelPx = c.measureText(toTimecode(frames(0), rate)).width;
    const { major, minor } = chooseTicks(ppf, rate, labelPx + 14);
    const win = visible;

    // minor ticks first, so a major tick always paints over its own minor
    c.strokeStyle = token('--edge-soft');
    c.beginPath();
    for (const t of ticksIn(win, minor)) {
      const x = Math.round(framesToPx(t, ppf) - originPx) + 0.5;
      if (x < -1 || x > windowPx + 1) continue;
      c.moveTo(x, RULER_HEIGHT - 5);
      c.lineTo(x, RULER_HEIGHT - 1);
    }
    c.stroke();

    // canvas cannot read a CSS custom property, so the token is resolved here
    c.font = `10px ${token('--mono')}`;
    c.textBaseline = 'middle';
    c.strokeStyle = token('--t3');
    const label = token('--t2');
    c.beginPath();
    const labels: [number, string][] = [];
    for (const t of ticksIn(win, major)) {
      const x = Math.round(framesToPx(t, ppf) - originPx) + 0.5;
      if (x < -80 || x > windowPx + 1) continue;
      c.moveTo(x, RULER_HEIGHT - 11);
      c.lineTo(x, RULER_HEIGHT - 1);
      labels.push([x + 4, toTimecode(t, rate)]);
    }
    c.stroke();
    c.fillStyle = label;
    for (const [x, text] of labels) c.fillText(text, x, 8);

    // markers sit on the ruler because they mark a moment, not a clip
    for (const m of markers) {
      if (m.at < win.start || m.at > rangeEnd(win)) continue;
      const x = Math.round(framesToPx(m.at, ppf) - originPx);
      c.fillStyle = m.colour;
      c.fillRect(x - 3, 1, 7, 7);
      c.fillStyle = 'rgba(0,0,0,.35)';
      c.fillRect(x - 3, 7, 7, 1);
    }
  }, [rate, ppf, visible, originPx, windowPx, markers]);

  const frameAt = (clientX: number): Frames => {
    const rect = host.current?.getBoundingClientRect();
    if (!rect) return frames(0);
    return pxToFrameAt(Math.max(0, clientX - rect.left), ppf);
  };

  const pickMarker = (clientX: number): Marker | null => {
    if (!onMarkerPick) return null;
    const at = frameAt(clientX);
    const slop = Math.max(1, Math.round(5 / ppf));
    return markers.find((m) => Math.abs(m.at - at) <= slop) ?? null;
  };

  return (
    <div
      ref={host}
      // named so the harness can scrub the way a pointer does
      data-ruler=""
      onPointerDown={(e) => {
        const marker = pickMarker(e.clientX);
        if (marker) { onMarkerPick?.(marker); return; }
        e.currentTarget.setPointerCapture(e.pointerId);
        if (hoverLine.current) hoverLine.current.style.display = 'none';
        onScrub(frameAt(e.clientX));
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          onScrub(frameAt(e.clientX));
        } else if (hoverLine.current) {
          const rect = host.current?.getBoundingClientRect();
          if (rect) {
            const x = Math.max(0, e.clientX - rect.left);
            hoverLine.current.style.transform = `translate3d(${x}px,0,0)`;
            hoverLine.current.style.display = 'block';
          }
        }
      }}
      onPointerLeave={() => {
        if (hoverLine.current) hoverLine.current.style.display = 'none';
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
        onScrubEnd?.();
      }}
      onPointerCancel={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
        onScrubEnd?.();
      }}
      onDoubleClick={(e) => {
        const at = frameAt(e.clientX);
        onAddMarker?.(at);
      }}
      onContextMenu={(e) => {
        const marker = pickMarker(e.clientX);
        if (marker && onRemoveMarker) {
          e.preventDefault();
          onRemoveMarker(marker);
        }
      }}
      style={{
        position: 'relative',
        width,
        height: RULER_HEIGHT,
        background: 'var(--ruler)',
        borderBottom: '1px solid var(--edge)',
        cursor: 'pointer',
        touchAction: 'none',
      }}
    >
      <canvas
        ref={canvas}
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          display: 'block',
          width: windowPx,
          height: RULER_HEIGHT,
          transform: `translate3d(${originPx}px,0,0)`,
        }}
      />
      <div
        ref={hoverLine}
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: 1,
          background: 'var(--t3)',
          opacity: 0.6,
          display: 'none',
          pointerEvents: 'none',
          zIndex: 3,
          willChange: 'transform',
        }}
      />
    </div>
  );
}
