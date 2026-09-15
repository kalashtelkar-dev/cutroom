'use client';
/**
 * The playhead.
 *
 * Sixty times a second, the only thing that changes is one transform. Putting
 * the playhead frame in React state would re-render every lane and every clip
 * at 60fps to move a one-pixel line, and that single decision is most of what
 * separates an NLE that feels like an instrument from one that feels like a
 * web page.
 *
 * So the frame lives in a plain object outside React. It writes the transform
 * itself, and it writes the timecode readouts itself. React learns about the
 * playhead only at the moments a human would call an event: a seek, a stop, a
 * click on the ruler.
 */
import { useEffect, useState } from 'react';
import {
  ZERO, clampFrames, frames, rateFps, toTimecode,
  type Frames, type Rate,
} from '../../lib/time/frames.ts';
import { framesToPx } from './interactions.ts';

/** Attached elements are told apart by what they do with the frame. */
export type PlayheadRole =
  /** Translated to the playhead's pixel. */
  | 'line'
  /** Translated to the playhead's pixel, but centred on it. */
  | 'shadow'
  /** Given the timecode as text. */
  | 'timecode';

export class PlayheadController {
  private frame: Frames = ZERO;
  private ppf = 1;
  private limit: Frames = frames(Number.MAX_SAFE_INTEGER);
  private attached = new Map<HTMLElement, PlayheadRole>();
  private listeners = new Set<(f: Frames) => void>();
  private raf = 0;
  private lastTs = 0;
  /** Fractional frames left over between ticks. Dropping them drifts. */
  private carry = 0;
  private _playing = false;

  /** Where playback asks the view to scroll. Set through `setChase`. */
  private chase: ((f: Frames) => void) | null = null;

  constructor(public rate: Rate, at: Frames = ZERO) {
    this.frame = at;
  }

  get playing(): boolean { return this._playing; }
  get(): Frames { return this.frame; }

  /** Let the view scroll to keep up with playback. Null detaches it. */
  setChase(fn: ((f: Frames) => void) | null): void { this.chase = fn; }

  /** Re-paint after a zoom. The frame is unchanged; only its pixel moved. */
  setScale(ppf: number): void {
    this.ppf = ppf;
    this.paint();
  }

  /** The last frame the playhead may reach. Playback stops there. */
  setLimit(limit: Frames): void {
    this.limit = limit;
    if (this.frame > limit) this.seek(limit);
  }

  attach(el: HTMLElement | null, role: PlayheadRole): void {
    if (!el) return;
    this.attached.set(el, role);
    this.paintOne(el, role);
  }

  detach(el: HTMLElement | null): void {
    if (el) this.attached.delete(el);
  }

  /** Discrete changes only: never the 60fps ones. See the file comment. */
  subscribe(fn: (f: Frames) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Move the playhead and tell React about it. */
  seek(to: Frames): void {
    this.apply(clampFrames(to, ZERO, this.limit));
    for (const fn of this.listeners) fn(this.frame);
  }

  nudge(by: number): void {
    this.seek(frames(this.frame + Math.round(by)));
  }

  play(): void {
    if (this._playing) return;
    this._playing = true;
    this.carry = 0;
    this.lastTs = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    for (const fn of this.listeners) fn(this.frame);
  }

  pause(): void {
    if (!this._playing) return;
    this._playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const fn of this.listeners) fn(this.frame);
  }

  toggle(): void {
    if (this._playing) this.pause();
    else this.play();
  }

  /** Stop the loop without telling React. For unmount. */
  dispose(): void {
    this._playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.listeners.clear();
    this.attached.clear();
    this.chase = null;
  }

  private tick = (ts: number): void => {
    if (!this._playing) return;
    const dt = Math.min(0.25, (ts - this.lastTs) / 1000); // a backgrounded tab must not leap
    this.lastTs = ts;
    // real time in, whole frames out, remainder kept: the playhead advances at
    // the project rate rather than at the monitor's refresh rate
    const advance = dt * rateFps(this.rate) + this.carry;
    const whole = Math.floor(advance);
    this.carry = advance - whole;
    if (whole > 0) {
      const next = frames(this.frame + whole);
      if (next >= this.limit) {
        this.apply(this.limit);
        this.pause();
        return;
      }
      this.apply(next);
      this.chase?.(next);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Move without notifying. The playback loop's only entry point. */
  private apply(to: Frames): void {
    this.frame = to;
    this.paint();
  }

  private paint(): void {
    for (const [el, role] of this.attached) this.paintOne(el, role);
  }

  private paintOne(el: HTMLElement, role: PlayheadRole): void {
    if (role === 'timecode') {
      el.textContent = toTimecode(this.frame, this.rate);
      return;
    }
    // translate3d, not `left`: a transform is composited and never reflows.
    // Both roles get the same transform: the shadow is centred by a negative
    // margin in CSS, because reading offsetWidth here would force a layout on
    // every animation frame and undo the whole point of this class.
    el.style.transform = `translate3d(${framesToPx(this.frame, this.ppf)}px,0,0)`;
  }
}

export function usePlayheadController(rate: Rate, at: Frames = ZERO): PlayheadController {
  const [controller] = useState(() => new PlayheadController(rate, at));
  useEffect(() => () => controller.dispose(), [controller]);
  return controller;
}

/** Re-render on the discrete moves only. Never call this inside a lane. */
export function usePlayheadFrame(controller: PlayheadController): Frames {
  const [f, setF] = useState(() => controller.get());
  useEffect(() => controller.subscribe(setF), [controller]);
  return f;
}

export function usePlaying(controller: PlayheadController): boolean {
  const [playing, setPlaying] = useState(false);
  useEffect(
    () => controller.subscribe(() => setPlaying(controller.playing)),
    [controller],
  );
  return playing;
}

export interface PlayheadProps {
  controller: PlayheadController;
  ppf: number;
  /**
   * Dynamic trim turns the playhead yellow. Resolve's semantic colours are
   * load-bearing: an editor reads the mode off the playhead, not off a menu.
   */
  dynamic?: boolean;
  /** Width of the ±5 frame wash either side. Zero hides it. */
  shadowFrames?: number;
}

export function Playhead({ controller, ppf, dynamic = false, shadowFrames = 5 }: PlayheadProps) {
  useEffect(() => { controller.setScale(ppf); }, [controller, ppf]);

  return (
    <>
      {shadowFrames > 0 && (
        <div
          ref={(el) => {
            controller.attach(el, 'shadow');
            return () => controller.detach(el);
          }}
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: Math.max(2, shadowFrames * 2 * ppf),
            marginLeft: -Math.max(2, shadowFrames * 2 * ppf) / 2,
            // the wash is the line's colour at 14%, read from the token so it
            // follows the palette and turns yellow with the line in dynamic trim
            background: `color-mix(in srgb, var(${dynamic ? '--yellow' : '--red'}) 14%, transparent)`,
            pointerEvents: 'none',
            zIndex: 1,
            willChange: 'transform',
          }}
        />
      )}
      <div
        ref={(el) => {
          controller.attach(el, 'line');
          return () => controller.detach(el);
        }}
        role="presentation"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: 1,
          background: dynamic ? 'var(--yellow)' : 'var(--red)',
          pointerEvents: 'none',
          zIndex: 6,
          willChange: 'transform',
        }}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            left: -5,
            width: 11,
            height: 11,
            background: dynamic ? 'var(--yellow)' : 'var(--red)',
            clipPath: 'polygon(0 0,100% 0,50% 100%)',
          }}
        />
      </div>
    </>
  );
}

/** A timecode field the controller writes to directly, at 60fps, for free. */
export function PlayheadTimecode({
  controller, className, style,
}: { controller: PlayheadController; className?: string; style?: React.CSSProperties }) {
  return (
    <span
      ref={(el) => {
        controller.attach(el, 'timecode');
        return () => controller.detach(el);
      }}
      className={className}
      style={style}
    >
      {toTimecode(controller.get(), controller.rate)}
    </span>
  );
}
