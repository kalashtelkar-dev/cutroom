'use client';

/**
 * The program monitor's picture: one layer per picture track, stacked.
 *
 * The viewer used to show a single element carrying whatever `clipAt` said
 * was topmost. That is a clip preview, not a program monitor: B-roll on V2
 * over A-roll on V1 is two layers, and showing only the top one means an
 * opacity or a blend has nothing underneath to act on. It also meant the
 * element's source changed every time the playhead crossed into a B-roll
 * clip, which reloads it and stalls playback.
 *
 * So: one element per track, bottom track first in DOM order, composited by
 * the browser. `mix-blend-mode` takes the same modes ffmpeg's `blend` filter
 * does, so the monitor and the render agree about what a screen looks like.
 *
 * A layer plays when it has a proxy and shows its nearest extracted frame
 * when it does not, which keeps a clip visible while its transcode is still
 * running instead of hiding the track.
 */

import { useEffect, useRef, useState } from 'react';
import type { ClipParams } from '../inspector/types.ts';
import type { Rate } from '@/lib/time/frames.ts';
import { rateFps } from '@/lib/time/frames.ts';
import type { PlayheadController } from '../timeline/Playhead.tsx';
import { layerMuted } from './sound.ts';

/** What ffmpeg's blend modes are called in CSS. */
const CSS_BLEND: Record<string, string> = {
  normal: 'normal',
  addition: 'plus-lighter',
  overlay: 'overlay',
  screen: 'screen',
  multiply: 'multiply',
};

export const BLEND_TO_CSS = (mode: string): string => CSS_BLEND[mode] ?? 'normal';

export interface LayerSpec {
  /** The track this layer is, which is also its identity across frames. */
  trackId: string;
  /** An `output/` key that can be streamed, when the media has one. */
  proxyKey?: string;
  /** The nearest extracted frame, for media with no proxy yet. */
  frameKey?: string;
  /** Timeline frame the clip starts at. */
  clipStart: number;
  /** Duration of the clip in timeline frames. */
  clipDuration?: number;
  /** Frame of the source the clip starts at. */
  sourceStart: number;
  params: ClipParams;
  blendMode: string;
  label: string;
  /** Whether this layer should produce sound, driven by track mute and solo. */
  audible?: boolean;
  /**
   * True when this picture's sound lives on the audio tracks, so the element
   * itself stays silent. Read from the timeline's tracks and NOT from what
   * sits under the playhead: see sound.ts.
   */
  soundOnAudioTracks?: boolean;
}

export interface AudioSpec {
  trackId: string;
  proxyKey: string;
  clipStart: number;
  /** Duration of the clip in timeline frames. */
  clipDuration?: number;
  sourceStart: number;
  label: string;
  audible: boolean;
}

/**
 * How the inspector's values become CSS.
 *
 * Crop is a matte and not a scale, so it is `clip-path` and not a transform:
 * cropping must remove picture rather than enlarge what is left.
 */
function layerStyle(p: ClipParams, blendMode: string, z: number): React.CSSProperties {
  const transform = p.transformOn
    ? `translate(${p.posX * 0.2}%, ${p.posY * 0.2}%) rotate(${p.rotation}deg) scale(${p.zoom})`
    : undefined;
  const clipPath = p.cropOn && (p.cropL || p.cropR || p.cropT || p.cropB)
    ? `inset(${p.cropT}% ${p.cropR}% ${p.cropB}% ${p.cropL}%)`
    : undefined;
  return {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    zIndex: z,
    transform,
    clipPath,
    opacity: p.compositeOn ? Math.max(0, Math.min(1, p.opacity / 100)) : 1,
    // the bottom layer has nothing under it, and `plus-lighter` against the
    // page background washes it out
    mixBlendMode: z === 0 ? 'normal' : (BLEND_TO_CSS(blendMode) as React.CSSProperties['mixBlendMode']),
    background: 'transparent',
  };
}

export interface LayersProps {
  layers: LayerSpec[];
  audioLayers?: AudioSpec[];
  preloadKeys?: string[];
  clock: PlayheadController;
  playing: boolean;
  /** The frame the clock is on, for the parked case. */
  position: number;
  rate: Rate;
}

export function Layers({
  layers,
  audioLayers = [],
  preloadKeys = [],
  clock,
  playing,
  position,
  rate,
}: LayersProps) {
  return (
    <>
      {layers.map((layer, i) => (
        <Layer
          key={layer.trackId}
          spec={layer}
          z={i}
          clock={clock}
          playing={playing}
          position={position}
          rate={rate}
        />
      ))}
      {audioLayers.map((audio) => (
        <AudioLayer
          key={audio.trackId}
          spec={audio}
          clock={clock}
          playing={playing}
          position={position}
          rate={rate}
        />
      ))}
      <PreloadPool keys={preloadKeys} />
    </>
  );
}

function PreloadPool({ keys }: { keys: string[] }) {
  if (!keys.length) return null;
  return (
    <div style={{ display: 'none' }} aria-hidden="true">
      {keys.map((k) => (
        <video
          key={k}
          preload="auto"
          muted
          playsInline
          src={`/api/media/stream?key=${encodeURIComponent(k)}`}
        />
      ))}
    </div>
  );
}

function AudioLayer({
  spec, clock, playing, position, rate,
}: {
  spec: AudioSpec;
  clock: PlayheadController;
  playing: boolean;
  position: number;
  rate: Rate;
}) {
  const el = useRef<HTMLAudioElement | null>(null);
  const [broken, setBroken] = useState(false);
  const fps = rateFps(rate);
  const specRef = useRef(spec);
  specRef.current = spec;
  const { proxyKey, clipStart, sourceStart, audible } = spec;

  useEffect(() => {
    setBroken(false);
    const a = el.current;
    if (!a || !proxyKey) return;
    const src = `/api/media/stream?key=${encodeURIComponent(proxyKey)}`;
    if (a.getAttribute('src') !== src) {
      a.setAttribute('src', src);
      a.load();
    }
  }, [proxyKey]);

  useEffect(() => {
    const a = el.current;
    if (!a || broken || playing) return;
    const want = (sourceStart + Math.max(0, position - clipStart)) / fps;
    if (Math.abs(a.currentTime - want) > 0.02) a.currentTime = want;
    if (!a.paused) a.pause();
  }, [broken, playing, position, clipStart, sourceStart, fps]);

  useEffect(() => {
    const a = el.current;
    if (!a || broken) return;
    if (!playing) { a.pause(); return; }

    const want = () => (sourceStart + Math.max(0, clock.get() - clipStart)) / fps;
    a.currentTime = want();
    void a.play().catch(() => {});

    const drift = 2 / fps;
    let raf = 0;
    const follow = () => {
      const cur = clock.get();
      const dur = specRef.current.clipDuration ?? Infinity;
      const start = specRef.current.clipStart;
      if (cur < start || cur >= start + dur) {
        if (!a.paused) a.pause();
      } else {
        const target = want();
        if (Math.abs(a.currentTime - target) > drift) a.currentTime = target;
        if (a.paused && specRef.current.audible) void a.play().catch(() => {});
      }
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return () => { cancelAnimationFrame(raf); a.pause(); };
  }, [broken, playing, clock, clipStart, sourceStart, fps, audible]);

  return (
    <audio
      ref={el}
      playsInline
      preload="auto"
      muted={!audible}
      onError={() => setBroken(true)}
      style={{ display: 'none' }}
    />
  );
}

function Layer({
  spec, z, clock, playing, position, rate,
}: {
  spec: LayerSpec;
  z: number;
  clock: PlayheadController;
  playing: boolean;
  position: number;
  rate: Rate;
}) {
  const el = useRef<HTMLVideoElement | null>(null);
  const [broken, setBroken] = useState(false);
  const style = layerStyle(spec.params, spec.blendMode, z);

  const fps = rateFps(rate);
  const specRef = useRef(spec);
  specRef.current = spec;
  const { proxyKey, clipStart, sourceStart } = spec;
  const playable = !!proxyKey && !broken;

  // the source, set once per file. Primitives in the deps, so crossing a cut
  // reloads the element and moving the playhead inside a clip does not.
  useEffect(() => {
    setBroken(false);
    const v = el.current;
    if (!v || !proxyKey) return;
    const src = `/api/media/stream?key=${encodeURIComponent(proxyKey)}`;
    if (v.getAttribute('src') !== src) {
      v.setAttribute('src', src);
      v.load();
    }
  }, [proxyKey]);

  // parked: sit exactly on the frame the playhead is on
  useEffect(() => {
    const v = el.current;
    if (!v || !playable || playing) return;
    const want = (sourceStart + Math.max(0, position - clipStart)) / fps;
    if (Math.abs(v.currentTime - want) > 0.02) v.currentTime = want;
    if (!v.paused) v.pause();
  }, [playable, playing, position, clipStart, sourceStart, fps]);

  // playing: start once, then correct only real drift. The clock is master,
  // so every layer follows the same time and they cannot separate.
  useEffect(() => {
    const v = el.current;
    if (!v || !playable) return;
    if (!playing) { v.pause(); return; }

    const want = () => (sourceStart + Math.max(0, clock.get() - clipStart)) / fps;
    v.currentTime = want();
    // a refused play is not a broken file: the next press carries the gesture
    void v.play().catch(() => { /* the press that follows will start it */ });

    const drift = 2 / fps;
    let raf = 0;
    const follow = () => {
      const cur = clock.get();
      const dur = specRef.current.clipDuration ?? Infinity;
      const start = specRef.current.clipStart;
      if (cur < start || cur >= start + dur) {
        if (v.style.visibility !== 'hidden') v.style.visibility = 'hidden';
        if (!v.paused) v.pause();
      } else {
        if (v.style.visibility !== 'visible') v.style.visibility = 'visible';
        const target = want();
        if (Math.abs(v.currentTime - target) > drift) v.currentTime = target;
        if (v.paused) void v.play().catch(() => {});
      }
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return () => { cancelAnimationFrame(raf); v.pause(); };
  }, [playable, playing, clock, clipStart, sourceStart, fps]);

  if (!playable) {
    // no stream, so the nearest extracted frame, which composites the same way
    if (!spec.frameKey) return null;
    return (
      <img
        alt=""
        style={style}
        src={`/api/media/frame?key=${encodeURIComponent(spec.frameKey)}`}
      />
    );
  }

  return (
    <video
      ref={el}
      playsInline
      preload="auto"
      muted={layerMuted({ z, trackAudible: spec.audible, soundOnAudioTracks: spec.soundOnAudioTracks })}
      aria-label={z === 0 ? 'Program output' : `${spec.label}, layer ${z + 1}`}
      style={style}
      onError={() => setBroken(true)}
    />
  );
}
