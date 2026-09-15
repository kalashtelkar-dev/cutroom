/**
 * Inspector values to clip effects, and back.
 *
 * The inspector's groups are not all renderable, and pretending otherwise
 * would be the same mistake as a menu bar over an app that could not import:
 * a control that does something visible in the viewer and nothing in the file
 * is worse than one that is honestly marked.
 *
 * What the editor API can actually do to one clip:
 *
 *   Cropping  ffmpeg/crop    width/height/x/y in PIXELS, so it needs to know
 *                            how big the source is
 *   Speed     ffmpeg/speed   factor, where 2 is twice as fast
 *   Rotation  ffmpeg/rotate  degrees, and it takes them as a STRING
 *   Gain      ffmpeg/volume  gainDb
 *
 * What it cannot, because no operation exists:
 *
 *   Pan                            no stereo placement node
 *
 * Opacity, blend modes, Zoom and Position were all on that second list and
 * none of them belonged there. No single operation does any of them, which is
 * what was checked, but `ffmpeg/custom` takes two wired inputs and ffmpeg's
 * own filters do all four: `blend` for the modes, `scale` and `overlay` for
 * the placement. Checking the operation list and concluding the API could not
 * do it was the mistake, twice.
 *
 * Zoom and Position are carried as `cutroom/transform` and read by the
 * compiler when it lays the track's picture into the frame, so the render
 * matches what the viewer paints. See `placement` in lib/compiler/compile.ts,
 * which mirrors `layerStyle` in components/viewer/Layers.tsx on purpose.
 *
 * What is left still drives the viewer, which is a preview of an intent, and
 * `unrenderable()` names it so the interface can say so out loud.
 */
import type { Effect, Clip, MediaRef } from '../timeline/types.ts';
import { DEFAULT_CLIP_PARAMS, type ClipParams } from '../../components/inspector/types.ts';

/**
 * How this clip sits over the one below it.
 *
 * Not an operation key, because no single operation does this: the composite
 * is built at render time from `ffmpeg/custom` and ffmpeg's `blend` filter,
 * which needs both layers at once and therefore cannot be a step in one
 * clip's own chain. The compiler reads this marker when it stacks the tracks.
 */
export const COMPOSITE_EFFECT = 'cutroom/composite';
export const TRANSFORM_EFFECT = 'cutroom/transform';
export const AUDIO_PAN_EFFECT = 'cutroom/pan';

/** The inspector's blend list, in the order the picker shows it. */
export const BLEND_FILTERS = ['normal', 'addition', 'overlay', 'screen', 'multiply'] as const;

/** Kinds this module owns. Anything else on a clip is left alone. */
const OURS = new Set([
  'ffmpeg/crop', 'ffmpeg/speed', 'ffmpeg/rotate', 'ffmpeg/volume',
  COMPOSITE_EFFECT, TRANSFORM_EFFECT, AUDIO_PAN_EFFECT,
]);

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

/**
 * Which inspector values the renderer cannot honour, given what is set.
 *
 * Only ones actually changed from their default are named: a warning about
 * Zoom on a clip nobody zoomed is noise, and noise is how a real warning
 * gets ignored.
 */
export function unrenderable(p: ClipParams): string[] {
  const out: string[] = [];
  if (p.audioOn && !near(p.pan, DEFAULT_CLIP_PARAMS.pan)) out.push('Pan');
  return out;
}

/**
 * The effects a clip should carry for these values.
 *
 * Effects this module does not own are kept in place, so one put there by the
 * assistant is not quietly dropped by someone nudging a slider. A value left
 * at its default emits nothing: an identity crop is a whole re-encode for no
 * change.
 */
export function paramsToEffects(
  params: ClipParams,
  existing: readonly Effect[],
  media?: MediaRef | null,
): { effects: Effect[]; skipped: string[] } {
  const kept = existing.filter((e) => !OURS.has(e.kind));
  const made: Effect[] = [];
  const skipped: string[] = [];

  const anyCrop = params.cropL > 0 || params.cropR > 0 || params.cropT > 0 || params.cropB > 0;
  if (params.cropOn && anyCrop) {
    const w = media?.width;
    const h = media?.height;
    if (!w || !h) {
      // Percentages cannot become pixels without the source size, and
      // guessing 1920x1080 would crop the wrong part of anything else.
      skipped.push('Cropping needs the source size, which the probe did not report');
    } else {
      const x = Math.round((params.cropL / 100) * w);
      const y = Math.round((params.cropT / 100) * h);
      const wide = Math.max(2, Math.round(w - x - (params.cropR / 100) * w));
      const tall = Math.max(2, Math.round(h - y - (params.cropB / 100) * h));
      made.push({
        kind: 'ffmpeg/crop',
        // even dimensions: yuv420p cannot hold an odd one, and the encoder
        // rounds it silently, which moves the frame by half a pixel
        params: { x, y, width: wide - (wide % 2), height: tall - (tall % 2) },
        enabled: true,
      });
    }
  }

  if (params.speedOn && !near(params.speed, 100)) {
    made.push({ kind: 'ffmpeg/speed', params: { factor: params.speed / 100 }, enabled: true });
  }

  const hasTransform =
    !near(params.zoom, DEFAULT_CLIP_PARAMS.zoom) ||
    !near(params.posX, DEFAULT_CLIP_PARAMS.posX) ||
    !near(params.posY, DEFAULT_CLIP_PARAMS.posY) ||
    !near(params.rotation, DEFAULT_CLIP_PARAMS.rotation);

  if (params.transformOn && hasTransform) {
    made.push({
      kind: TRANSFORM_EFFECT,
      params: {
        zoom: params.zoom,
        posX: params.posX,
        posY: params.posY,
        rotation: params.rotation,
      },
      enabled: true,
    });
  }

  if (params.transformOn && !near(params.rotation, 0)) {
    made.push({ kind: 'ffmpeg/rotate', params: { degrees: String(params.rotation) }, enabled: true });
  }

  if (params.audioOn && !near(params.gainDb, 0)) {
    made.push({ kind: 'ffmpeg/volume', params: { gainDb: params.gainDb }, enabled: true });
  }

  if (params.audioOn && !near(params.pan, DEFAULT_CLIP_PARAMS.pan)) {
    made.push({
      kind: AUDIO_PAN_EFFECT,
      params: { pan: params.pan },
      enabled: true,
    });
  }

  // How this clip sits over the one below. Only when it is not the default,
  // so an ordinary clip costs no blend pass at all.
  if (params.compositeOn
      && (!near(params.opacity, DEFAULT_CLIP_PARAMS.opacity) || params.blend !== DEFAULT_CLIP_PARAMS.blend)) {
    made.push({
      kind: COMPOSITE_EFFECT,
      params: {
        mode: BLEND_FILTERS[params.blend] ?? 'normal',
        opacity: Math.max(0, Math.min(1, params.opacity / 100)),
      },
      enabled: true,
    });
  }

  return { effects: [...kept, ...made], skipped };
}

/**
 * Read the values back off a clip.
 *
 * Without this the inspector shows defaults for a clip that carries a crop,
 * and the next slider drag writes those defaults over it. Reopening a saved
 * project is exactly that case.
 */
export function effectsToParams(clip: Clip, media?: MediaRef | null): ClipParams {
  const p: ClipParams = { ...DEFAULT_CLIP_PARAMS };
  for (const fx of clip.effects) {
    if (!fx.enabled) continue;
    const v = fx.params as Record<string, unknown>;
    if (fx.kind === 'ffmpeg/speed' && typeof v.factor === 'number') {
      p.speed = v.factor * 100;
    } else if (fx.kind === 'ffmpeg/rotate' && v.degrees !== undefined) {
      const d = Number(v.degrees);
      if (Number.isFinite(d)) p.rotation = d;
    } else if (fx.kind === 'ffmpeg/volume' && typeof v.gainDb === 'number') {
      p.gainDb = v.gainDb;
    } else if (fx.kind === COMPOSITE_EFFECT) {
      const i = BLEND_FILTERS.indexOf(String(v.mode) as typeof BLEND_FILTERS[number]);
      if (i >= 0) p.blend = i;
      if (typeof v.opacity === 'number') p.opacity = v.opacity * 100;
    } else if (fx.kind === TRANSFORM_EFFECT) {
      if (typeof v.zoom === 'number') p.zoom = v.zoom;
      if (typeof v.posX === 'number') p.posX = v.posX;
      if (typeof v.posY === 'number') p.posY = v.posY;
      if (typeof v.rotation === 'number') p.rotation = v.rotation;
    } else if (fx.kind === AUDIO_PAN_EFFECT) {
      if (typeof v.pan === 'number') p.pan = v.pan;
    } else if (fx.kind === 'ffmpeg/crop' && media?.width && media?.height) {
      const x = Number(v.x ?? 0);
      const y = Number(v.y ?? 0);
      const wide = Number(v.width ?? media.width);
      const tall = Number(v.height ?? media.height);
      p.cropL = (x / media.width) * 100;
      p.cropT = (y / media.height) * 100;
      p.cropR = ((media.width - x - wide) / media.width) * 100;
      p.cropB = ((media.height - y - tall) / media.height) * 100;
    }
  }
  return p;
}
