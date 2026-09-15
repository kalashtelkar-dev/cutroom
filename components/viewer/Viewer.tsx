'use client';

/**
 * The program viewer.
 *
 * One viewer with a Source / Timeline switch rather than two side by side:
 * at this width two viewers are two small viewers, and the Cut page proved
 * the switch is enough.
 *
 * **There is one clock.** The viewer does not run a playback loop of its own;
 * it drives the `PlayheadController` the timeline is already driving, so the
 * transport here moves the playhead there because it is the same object. A
 * viewer with its own rAF loop reporting frames out through `onSeek` is two
 * engines and two answers to "where is the playhead", and the two halves of
 * the app then disagree on screen. Source mode is the one exception, and it
 * is not the same playhead: a source monitor has its own, running in the
 * media's numbering, exactly as Resolve's does.
 *
 * React learns the position only on the discrete moves (a seek, a stop). The
 * picture and the jog are painted from the clock in one rAF while playback
 * runs, which is the same bargain Playhead.tsx makes for the timeline: no
 * component re-renders to move a playhead.
 *
 * Every time in here is `Frames`. The transport steps by one frame because
 * one frame is the unit an edit is made in, a "0.04 second" nudge is how a
 * cut ends up a frame off, and the jog maps a pixel to a frame rather than
 * to a float second. The last position the playhead can hold is
 * `duration - 1`: ranges are half-open, so `duration` is the first frame that
 * is *not* in the timeline.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { frames, rateFps, timeRange, toTimecode, type Frames } from '@/lib/time/frames.ts';
import { clipAt, isClip, itemAt, timelineDuration } from '@/lib/timeline/document.ts';
import type { MediaRef, PlacedItem, Timeline, Track } from '@/lib/timeline/types.ts';
import { usePlayheadController } from '../timeline/Playhead.tsx';
import type { PlayheadController } from '../timeline/Playhead.tsx';
import { DEFAULT_CLIP_PARAMS, type ClipParams } from '../inspector/Inspector.tsx';
import { tip } from '../ui/Tooltip.tsx';
import { captionAt } from '@/lib/subtitles/place.ts';
import { Layers, type LayerSpec, type AudioSpec } from './Layers.tsx';
import { activeTimelineSignature } from './onscreen.ts';
import { timelineHasAudioTracks } from './sound.ts';
import { COMPOSITE_EFFECT } from '@/lib/inspector/effects.ts';
import { frameKeyAt } from '../../lib/media/frameAt.ts';
import {
  atEnd, clampToWindow, hasRoom, scrubFrame, sourceWindow, timelineWindow, trimMarks,
  windowFraction,
} from './transport.ts';

export interface ViewerProps {
  timeline: Timeline;
  playhead: Frames;
  onSeek: (at: Frames) => void;
  /**
   * The one playhead clock. Hand down the controller the timeline is already
   * driving and this transport moves that playhead, because it is the same
   * object. Without it the viewer builds a controller of its own and keeps it
   * in step with `playhead` and `onSeek`, which is enough for a viewer on its
   * own and is not enough beside a timeline.
   */
  controller?: PlayheadController;
  /** The selected clip, shown when the viewer is switched to Source. */
  source?: PlacedItem | null;
  /** That clip's media, so Source can scrub the handles rather than the cut. */
  sourceMedia?: MediaRef | null;
  /**
   * The inspector's values for a clip, by id. A lookup rather than one value
   * because the viewer decides which clip is on screen, the program clip, or
   * the selected one in Source, and the picture must match that clip.
   */
  paramsFor?: (clipId: string) => ClipParams;
  /**
   * Which monitor is showing, when the app wants a say.
   *
   * Left off, the viewer keeps its own and the two buttons are the only way
   * to move between them. Given, the app can put something in Source and have
   * Source be what you are looking at, which is what clicking a file in the
   * pool has to do to mean anything.
   */
  mode?: ViewerMode;
  onModeChange?: (mode: ViewerMode) => void;
  focused?: boolean;
  onFocus?: () => void;
}

export type ViewerMode = 'source' | 'timeline';
type Mode = ViewerMode;

const W = 480;
const H = 270;

const NO_RANGE = timeRange(frames(0), frames(0));

function trackLevel(track: Track): number {
  const fromName = /(\d+)\s*$/.exec(track.name)?.[1];
  const fromId = /(\d+)$/.exec(track.id)?.[1];
  return Number(fromName ?? fromId ?? 0) || 0;
}


export function Viewer({
  timeline,
  playhead,
  onSeek,
  controller,
  source = null,
  sourceMedia = null,
  paramsFor,
  mode: modeProp,
  onModeChange,
  focused = false,
  onFocus,
}: ViewerProps) {
  // controlled when the app passes one, its own otherwise. The local copy is
  // kept in step either way, so letting go of the prop does not jump.
  const [ownMode, setOwnMode] = useState<Mode>('timeline');
  const mode = modeProp ?? ownMode;
  const setMode = useCallback((next: Mode) => {
    setOwnMode(next);
    onModeChange?.(next);
  }, [onModeChange]);
  const [loop, setLoop] = useState(false);
  /**
   * Intent, as opposed to `playing`, which is what the engine is doing. A ref
   * because nothing renders from it: it exists so the effect below can tell a
   * run off the end apart from a person pressing Stop.
   */
  const wantPlay = useRef(false);

  const root = useRef<HTMLDivElement | null>(null);
  const jog = useRef<HTMLDivElement | null>(null);
  const handle = useRef<HTMLElement | null>(null);
  const clockTc = useRef<HTMLSpanElement | null>(null);

  const duration = timelineDuration(timeline);
  const program = useMemo(() => timelineWindow(duration), [duration]);

  const sourceItem = source && isClip(source.item) ? source.item : null;
  const sourceId = sourceItem ? sourceItem.id : null;
  const used = sourceItem ? sourceItem.sourceRange : NO_RANGE;
  const inSource = mode === 'source' && sourceItem !== null;
  const srcWin = useMemo(() => sourceWindow(used, sourceMedia), [used, sourceMedia]);

  // Hooks cannot be conditional, so the fallback controller is always built.
  // When the app hands one down it is simply never played: `clock` below is
  // the only one anything in here touches.
  const fallback = usePlayheadController(timeline.rate, playhead);
  const sourceClock = usePlayheadController(timeline.rate, srcWin.first);
  const programClock = controller ?? fallback;
  const clock = inSource ? sourceClock : programClock;
  const win = inSource ? srcWin : program;

  const [position, setPosition] = useState<Frames>(() => clock.get());
  const [playing, setPlaying] = useState(() => clock.playing);
  const [clockSeen, setClockSeen] = useState(clock);
  const lastActiveSig = useRef<string>('');
  if (clockSeen !== clock) {
    // Switching monitors switches clocks, and the new one is somewhere else
    // entirely. Read it now rather than waiting for it to move, or Source
    // opens showing the program's frame number.
    setClockSeen(clock);
    setPosition(clock.get());
    setPlaying(clock.playing);
  }
  useEffect(() => {
    wantPlay.current = false;   // intent does not carry from one clock to the other
    return clock.subscribe((f) => {
      lastActiveSig.current = inSource ? '' : activeTimelineSignature(timeline, f);
      setPosition(f);
      setPlaying(clock.playing);
    });
  }, [clock, inSource, timeline]);

  useEffect(() => {
    if (controller) return;               // its owner sets the limit it wants
    fallback.setLimit(program.last);
  }, [controller, fallback, program.last]);

  useEffect(() => { sourceClock.setLimit(srcWin.last); }, [sourceClock, srcWin.last]);

  // Adopt an outside move. Guarded, so the seek this causes cannot bounce:
  // the controller notifies, `onSeek` hands the same frame back, and the next
  // run of this effect finds them already equal.
  useEffect(() => {
    if (controller) return;
    if (fallback.get() !== playhead) fallback.seek(playhead);
  }, [controller, fallback, playhead]);

  useEffect(
    () => (controller ? undefined : fallback.subscribe(onSeek)),
    [controller, fallback, onSeek],
  );

  // Opening a different clip parks Source on that clip's in point: the first
  // frame the cut uses, which is not the first frame of the media.
  const inPoint = used.start;
  useEffect(() => {
    sourceClock.pause();
    sourceClock.seek(clampToWindow(srcWin, inPoint));
  }, [sourceClock, sourceId, inPoint, srcWin]);

  const seek = useCallback((to: number) => {
    clock.seek(clampToWindow(win, to));
  }, [clock, win]);

  const stop = useCallback(() => {
    wantPlay.current = false;
    clock.pause();
  }, [clock]);

  const start = useCallback(() => {
    // parked on the last frame, Play means play it again rather than stop
    if (atEnd(win, clock.get())) clock.seek(win.first);
    wantPlay.current = true;
    clock.play();
  }, [clock, win]);

  const toggle = useCallback(() => {
    if (playing) stop(); else start();
  }, [playing, start, stop]);

  // Loop lives here rather than in the controller: the controller is shared
  // with the timeline, and a loop is this panel's toggle. `wantPlay` is what
  // tells a run off the end apart from a person pressing Stop.
  useEffect(() => {
    if (playing || !wantPlay.current) return;
    if (!loop || !hasRoom(win)) { wantPlay.current = false; return; }
    clock.seek(win.first);
    clock.play();
  }, [playing, loop, clock, win]);

  // The clock writes the timecode itself, 60 times a second, for free.
  useEffect(() => {
    const el = clockTc.current;
    clock.attach(el, 'timecode');
    return () => clock.detach(el);
  }, [clock]);

  /**
   * The jog handle, moved outside React.
   *
   * This is all that is left of the old canvas painter: the picture is DOM
   * elements now, and the browser composites them. The handle still has to
   * follow the clock 60 times a second, which is not something to re-render
   * the panel for.
   */
  useEffect(() => {
    const h = handle.current;
    if (h) h.style.left = `${windowFraction(win, frames(position)) * 100}%`;
  }, [position, win]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const draw = () => {
      const cur = clock.get();
      const h = handle.current;
      if (h) h.style.left = `${windowFraction(win, cur) * 100}%`;
      if (inSource) {
        if (source && isClip(source.item) && sourceMedia && !sourceMedia.proxy) {
          const fk = frameKeyAt(sourceMedia, source.item.sourceRange.start + (cur - win.first)) ?? '';
          if (fk !== lastActiveSig.current) {
            lastActiveSig.current = fk;
            setPosition(cur);
          }
        }
      } else {
        const sig = activeTimelineSignature(timeline, cur);
        if (sig !== lastActiveSig.current) {
          lastActiveSig.current = sig;
          setPosition(cur);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [playing, clock, win, inSource, source, sourceMedia, timeline]);

  // ── input ─────────────────────────────────────────────────────────────

  const takeFocus = () => {
    onFocus?.();
    // the orange bar and the keyboard target have to be the same element: a
    // container that is not focusable never sees a key, and every shortcut
    // these tooltips advertise would be dead the moment you click the picture
    const el = root.current;
    if (el && !el.contains(document.activeElement)) el.focus();
  };

  const scrubFrom = (clientX: number) => {
    const el = jog.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    seek(scrubFrame(win, r.width > 0 ? (clientX - r.left) / r.width : 0));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // a chord belongs to the shell: Cmd K must not also stop playback
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // let a focused control have its own keys; Space on a button is a click
    if (e.target instanceof HTMLElement && /^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    }
    if (e.key === ' ') { e.preventDefault(); toggle(); return; }
    if (e.key === 'k' || e.key === 'K') { e.preventDefault(); stop(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); seek(position - (e.shiftKey ? 10 : 1)); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); seek(position + (e.shiftKey ? 10 : 1)); return; }
    if (e.key === 'Home') { e.preventDefault(); seek(win.first); return; }
    if (e.key === 'End') { e.preventDefault(); seek(win.last); }
  };

  /**
   * Playback.
   *
   * The clock stays the master: it is shared with the timeline, so the
   * playhead and the picture cannot disagree about where we are. The video
   * element follows it, and is corrected only when it has drifted further
   * than a couple of frames, because correcting every tick makes the picture
   * stutter audibly.
   */
  /**
   * The picture, as layers.
   *
   * One per picture track carrying a clip at this frame, bottom track first,
   * so V2 sits over V1 exactly as the timeline says and a blend has something
   * underneath to act on. The old single element showed whatever was topmost
   * and nothing else, which is a clip preview rather than a program monitor.
   */
function isTrackAudible(track: Track, allTracks: Track[]): boolean {
  if (!track.enabled || track.muted) return false;
  const anySolo = allTracks.some((t) => t.solo && t.enabled);
  return anySolo ? track.solo : true;
}

  const layers = useMemo<LayerSpec[]>(() => {
    const at = frames(position);

    if (inSource) {
      if (!source || !isClip(source.item)) return [];
      const item = source.item;
      return [{
        trackId: 'source',
        proxyKey: sourceMedia?.proxy,
        frameKey: sourceMedia ? frameKeyAt(sourceMedia, item.sourceRange.start + (at - win.first)) ?? undefined : undefined,
        clipStart: win.first,
        clipDuration: item.sourceRange.duration,
        sourceStart: item.sourceRange.start,
        params: paramsFor ? paramsFor(item.id) : DEFAULT_CLIP_PARAMS,
        blendMode: 'normal',
        label: item.name,
        audible: true,
        soundOnAudioTracks: false,
      }];
    }

    const out: LayerSpec[] = [];
    // Sound belongs to the audio tracks whenever the timeline has any. Asked
    // of the tracks, never of the frame under the playhead: a delayed audio
    // clip leaves a gap, and a gap must not hand the sound back to the
    // picture. sound.ts has the whole argument.
    const soundOnAudioTracks = timelineHasAudioTracks(timeline);
    const videoTracks = timeline.tracks
      .filter((t) => t.kind === 'video' && t.enabled)
      .sort((a, b) => trackLevel(a) - trackLevel(b));

    for (const track of videoTracks) {
      const placed = itemAt(track, at);
      if (!placed || !isClip(placed.item) || !placed.item.enabled) continue;
      const item = placed.item;
      const media = timeline.media[item.mediaKey];
      const composite = item.effects.find((fx) => fx.enabled && fx.kind === COMPOSITE_EFFECT);
      out.push({
        trackId: track.id,
        proxyKey: media?.proxy,
        frameKey: media
          ? frameKeyAt(media, item.sourceRange.start + (at - placed.range.start)) ?? undefined
          : undefined,
        clipStart: placed.range.start,
        clipDuration: placed.range.duration,
        sourceStart: item.sourceRange.start,
        params: paramsFor ? paramsFor(item.id) : DEFAULT_CLIP_PARAMS,
        blendMode: String(composite?.params.mode ?? 'normal'),
        label: item.name,
        audible: isTrackAudible(track, timeline.tracks),
        soundOnAudioTracks,
      });
    }
    return out;
  }, [timeline, position, inSource, source, sourceMedia, win.first, paramsFor]);

  const audioLayers = useMemo<AudioSpec[]>(() => {
    if (inSource) return [];
    const at = frames(position);
    const out: AudioSpec[] = [];
    for (const track of timeline.tracks) {
      if (track.kind !== 'audio' || !track.enabled) continue;
      const placed = itemAt(track, at);
      if (!placed || !isClip(placed.item) || !placed.item.enabled) continue;
      const item = placed.item;
      const media = timeline.media[item.mediaKey];
      if (!media?.proxy) continue;
      out.push({
        trackId: track.id,
        proxyKey: media.proxy,
        clipStart: placed.range.start,
        clipDuration: placed.range.duration,
        sourceStart: item.sourceRange.start,
        label: item.name,
        audible: isTrackAudible(track, timeline.tracks),
      });
    }
    return out;
  }, [timeline, position, inSource]);

  const preloadKeys = useMemo<string[]>(() => {
    if (inSource) return [];
    const set = new Set<string>();
    const currentKeys = new Set([
      ...layers.map((l) => l.proxyKey).filter((k): k is string => !!k),
      ...audioLayers.map((a) => a.proxyKey).filter(Boolean),
    ]);

    for (const track of timeline.tracks) {
      if (!track.enabled) continue;
      for (const item of track.items) {
        if (!isClip(item)) continue;
        const media = timeline.media[item.mediaKey];
        if (media?.proxy && !currentKeys.has(media.proxy)) {
          set.add(media.proxy);
          if (set.size >= 4) break;
        }
      }
      if (set.size >= 4) break;
    }
    return Array.from(set);
  }, [timeline, inSource, layers, audioLayers]);

  const topLayer = layers.length ? layers[layers.length - 1] : null;
  const nothingToShow = layers.length === 0;
  const waiting = !nothingToShow && layers.every((l) => !l.proxyKey && !l.frameKey);

  const rate = timeline.rate;
  /**
   * Source shows one clip on its own, so the programme's subtitles have no
   * business over it: they are timed against the timeline, not the handles.
   */
  const caption = inSource ? null : captionAt(timeline, position);
  const marks = inSource ? trimMarks(win, used) : null;
  const shown = inSource ? source : clipAt(timeline, position);
  const shownItem = shown && isClip(shown.item) ? shown.item : null;
  const params = shownItem && paramsFor ? paramsFor(shownItem.id) : DEFAULT_CLIP_PARAMS;

  /**
   * Media with frames but nothing to play.
   *
   * A still legitimately has no proxy. A video without one is a clip that
   * steps through the handful of extracted frames and has no sound, and
   * pressing play on it moves the clock and almost nothing else. That is a
   * reasonable thing to fall back to and an unreasonable thing to keep quiet
   * about: the picture looks frozen and nothing on screen says why.
   */
  const shownMedia = shownItem
    ? (inSource ? sourceMedia : timeline.media[shownItem.mediaKey] ?? null)
    : null;
  const stepping = !!shownMedia && shownMedia.kind !== 'image' && !shownMedia.proxy;

  return (
    <>
      <style href="cutroom-viewer" precedence="medium">{CSS}</style>
      <div
        className="cr-viewer"
        ref={root}
        tabIndex={0}
        data-focused={focused ? 'true' : undefined}
        onPointerDown={takeFocus}
        onFocus={() => onFocus?.()}
        onKeyDown={onKeyDown}
      >
        <div className="cr-vhead">
          <span className="cr-vmode" role="group" aria-label="Viewer source">
            <button
              type="button"
              data-on={mode === 'source' ? 'true' : undefined}
              aria-pressed={mode === 'source'}
              onClick={() => setMode('source')}
              data-tip={tip('Source', 'The clip you selected, on its own, with the handles either side of the cut.')}
            >
              Source
            </button>
            <button
              type="button"
              data-on={mode === 'timeline' ? 'true' : undefined}
              aria-pressed={mode === 'timeline'}
              onClick={() => setMode('timeline')}
              data-tip={tip('Timeline', 'The program: whatever the playhead is over, top track down.')}
            >
              Timeline
            </button>
          </span>
          <span className="cr-vttl">
            {inSource ? (shownItem?.name ?? 'No clip selected') : timeline.name}
          </span>
          <span className="cr-vtc" ref={clockTc}>{toTimecode(position, rate)}</span>
          <span className="cr-vsep">/</span>
          <span className="cr-vtc">{toTimecode(win.duration, rate)}</span>
        </div>

        <div className="cr-vstage">
          <div className="cr-vframe">
            <Layers
              layers={layers}
              audioLayers={audioLayers}
              preloadKeys={preloadKeys}
              clock={clock}
              playing={playing}
              position={position}
              rate={timeline.rate}
            />
            {/**
              * The caption under the playhead.
              *
              * Read from the document on every frame, not from a parsed copy
              * of a file: the cue items ARE the subtitles, so what is on
              * screen here is what the export burns in, and a cue nudged on
              * the timeline moves here with no reload.
              */}
            {caption ? (
              <div
                className="cr-vcap"
                data-caption-id={caption.id}
                data-place={caption.style?.place ?? 'bottom'}
              >
                <span
                  style={{
                    ...(caption.style?.size ? { fontSize: `${(caption.style.size / 1080) * 100}cqh` } : {}),
                    ...(caption.style?.colour ? { color: caption.style.colour } : {}),
                    ...(caption.style?.outline === false ? { textShadow: 'none' } : {}),
                  }}
                >
                  {caption.text}
                </span>
              </div>
            ) : null}
            {nothingToShow || waiting ? (
              <p className="cr-vempty">
                {nothingToShow
                  ? (mode === 'source' ? 'no clip selected' : 'no clip under the playhead')
                  : 'no preview was made for this media'}
              </p>
            ) : null}
          </div>
          <div className="cr-vovl">
            <span>{shownItem ? shownItem.name : mode === 'source' ? 'no clip selected' : 'no clip under the playhead'}</span>
            {stepping ? (
              <span className="cr-vnop" title={`${shownMedia.frames?.length ?? 0} frames were extracted from this media, and a playable copy was not made. It still cuts and still exports.`}>
                no playable copy: {shownMedia.frames?.length ?? 0} frames, no sound
              </span>
            ) : null}
            <span>
              Zoom {params.transformOn ? params.zoom.toFixed(2) : '1.00'}
              {params.speedOn && params.speed !== 100 ? ` · ${params.speed}%` : ''}
            </span>
          </div>
        </div>

        <div
          className="cr-jog"
          ref={jog}
          role="slider"
          tabIndex={0}
          aria-label="Jog"
          aria-valuemin={win.first}
          aria-valuemax={win.last}
          aria-valuenow={position}
          aria-valuetext={toTimecode(position, rate)}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            scrubFrom(e.clientX);
          }}
          onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) scrubFrom(e.clientX); }}
          onPointerUp={(e) => { try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ } }}
        >
          {marks ? (
            <>
              <span
                className="cr-vused"
                aria-hidden="true"
                style={{ left: `${marks.in * 100}%`, right: `${(1 - marks.out) * 100}%` }}
              />
              <span className="cr-vmark" style={{ left: `${marks.in * 100}%` }} aria-hidden="true" />
              <span className="cr-vmark" style={{ left: `${marks.out * 100}%` }} aria-hidden="true" />
            </>
          ) : null}
          <i ref={handle} style={{ left: `${windowFraction(win, position) * 100}%` }} />
        </div>

        <div className="cr-vtrans" role="group" aria-label="Transport">
          <TBtn label="First frame" tipText="Park the playhead at the top." meta="Home" onClick={() => seek(win.first)}>
            <path d="M4 3h1.6v10H4zM12.5 3v10L6 8z" />
          </TBtn>
          <TBtn label="Back one frame" tipText={`One frame, 1/${Math.round(rateFps(rate))} of a second here.`} meta="←" onClick={() => seek(position - 1)}>
            <path d="M12 3v10L4 8z" />
          </TBtn>
          <TBtn label="Stop" tipText="Halt playback and hold position." meta="K" onClick={stop}>
            <rect x="4" y="4" width="8" height="8" />
          </TBtn>
          <TBtn
            label={playing ? 'Pause' : 'Play'}
            tipText="Run the timeline from the playhead."
            meta="Space"
            on={playing}
            onClick={toggle}
          >
            {playing ? <path d="M4 3h3v10H4zM9 3h3v10H9z" /> : <path d="M4 3l8 5-8 5z" />}
          </TBtn>
          <TBtn label="Forward one frame" tipText="One frame at a time." meta="→" onClick={() => seek(position + 1)}>
            <path d="M4 3l8 5-8 5z" />
          </TBtn>
          <TBtn label="Last frame" tipText="Park on the last frame of the edit." meta="End" onClick={() => seek(win.last)}>
            <path d="M12 3h-1.6v10H12zM3.5 3v10L10 8z" />
          </TBtn>
          <span className="cr-vdiv" />
          <TBtn
            label="Loop"
            tipText="Repeat from the top when playback reaches the end."
            on={loop}
            onClick={() => setLoop((l) => !l)}
            stroke
          >
            <path d="M3 6.5A3.5 3.5 0 016.5 3H11M13 9.5A3.5 3.5 0 019.5 13H5" />
            <path d="M9.5 1.5L11.5 3 9.5 4.5M6.5 11.5L4.5 13l2 1.5" />
          </TBtn>
        </div>
      </div>
    </>
  );
}

function TBtn({
  label, tipText, meta, on, stroke, onClick, children,
}: {
  label: string;
  tipText: string;
  meta?: string;
  on?: boolean;
  stroke?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="cr-tbtn"
      data-on={on ? 'true' : undefined}
      aria-label={label}
      aria-pressed={on === undefined ? undefined : on}
      data-tip={tip(label, tipText, meta)}
      onClick={onClick}
    >
      <svg
        viewBox="0 0 16 16"
        width="13"
        height="13"
        fill={stroke ? 'none' : 'currentColor'}
        stroke={stroke ? 'currentColor' : 'none'}
        strokeWidth={stroke ? 1.4 : undefined}
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}

// ── the picture ─────────────────────────────────────────────────────────

const CSS = `
.cr-viewer{
  flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;
  background:var(--app);font-family:var(--ui);position:relative;
}
.cr-viewer:focus:not(:focus-visible){outline:none}
.cr-viewer::before{
  content:"";position:absolute;top:0;left:0;right:0;height:2px;
  background:var(--orange);opacity:0;z-index:3;
}
.cr-viewer[data-focused]::before{opacity:1}
.cr-vhead{
  height:28px;flex:none;background:var(--panel);border-bottom:1px solid var(--edge);
  display:flex;align-items:center;padding:0 9px;gap:9px;font-size:11px;color:var(--t2);
}
.cr-vmode{display:flex;gap:1px;flex:none;background:var(--app);border-radius:4px;padding:1px}
.cr-vmode button{
  font-size:10px;font-weight:600;padding:2px 9px;border-radius:4px;color:var(--t3);
  letter-spacing:.02em;background:none;border:0;cursor:pointer;font-family:inherit;
}
.cr-vmode button[data-on]{background:var(--edge-soft);color:var(--t1)}
.cr-vttl{
  flex:1;text-align:center;color:var(--t2);font-weight:500;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;
}
.cr-viewer[data-focused] .cr-vttl{color:var(--t1)}
.cr-vtc{
  font-family:var(--mono);font-size:10.5px;font-variant-numeric:tabular-nums;color:var(--t2);
}
.cr-vsep{color:var(--t3)}
.cr-vstage{
  flex:1;background:var(--app);display:flex;align-items:center;justify-content:center;
  min-height:0;position:relative;overflow:hidden;
}
/* the frame the layers composite inside: a fixed 16:9 box so a layer with a
   different shape letterboxes rather than resizing the panel.

   It is the query container, and it has to be this element rather than the
   caption box: cqw and cqh resolve against an ANCESTOR container, never
   against the element declaring one, so a .cr-vcap that was its own container
   measured its own padding against the window. In a 2560px window a 520px
   frame was given 153.6px of padding a side, which left 212px for the words
   and shrank the type with it. Sizing here is safe because this box is sized
   by its width, height and ratio and never by what is inside it. */
.cr-vframe{
  position:relative;width:100%;height:100%;max-width:100%;max-height:100%;
  aspect-ratio:16/9;background:var(--app);overflow:hidden;isolation:isolate;
  container-type:size;
}
.cr-vframe video,.cr-vframe img{display:block}
.cr-vempty{
  position:absolute;inset:0;margin:0;display:flex;align-items:center;justify-content:center;
  font-family:var(--mono);font-size:11px;color:var(--t3);text-align:center;padding:12px;
  background:var(--panel-2);z-index:50;
}
/* Subtitles, sized against the frame rather than the panel: a caption has to
   keep its proportion of the picture when the viewer is resized, which is
   what cqh gives and what px cannot. */
.cr-vcap{
  position:absolute;inset:0;display:flex;justify-content:center;
  pointer-events:none;z-index:40;
  padding:0 6cqw 4cqh;
}
.cr-vcap[data-place="bottom"]{align-items:flex-end}
.cr-vcap[data-place="top"]{align-items:flex-start;padding:4cqh 6cqw 0}
.cr-vcap[data-place="centre"]{align-items:center;padding:0 6cqw}
.cr-vcap span{
  font-family:var(--ui);font-size:4.4cqh;line-height:1.25;font-weight:600;
  color:var(--caption-ink);text-align:center;white-space:pre-wrap;text-wrap:balance;
  /* an outline, not a box: a filled band over the picture hides more of the
     shot than the words need, and this is what every player does */
  text-shadow:0 0 4px var(--caption-shade), 0 1px 0 var(--caption-shade),
              0 -1px 0 var(--caption-shade), 1px 0 0 var(--caption-shade),
              -1px 0 0 var(--caption-shade);
  max-width:100%;
}

.cr-vovl{
  position:absolute;inset:0;pointer-events:none;
  display:flex;align-items:flex-start;justify-content:space-between;padding:8px;gap:8px;
}
.cr-vovl span{
  font-family:var(--mono);font-size:9.5px;color:var(--t2);
  background:color-mix(in srgb, var(--app) 55%, transparent);
  padding:1px 5px;border-radius:1px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
/* the picture is frozen and the reason has to be on screen, not in a log */
.cr-vovl span.cr-vnop{color:var(--yellow);flex:0 0 auto}
.cr-jog{
  height:5px;background:var(--panel);margin:0 9px;border-radius:4px;flex:none;
  position:relative;cursor:pointer;touch-action:none;
}
.cr-jog i{
  position:absolute;top:-2px;width:2px;height:9px;background:var(--red);border-radius:1px;
  z-index:2;
}
/* the part of the media the cut actually uses; either side of it is handle */
.cr-vused{
  position:absolute;top:0;bottom:0;background:var(--edge-soft);border-radius:4px;
}
.cr-vmark{
  position:absolute;top:-3px;width:1px;height:11px;background:var(--green);z-index:1;
}
.cr-vtrans{
  height:34px;flex:none;background:var(--panel);border-top:1px solid var(--edge);
  display:flex;align-items:center;justify-content:center;gap:3px;
}
.cr-tbtn{
  width:26px;height:22px;border-radius:4px;color:var(--t2);
  display:flex;align-items:center;justify-content:center;
  background:none;border:0;cursor:pointer;padding:0;
}
.cr-tbtn:hover{background:var(--edge);color:var(--t1)}
.cr-tbtn[data-on]{color:var(--orange)}
.cr-vdiv{width:1px;height:16px;background:var(--edge-soft);margin:0 5px;flex:none}
`;
