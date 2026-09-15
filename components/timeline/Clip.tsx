'use client';
/**
 * A clip.
 *
 * Hybrid on purpose, and the split is not arbitrary:
 *
 *  - The expensive pixels, filmstrip frames and waveforms, are painted onto
 *    the ONE canvas its lane owns (see Lane.tsx). A canvas per clip means a
 *    GPU texture per clip, and a busy sequence has hundreds.
 *  - Everything a person touches is a DOM element: the box, the title bar,
 *    the two trim handles. Hit-testing, hover, focus rings, tab order and
 *    screen-reader labels are then free and correct, rather than reimplemented
 *    against canvas coordinates.
 *
 * The DOM box is therefore transparent below its title bar: the lane canvas
 * is showing through it.
 */
import {
  frames, framesToSeconds, rangeEnd, toTimecode, type Frames, type Rate,
} from '../../lib/time/frames.ts';
import type { Clip as ClipModel, MediaRef, PlacedItem } from '../../lib/timeline/types.ts';
import type { TokenReader } from '../ui/tokens.ts';
import { MIN_CLIP_PX, type TrimEdge } from './interactions.ts';

/** Height of the opaque strip carrying the clip's name. */
export const CLIP_BAR_H = 13;

/** Inset so neighbouring lanes' clips do not touch. */
export const CLIP_INSET = 2;

export type ClipVariant = 'video' | 'broll' | 'audio';

// ── seeded noise ────────────────────────────────────────────────────────
// A clip must look the same every time it is painted, at every zoom and
// after every scroll, or the timeline shimmers as you move. Everything
// procedural here is therefore driven by a hash of the media key and nothing
// else, never by Math.random, never by the clip's position.

export function hashKey(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function noise(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Stand-in frames.
 *
 * Real poster frames come from the media service as it indexes an asset.
 * Until they do, a deterministic painted frame is far more useful than a grey
 * box: you can see where a cut lands, and the filmstrip visibly advances
 * through a shot as you trim it.
 */
/**
 * Real frames, or nothing.
 *
 * This file used to invent a picture for every clip: a deterministic painted
 * landscape, on the theory that it was more useful than a grey box. It is
 * not. Someone importing their own video and seeing a generated scene in the
 * timeline reasonably concludes the application is showing them the wrong
 * file. An empty slab says "no preview yet", which is true; a painting says
 * "here is your footage", which is a lie.
 *
 * Frames arrive as object keys on the MediaRef and are fetched through
 * /api/media/frame, which re-signs them. They are cached here by key because
 * a lane repaints on every scroll and every zoom.
 */
const frameCache = new Map<string, HTMLImageElement>();
const framePending = new Set<string>();
/** Keys whose fetch answered an error. Held so the state is reportable. */
const frameFailed = new Set<string>();

export type FrameState = 'ready' | 'loading' | 'failed';

/**
 * Whether a key has a picture, is still fetching one, or never will.
 *
 * The three are different and the difference is the whole message. A failed
 * fetch used to be indistinguishable from a slow one, so the viewer sat on
 * "loading the frame" forever while the request had already 404'd. Waiting
 * for something that is not coming is the worst of the three states to show,
 * because it is the one that tells you to keep waiting.
 */
export function frameState(key: string): FrameState {
  if (frameFailed.has(key)) return 'failed';
  const have = frameCache.get(key);
  return have && have.complete && have.naturalWidth > 0 ? 'ready' : 'loading';
}

/** The decoded image for a key, or null while it loads or after it failed. */
export function frameImage(key: string, onReady: () => void): HTMLImageElement | null {
  if (frameFailed.has(key)) return null;
  const have = frameCache.get(key);
  if (have) return have.complete && have.naturalWidth > 0 ? have : null;
  if (framePending.has(key) || typeof window === 'undefined') return null;

  framePending.add(key);
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => { framePending.delete(key); onReady(); };
  img.onerror = () => {
    // a frame that cannot be fetched is not coming, and saying so is the
    // point: the caller repaints and shows "no preview" instead of "loading"
    framePending.delete(key);
    frameFailed.add(key);
    onReady();
  };
  img.src = `/api/media/frame?key=${encodeURIComponent(key)}`;
  frameCache.set(key, img);
  return null;
}

/**
 * Which tokens paint which kind of clip.
 *
 * Tokens, not literals: the body reads them through the TokenReader so a
 * palette change reaches the canvas, which cannot resolve a CSS variable
 * itself.
 */
const FILL: Record<ClipVariant, [string, string]> = {
  video: ['--clip-v', '--clip-v-bar'],
  broll: ['--clip-b', '--clip-b-bar'],
  audio: ['--clip-a', '--clip-a-bar'],
};

/**
 * Everything painting one clip needs, resolved once.
 *
 * The media lookup happens here rather than inside the paint loop, so a
 * missing media entry is a null spec (paint nothing) rather than a crash
 * halfway through a lane.
 */
export interface ClipPaint {
  id: string;
  name: string;
  variant: ClipVariant;
  x: number;
  width: number;
  height: number;
  /** Stable per media key, so a waveform does not shimmer as you scroll. */
  seed: number;
  sourceStart: Frames;
  sourceDuration: Frames;
  rate: Rate;
  effects: number;
  dimmed: boolean;
  selected: boolean;
  /** Object keys of extracted frames, in order. Empty means none yet. */
  frames: string[];
  /** Called when a frame finishes loading, so the lane can repaint. */
  onFrameReady?: () => void;
}

export function clipPaint(
  placed: PlacedItem,
  variant: ClipVariant,
  box: { x: number; width: number; height: number },
  rate: Rate,
  flags: { dimmed: boolean; selected: boolean },
  media?: Record<string, MediaRef>,
  onFrameReady?: () => void,
): ClipPaint | null {
  const item = placed.item;
  if (item.kind !== 'clip') return null;
  const ref = media?.[(item as ClipModel).mediaKey];
  const clip = item as ClipModel;
  return {
    id: clip.id,
    name: clip.name,
    variant,
    x: box.x,
    width: box.width,
    height: box.height,
    seed: hashKey(clip.mediaKey),
    sourceStart: clip.sourceRange.start,
    sourceDuration: clip.sourceRange.duration,
    rate,
    effects: clip.effects.length,
    dimmed: flags.dimmed || !clip.enabled,
    selected: flags.selected,
    frames: ref?.frames ?? [],
    onFrameReady,
  };
}

export function paintClipBody(c: CanvasRenderingContext2D, p: ClipPaint, token: TokenReader): void {
  const w = Math.max(MIN_CLIP_PX, p.width);
  const h = p.height;
  const [fillVar, barVar] = FILL[p.variant];

  c.save();
  c.globalAlpha = p.dimmed ? 0.45 : 1;
  c.beginPath();
  c.roundRect(p.x + 0.5, 0.5, w - 1, h - 1, 3);
  c.clip();

  c.fillStyle = token(fillVar);
  c.fillRect(p.x, 0, w, h);

  const body = { x: p.x, y: CLIP_BAR_H, w, h: h - CLIP_BAR_H };
  if (body.h > 4 && w > 4) {
    if (p.variant === 'audio') paintWaveform(c, body, p, token);
    else paintFilmstrip(c, body, p);
  }

  c.fillStyle = token(barVar);
  c.fillRect(p.x, 0, w, CLIP_BAR_H);
  c.fillStyle = 'rgba(255,255,255,.09)';
  c.fillRect(p.x, 0, w, 1);
  c.restore();

  c.save();
  c.globalAlpha = p.dimmed ? 0.45 : 1;
  c.strokeStyle = token('--clip-edge');
  c.lineWidth = 1;
  c.beginPath();
  c.roundRect(p.x + 0.5, 0.5, w - 1, h - 1, 3);
  c.stroke();
  c.restore();
}

function paintFilmstrip(
  c: CanvasRenderingContext2D,
  box: { x: number; y: number; w: number; h: number },
  p: ClipPaint,
): void {
  // one thumbnail per 16:9 slot, capped: past a few dozen the strip is noise
  const tw = Math.max(18, Math.round(box.h * (16 / 9)));
  const slots = Math.min(48, Math.max(1, Math.ceil(box.w / tw)));
  for (let i = 0; i < slots; i++) {
    const x = box.x + i * tw;
    const width = Math.min(tw, box.x + box.w - x);
    if (width <= 0) break;
    // the frame shown is the one that is actually there at that point in the
    // source, so trimming the head visibly scrolls the strip. A slot lands on
    // a whole frame first and is converted once, by the one function allowed
    // to know what a second is
    const sourceFrame = frames(Math.round(p.sourceStart + (i / slots) * p.sourceDuration));
    // pick the extracted frame closest to this slot's source time
    const keys = p.frames ?? [];
    if (keys.length) {
      const through = p.sourceDuration > 0 ? (sourceFrame - p.sourceStart) / p.sourceDuration : 0;
      const key = keys[Math.min(keys.length - 1, Math.max(0, Math.round(through * (keys.length - 1))))];
      const img = frameImage(key, p.onFrameReady ?? (() => {}));
      if (img) {
        c.save();
        c.beginPath();
        c.rect(x, box.y, width, box.h);
        c.clip();
        // cover, so a frame never stretches out of its own aspect ratio
        const scale = Math.max(width / img.naturalWidth, box.h / img.naturalHeight);
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        c.drawImage(img, x + (width - w) / 2, box.y + (box.h - h) / 2, w, h);
        c.restore();
      }
    }
  }
}

function paintWaveform(
  c: CanvasRenderingContext2D,
  box: { x: number; y: number; w: number; h: number },
  p: ClipPaint,
  token: TokenReader,
): void {
  const mid = box.y + box.h / 2;
  const r = noise(p.seed);
  c.save();
  c.strokeStyle = token('--wave');
  c.lineWidth = 1;
  c.globalAlpha *= 0.6; // multiply, so a dimmed clip's wave dims with it
  c.beginPath();
  let envelope = 0;
  const step = box.w > 1200 ? 2 : 1; // past a couple of thousand columns nobody can see the difference
  for (let x = 0; x < box.w; x += step) {
    const t = x / box.w;
    const target = 0.18 + 0.82 * Math.abs(
      Math.sin(t * Math.PI * (2 + (p.seed % 5))) * Math.sin(t * 13.7 + (p.seed % 7)),
    );
    envelope += (target - envelope) * 0.18;
    const a = Math.min(box.h / 2 - 1, envelope * (0.45 + r() * 0.55) * (box.h / 2) * 0.92);
    c.moveTo(box.x + x + 0.5, mid - a);
    c.lineTo(box.x + x + 0.5, mid + a);
  }
  c.stroke();
  c.strokeStyle = 'rgba(0,0,0,.35)';
  c.beginPath();
  c.moveTo(box.x, mid + 0.5);
  c.lineTo(box.x + box.w, mid + 0.5);
  c.stroke();
  c.restore();
}

// ── the DOM half ────────────────────────────────────────────────────────

export interface ClipViewProps {
  placed: PlacedItem;
  media: MediaRef | undefined;
  rate: Rate;
  x: number;
  width: number;
  height: number;
  selected: boolean;
  dimmed: boolean;
  locked: boolean;
  /** Handle grabbed, or null for the body. Blade mode passes the frame instead. */
  onGrab: (e: React.PointerEvent<HTMLElement>, placed: PlacedItem, edge: TrimEdge | null) => void;
  onSelect: (placed: PlacedItem, additive: boolean) => void;
}

export function ClipView({
  placed, media, rate, x, width, height, selected, dimmed, locked, onGrab, onSelect,
}: ClipViewProps) {
  const clip = placed.item as ClipModel;
  const w = Math.max(MIN_CLIP_PX, width);
  const showHandles = !locked && w > 14;
  const label = `${clip.name}, ${toTimecode(placed.range.start, rate)} to ${toTimecode(rangeEnd(placed.range), rate)}${locked ? ', track locked' : ''}`;

  return (
    <div
      data-clip-id={clip.id}
      role="option"
      aria-selected={selected}
      aria-label={label}
      title={media ? `${clip.name}, ${media.name}` : clip.name}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        onSelect(placed, e.shiftKey || e.metaKey);
        onGrab(e, placed, null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(placed, false);
        }
      }}
      style={{
        position: 'absolute',
        left: x,
        top: CLIP_INSET,
        width: w,
        height,
        borderRadius: 3,
        // transparent: the lane canvas underneath is painting this clip's body
        background: 'transparent',
        cursor: locked ? 'not-allowed' : 'grab',
        overflow: 'hidden',
        zIndex: selected ? 4 : 2,
        opacity: dimmed ? 0.55 : 1,
        // the Resolve selection ring: a bright hairline inside the action colour
        boxShadow: selected
          ? '0 0 0 1px var(--t1), 0 0 0 3px var(--orange), 0 2px 10px rgba(0,0,0,.6)'
          : undefined,
      }}
    >
      <div
        style={{
          height: CLIP_BAR_H,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 4px',
          pointerEvents: 'none',
        }}
      >
        <span
          style={{
            fontSize: 9.5,
            lineHeight: '13px',
            color: 'rgba(255,255,255,.86)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          {clip.name}
        </span>
        {clip.effects.some((fx) => fx.enabled) && (
          <span aria-hidden style={{ color: 'var(--orange)', fontSize: 7, flex: 'none' }}>◆</span>
        )}
      </div>

      {showHandles && (['in', 'out'] as const).map((edge) => (
        <div
          key={edge}
          role="separator"
          aria-label={`${edge === 'in' ? 'In' : 'Out'} point of ${clip.name}`}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.button !== 0) return;
            onSelect(placed, false);
            onGrab(e, placed, edge);
          }}
          style={{
            position: 'absolute',
            top: CLIP_BAR_H,
            bottom: 0,
            left: edge === 'in' ? 0 : undefined,
            right: edge === 'out' ? 0 : undefined,
            width: 5,
            cursor: 'ew-resize',
            zIndex: 3,
          }}
        />
      ))}
    </div>
  );
}
