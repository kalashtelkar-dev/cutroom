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

/**
 * Two presses on the same cue, inside this long and this close together,
 * open its words.
 *
 * The distance is not decoration. Without it, dragging a cue and then
 * dragging it again half a second later counts the second press as a double
 * press, and the editor opens instead of the cue moving. Measured: it ate
 * three gestures in a row in the browser proof. A double click is two
 * presses in the same PLACE, which is the rule browsers themselves use.
 */
const DOUBLE_PRESS_MS = 450;
const DOUBLE_PRESS_PX = 5;

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
  /** The words of a cue, after an in-place edit. Unchanged text is not an edit. */
  onCaptionText?: (placed: PlacedItem, text: string) => void;
}

export function Lane({
  track, placed, media, rate, ppf, width, height, visible, variant,
  selectedIds, silenced, onGrab, onSelect, onRemoveTransition, onCaptionText,
}: LaneProps) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  /** The cue whose words are being typed, if any. Local: nothing above cares. */
  const [editing, setEditing] = useState<string | null>(null);
  /**
   * The last cue pressed, for spotting a double press ourselves.
   *
   * `onDoubleClick` never fires here: the drag grabs on `pointerdown` and
   * calls `preventDefault`, which is what stops a drag from turning into a
   * text selection, and it also stops the browser ever synthesising the
   * `dblclick`. Measured in a real browser, where the handler sat there doing
   * nothing. So the double press is counted here instead, which is what the
   * pointer actually did either way.
   */
  const lastPress = useRef<{ id: string; at: number; x: number; y: number }>(
    { id: '', at: 0, x: 0, y: 0 },
  );

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
        // a cue can be a few frames long; below this it is a sliver nobody
        // can hit, and a sliver you cannot click is not an item
        const width = Math.max(3, toPx(p.range.duration, ppf));
        const left = Math.round(toPx(p.range.start, ppf));
        const box = {
          position: 'absolute' as const,
          top: CLIP_INSET,
          height: clipHeight,
          left,
          width,
          opacity: dimmed ? 0.5 : 1,
        };

        /**
         * Editing the words happens in place.
         *
         * whisperx gets a name or a number wrong and everything else right,
         * and the alternative to fixing that word here is re-running a GPU
         * job over the whole clip to change five characters.
         */
        if (editing === caption.id) {
          return (
            <input
              key={caption.id}
              className="cr-cap cr-cap-edit"
              data-caption-id={caption.id}
              defaultValue={caption.text}
              autoFocus
              aria-label={`Caption text at ${p.range.start}`}
              // the lane must not treat this as a drag or a band-select
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.currentTarget.blur(); return; }
                if (e.key === 'Escape') {
                  // put it back the way it was, then leave without an edit
                  e.currentTarget.value = caption.text;
                  e.currentTarget.blur();
                }
                e.stopPropagation();   // or Delete and the transport shortcuts fire
              }}
              onBlur={(e) => {
                setEditing(null);
                onCaptionText?.(p, e.currentTarget.value);
              }}
              style={{ ...box, zIndex: 6 }}
            />
          );
        }

        /**
         * One element per cue, with its handles inside it.
         *
         * A drag writes `left` and `width` straight onto this node and leaves
         * React out of it until the pointer comes up, exactly as a clip drag
         * does, so the handles have to be children or they would stay behind
         * while the cue they belong to moves. A div rather than the button
         * this was, for the same reason `ClipView` is one: a button may not
         * hold the two handles, and `role="option"` with a key handler is
         * what the lane is, a list you pick from.
         */
        return (
          <div
            key={caption.id}
            className="cr-cap"
            data-caption-id={caption.id}
            data-selected={selectedIds.has(caption.id) ? 'true' : undefined}
            data-off={caption.enabled ? undefined : 'true'}
            role="option"
            aria-selected={selectedIds.has(caption.id)}
            tabIndex={0}
            title={`${caption.text}\n${p.range.duration} frames. Drag to move, drag an edge to retime, double-click to edit the words`}
            onPointerDown={(e) => {
              if (track.locked || e.button !== 0) return;
              const now = e.timeStamp || Date.now();
              const last = lastPress.current;
              const again = last.id === caption.id
                && now - last.at < DOUBLE_PRESS_MS
                && Math.abs(e.clientX - last.x) <= DOUBLE_PRESS_PX
                && Math.abs(e.clientY - last.y) <= DOUBLE_PRESS_PX;
              lastPress.current = { id: caption.id, at: now, x: e.clientX, y: e.clientY };
              if (again) { setEditing(caption.id); return; }
              onSelect(p, e.shiftKey || e.metaKey || e.ctrlKey);
              onGrab(e, p, null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !track.locked) {
                e.preventDefault();
                setEditing(caption.id);
                return;
              }
              if (e.key === ' ') { e.preventDefault(); onSelect(p, false); }
            }}
            style={box}
          >
            <span>{caption.text}</span>

            {!track.locked && width > 14 && (['in', 'out'] as const).map((edge) => (
              <div
                key={edge}
                data-caption-edge={edge}
                role="separator"
                aria-label={`${edge === 'in' ? 'Start' : 'End'} of caption "${caption.text}"`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (e.button !== 0) return;
                  onSelect(p, false);
                  onGrab(e, p, edge);
                }}
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: edge === 'in' ? 0 : undefined,
                  right: edge === 'out' ? 0 : undefined,
                  width: 5,
                  cursor: 'ew-resize',
                  zIndex: 5,
                }}
              />
            ))}
          </div>
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
