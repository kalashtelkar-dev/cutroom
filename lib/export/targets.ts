/**
 * Where the file is going, in the words of the person sending it.
 *
 * The export dialog used to ask for a width, a height, a container, a video
 * bitrate and an audio bitrate, which is five questions nobody outside this
 * repo can answer and which between them cannot express "this is a reel".
 * 1080x1920 is not a thing anyone wants; an Instagram Reel is, and it happens
 * to be 1080x1920.
 *
 * So the list is destinations, and the numbers are derived from them. Every
 * one of these is still reachable by hand under Advanced, because a preset
 * that cannot be overridden is a wall rather than a shortcut.
 *
 * Nothing here talks to anything. It is a table and three functions, so the
 * dialog can be read, and tested, without a browser.
 */

/** What the frame looks like, which is the part that decides anything. */
export type Shape = 'landscape' | 'vertical' | 'square';

export interface ExportTarget {
  id: string;
  /** What a person calls it. */
  name: string;
  /** One line, in the same register: what it is for, not what it is. */
  note: string;
  width: number;
  height: number;
  shape: Shape;
}

/**
 * Three of these are the same 1080x1920 and that is on purpose.
 *
 * A reel, a story and a short are one frame size and three different things
 * to the person exporting, and asking them to know that the numbers coincide
 * is asking them to know the numbers. The duplication costs a line in a table
 * and saves the only question this dialog is trying not to ask.
 */
export const TARGETS: readonly ExportTarget[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    note: 'Landscape, the usual 1080p',
    width: 1920, height: 1080, shape: 'landscape',
  },
  {
    id: 'youtube-shorts',
    name: 'YouTube Shorts',
    note: 'Vertical, full screen on a phone',
    width: 1080, height: 1920, shape: 'vertical',
  },
  {
    id: 'instagram-reel',
    name: 'Instagram Reel or Story',
    note: 'Vertical, full screen on a phone',
    width: 1080, height: 1920, shape: 'vertical',
  },
  {
    id: 'instagram-post',
    name: 'Instagram Post',
    note: 'Square, for the grid',
    width: 1080, height: 1080, shape: 'square',
  },
  {
    id: 'facebook-reel',
    name: 'Facebook Reel or Story',
    note: 'Vertical, full screen on a phone',
    width: 1080, height: 1920, shape: 'vertical',
  },
  {
    id: 'facebook-feed',
    name: 'Facebook Feed',
    note: 'Upright, taller than it is wide',
    width: 1080, height: 1350, shape: 'vertical',
  },
];

export type QualityId = 'high' | 'standard' | 'small';

export interface Quality {
  id: QualityId;
  name: string;
  note: string;
}

export const QUALITIES: readonly Quality[] = [
  { id: 'high', name: 'Best', note: 'Biggest file' },
  { id: 'standard', name: 'Standard', note: 'What most people want' },
  { id: 'small', name: 'Smallest', note: 'Quickest to upload' },
];

/**
 * A bitrate for a frame of this size at this quality.
 *
 * Bitrate is a budget for a number of pixels, so it scales with the frame and
 * not with the name on the card: 20M is generous at 1080p and thin at 2160p,
 * and one table of three numbers would be wrong at one end or the other.
 * Every value here is one the Advanced menu also offers, so switching to it
 * shows the number that is actually set rather than an empty box.
 */
export function videoBitrateFor(height: number, quality: QualityId): string {
  const bands: { from: number; rates: Record<QualityId, string> }[] = [
    { from: 2160, rates: { high: '40M', standard: '20M', small: '12M' } },
    { from: 1080, rates: { high: '20M', standard: '8M', small: '5M' } },
    { from: 0, rates: { high: '12M', standard: '5M', small: '2M' } },
  ];
  return (bands.find((b) => height >= b.from) ?? bands[bands.length - 1]).rates[quality];
}

/** The card a width and a height came from, or null if they were typed in. */
export function targetFor(width: number, height: number): ExportTarget | null {
  return TARGETS.find((t) => t.width === width && t.height === height) ?? null;
}

/** 16:9, 9:16, 1:1: the shape, in the form people say it out loud. */
export function aspectLabel(width: number, height: number): string {
  const d = gcd(width, height);
  return `${width / d}:${height / d}`;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Near enough the same shape that no fitting decision has to be made. */
export const SAME_SHAPE = 0.002;

export interface FitAdvice {
  /** The footage's shape, said the way the target's is said. */
  source: string;
  target: string;
  /** What `contain` will do to it, in a sentence. */
  contain: string;
  /** What `cover` will do to it. */
  cover: string;
}

/**
 * What the two fits will actually do to THIS footage in THIS frame.
 *
 * Null when the shapes agree, because then they do the same thing and a
 * choice between two identical outcomes is a question with no answer. Null
 * also when the footage never reported a size: saying "black bars" to someone
 * whose clip might already be vertical is worse than saying nothing.
 */
export function fitAdvice(
  source: { width?: number; height?: number } | null,
  target: { width: number; height: number },
): FitAdvice | null {
  if (!source?.width || !source.height) return null;
  const from = source.width / source.height;
  const to = target.width / target.height;
  if (Math.abs(from - to) <= SAME_SHAPE) return null;
  const wider = from > to;
  return {
    source: aspectLabel(source.width, source.height),
    target: aspectLabel(target.width, target.height),
    contain: wider
      ? 'The whole picture, with black bars above and below it.'
      : 'The whole picture, with black bars either side of it.',
    cover: wider
      ? 'Fills the frame. The left and right edges are cut off.'
      : 'Fills the frame. The top and bottom are cut off.',
  };
}
