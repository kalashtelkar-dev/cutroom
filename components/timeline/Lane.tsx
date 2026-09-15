'use client';
/**
 * One track's lane.
 *
 * The lane owns exactly one canvas. Every visible clip's filmstrip or
 * waveform is painted onto it in a single pass, so a sequence with four
 * hundred clips still has four canvases rather than four hundred.
 *
 * The canvas is the width of the viewport and translated to sit under the
 * visible window, for the same reason as the ruler: at full zoom a canvas the
 * width of the edit would be millions of pixels wide.
 *
 * Only clips intersecting the window get DOM nodes at all. Everything
 * off-screen costs nothing but the placed range already computed for it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rangeEnd, type Rate, type TimeRange } from '../../lib/time/frames.ts';
import type { Caption, MediaRef, PlacedItem, Track, Transition } from '../../lib/timeline/types.ts';
import { tokenReader } from '../ui/tokens.ts';
import { CLIP_INSET, ClipView, clipPaint, paintClipBody, type ClipVariant } from './Clip.tsx';
import {
  MIN_CLIP_PX, framesToPx as toPx, inWindow, transitionBox, type TrimEdge,
} from './interactions.ts';

const MAX_CANVAS_PX = 8192;

export interface LaneProps {
  track: Track;
  /** Everything on this track, already placed. Never recomputed here. */
  placed: readonly PlacedItem[];
  media: Record<string, MediaRef>;
  rate: Rate;
  ppf: number;
  /** Full scrollable width of the lane content. */
  width: number;
  height: number;
  visible: TimeRange;
  variant: ClipVariant;
  selectedIds: ReadonlySet<string>;
  /** True when some other track is soloed, so this one is silenced. */
  silenced: boolean;
  onGrab: (e: React.PointerEvent<HTMLElement>, placed: PlacedItem, edge: TrimEdge | null) => void;
  onSelect: (placed: PlacedItem, additive: boolean) => void;
  onRemoveTransition?: (trackId: string, transitionId: string) => void;
}

export function Lane({
  track, placed, media, rate, ppf, width, height, visible, variant,
  selectedIds, silenced, onGrab, onSelect, onRemoveTransition,
}: LaneProps) {
  const canvas = useRef<HTMLCanvasElement | null>(null);

  const originPx = toPx(visible.start, ppf);
  const windowPx = Math.min(MAX_CANVAS_PX, Math.max(1, toPx(visible.duration, ppf)));
  const clipHeight = Math.max(6, height - CLIP_INSET * 2);

  /**
   * Frames load after the lane has already painted, so the lane needs a way
   * to be told. A counter rather than storing the image: the cache in
   * Clip.tsx owns the images, this only says "something arrived".
   */
  const [paintTick, setPaintTick] = useState(0);
  const repaint = useCallback(() => setPaintTick((n) => n + 1), []);

  const dimmed = silenced || !track.enabled || (track.kind === 'audio' && track.muted);

  // only what is on screen, computed once and shared by the canvas and the DOM
  const visibleClips = useMemo(
    () => placed.filter((p) => p.item.kind === 'clip' && inWindow(p.range, visible)),
    [placed, visible],
  );

  /**
   * Captions draw as their own blocks: they carry words rather than media, so
   * there is no filmstrip, no waveform and nothing for ClipView to show. The
   * text itself is the thumbnail.
   */
  const visibleCaptions = useMemo(
    () => placed.filter((p) => p.item.kind === 'caption' && inWindow(p.range, visible)),
    [placed, visible],
  );

  const visibleTransitions = useMemo(() => {
    const out: { transition: Transition; box: TimeRange }[] = [];
    placed.forEach((p, i) => {
      if (p.item.kind !== 'transition') return;
      // a transition owns no time; it straddles the cut it was dropped on,
      // which is the end of whatever sits before it on the track
      const cut = i > 0 ? rangeEnd(placed[i - 1].range) : p.range.start;
      const box = transitionBox(cut, p.item.inOffset, p.item.outOffset);
      if (inWindow(box, visible)) out.push({ transition: p.item, box });
    });
    return out;
  }, [placed, visible]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(windowPx * dpr);
    cv.height = Math.round(clipHeight * dpr);
    const c = cv.getContext('2d');
    if (!c) return;

    // one computed-style read for the whole lane, not one per clip
    const token = tokenReader();

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, windowPx, clipHeight);

    for (const p of visibleClips) {
      const spec = clipPaint(
        p,
        variant,
        {
          // canvas-local: the canvas is already translated to the window origin
          x: Math.round(toPx(p.range.start, ppf) - originPx),
          width: Math.max(MIN_CLIP_PX, toPx(p.range.duration, ppf)),
          height: clipHeight,
        },
        rate,
        { dimmed, selected: selectedIds.has(p.item.id) },
        media,
        repaint,
      );
      if (spec) paintClipBody(c, spec, token);
    }
  }, [visibleClips, variant, ppf, originPx, windowPx, clipHeight, rate, dimmed, selectedIds, media, repaint, paintTick]);

  return (
    <div
      data-track-id={track.id}
      style={{
        position: 'relative',
        width,
        height,
        borderBottom: '1px solid var(--edge)',
        background: track.kind === 'audio' ? 'var(--lane-a)' : 'var(--lane-v)',
        // a locked track is hatched, so it reads as locked before you try to drag it
        backgroundImage: track.locked
          ? 'repeating-linear-gradient(45deg,rgba(0,0,0,.16) 0 5px,transparent 5px 10px)'
          : undefined,
      }}
    >
      <canvas
        ref={canvas}
        aria-hidden
        style={{
          position: 'absolute',
          top: CLIP_INSET,
          left: 0,
          display: 'block',
          width: windowPx,
          height: clipHeight,
          transform: `translate3d(${originPx}px,0,0)`,
          pointerEvents: 'none',
        }}
      />

      {visibleClips.map((p) => (
        <ClipView
          key={p.item.id}
          placed={p}
          media={p.item.kind === 'clip' ? media[p.item.mediaKey] : undefined}
          rate={rate}
          x={Math.round(toPx(p.range.start, ppf))}
          width={toPx(p.range.duration, ppf)}
          height={clipHeight}
          selected={selectedIds.has(p.item.id)}
          dimmed={dimmed}
          locked={track.locked}
          onGrab={onGrab}
          onSelect={onSelect}
        />
      ))}

      {visibleCaptions.map((p) => {
        const caption = p.item as Caption;
        const width = toPx(p.range.duration, ppf);
        return (
          <button
            type="button"
            key={caption.id}
            className="cr-cap"
            data-caption-id={caption.id}
            data-selected={selectedIds.has(caption.id) ? 'true' : undefined}
            data-off={caption.enabled ? undefined : 'true'}
            title={`${caption.text}\n${p.range.duration} frames`}
            onPointerDown={(e) => {
              if (track.locked) return;
              onSelect(p, e.shiftKey || e.metaKey || e.ctrlKey);
              // null: a caption has no media to trim into, so its edges move
              // its duration rather than its in-point
              onGrab(e, p, null);
            }}
            style={{
              position: 'absolute',
              top: CLIP_INSET,
              height: clipHeight,
              left: Math.round(toPx(p.range.start, ppf)),
              // a cue can be a few frames long; below this it is a sliver
              // nobody can hit, and a sliver you cannot click is not an item
              width: Math.max(3, width),
              opacity: dimmed ? 0.5 : 1,
            }}
          >
            <span>{caption.text}</span>
          </button>
        );
      })}

      {visibleTransitions.map(({ transition, box }) => (
        <div
          key={transition.id}
          aria-label={`${transition.transitionType} transition`}
          title={`${transition.transitionType} (${box.duration} frames) · Right-click to remove`}
          style={{
            position: 'absolute',
            top: CLIP_INSET,
            height: clipHeight,
            left: Math.round(toPx(box.start, ppf)),
            width: Math.max(6, toPx(box.duration, ppf)),
            background: 'rgba(245, 158, 11, 0.28)',
            border: '1px solid var(--orange)',
            borderRadius: 4,
            zIndex: 4,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemoveTransition?.(track.id, transition.id);
          }}
        >
          <span style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--orange)', pointerEvents: 'none' }}>
            ⧓
          </span>
        </div>
      ))}
    </div>
  );
}
