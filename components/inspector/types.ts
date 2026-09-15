/**
 * The inspector's values, apart from React.
 *
 * In their own file because `lib/inspector/effects.ts` turns them into clip
 * effects and must not drag a component, and therefore React, into the
 * compiler's dependencies or into `node --test`.
 */

export interface ClipParams {
  transformOn: boolean;
  zoom: number;
  posX: number;
  posY: number;
  rotation: number;

  cropOn: boolean;
  cropL: number;
  cropR: number;
  cropT: number;
  cropB: number;

  compositeOn: boolean;
  /** Index into BLEND_MODES. */
  blend: number;
  opacity: number;

  speedOn: boolean;
  /** Per cent of normal. 200 is twice as fast, so half as long. */
  speed: number;

  audioOn: boolean;
  gainDb: number;
  /** −1 hard left, +1 hard right. */
  pan: number;
}

export const BLEND_MODES = ['Normal', 'Add', 'Overlay', 'Screen', 'Multiply'] as const;

export const DEFAULT_CLIP_PARAMS: ClipParams = {
  transformOn: true, zoom: 1, posX: 0, posY: 0, rotation: 0,
  cropOn: true, cropL: 0, cropR: 0, cropT: 0, cropB: 0,
  compositeOn: true, blend: 0, opacity: 100,
  speedOn: true, speed: 100,
  audioOn: true, gainDb: 0, pan: 0,
};
