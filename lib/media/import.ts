/**
 * Bringing a file in.
 *
 * Four steps, each one logged, because when an import fails the useful
 * question is which of them failed:
 *
 *   1. ask our server for a presigned PUT
 *   2. send the bytes straight to storage, never through our server
 *   3. probe the uploaded object, so the pool knows a real duration
 *   4. put the result in the media pool as an edit, so it is undoable
 *
 * Step 2 is the reason for step 1. The editor API's own rule is that it never
 * proxies media bytes, and it is right: a 4GB master has no business
 * travelling through a route handler to be buffered and counted against a
 * body limit for no gain.
 */
import type { JobHandle } from '../jobs/types.ts';
import type { EditOp, MediaRef } from '../timeline/types.ts';
import { secondsToFrames, timeRange, type Rate } from '../time/frames.ts';

export interface ImportedMedia {
  media: MediaRef;
  op: EditOp;
  /** What the probe actually said, for the log. */
  probe: { seconds: number; width?: number; height?: number; codec?: string };
}

const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mpg', 'mpeg', 'mts', 'm2ts'];
const AUDIO_EXT = ['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a', 'aiff', 'aif', 'opus'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff', 'bmp', 'avif', 'heic'];

/** What kind of thing this is, from the type if the browser gave one. */
export function mediaKind(contentType: string, filename: string): MediaRef['kind'] {
  const t = (contentType || '').toLowerCase();
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('image/')) return 'image';
  // Browsers hand over an empty type often enough that the extension is a
  // real fallback rather than a formality.
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (IMAGE_EXT.includes(ext)) return 'image';
  return 'video';
}

/**
 * How long to wait for a playable copy, for media this long.
 *
 * This was a flat 180 seconds, which is not a property of the media but of
 * nothing at all, and a ten minute import found the hole in it: the transcode
 * ran for 203.8s and then 208.9s on two attempts, succeeded both times, and
 * both times this side had already given up. The proxy was sitting in storage,
 * a hundred megabytes of playable mp4, while the clip went into the pool
 * unable to play. Pressing play then moves the clock and nothing else, because
 * with no proxy the viewer has only the eight extracted stills to show, which
 * over ten minutes is a new picture every seventy five seconds.
 *
 * So the wait is a function of what is being waited for. Those two runs put
 * the encoder at about three times real time on the cpu tier, and a second of
 * budget per second of media is therefore roughly three times what it needs,
 * which is the right kind of margin for a queue that is shared.
 *
 * The floor keeps the old behaviour for short files. The ceiling is where
 * waiting stops being reasonable: at the measured rate it still covers about
 * three quarters of an hour of source, and past that the honest answer is the
 * one the caller gives, that the clip cuts but will not play.
 */
export function proxyBudgetMs(seconds: number): number {
  const wanted = 90_000 + 1000 * Math.max(0, seconds);
  return Math.min(900_000, Math.max(180_000, wanted));
}

/**
 * Dig the duration out of an ffprobe result.
 *
 * It can live on the format or on a stream, and a container that reports
 * neither is a real thing (a raw image, a stream still being written), so the
 * caller gets null rather than a plausible zero.
 */
export function probeSeconds(probe: unknown): number | null {
  const seen: number[] = [];
  const walk = (v: unknown, key?: string) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x)); return; }
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, k);
      return;
    }
    if (key === 'duration') {
      const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
      if (Number.isFinite(n) && n > 0) seen.push(n);
    }
  };
  walk(probe);
  // the longest stream is the one that decides how long the file is
  return seen.length ? Math.max(...seen) : null;
}

export function probeDimensions(probe: unknown): { width?: number; height?: number; codec?: string } {
  const out: { width?: number; height?: number; codec?: string } = {};
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const o = v as Record<string, unknown>;
    if (typeof o.width === 'number' && typeof o.height === 'number' && !out.width) {
      out.width = o.width; out.height = o.height;
      if (typeof o.codec_name === 'string') out.codec = o.codec_name;
    }
    Object.values(o).forEach(walk);
  };
  walk(probe);
  return out;
}

/** A still has no duration of its own, so it gets one we can cut against. */
export const STILL_SECONDS = 5;

export interface ImportTransport {
  presign(filename: string): Promise<{ url: string; key: string }>;
  /** Evenly spaced stills, so the pool and the timeline show real pictures. */
  /**
   * `kind` decides which operation reads the file: an image cannot go through
   * `ffmpeg/thumbnail`, which takes `file:video` and nothing else.
   */
  thumbnails?(key: string, count: number, kind: MediaRef['kind']): Promise<string[]>;
  /**
   * A copy that a browser can actually play, as an `output/` key.
   *
   * Optional because everything else about an import works without it: no
   * proxy means no smooth playback and no sound, not a failed import.
   */
  proxy?(key: string, kind: MediaRef['kind'], seconds: number): Promise<string>;
  /**
   * How big a picture is, read from the file itself.
   *
   * An image never goes through `probe`, because it has no duration to ask
   * for, so nothing used to measure one and `width`/`height` came out
   * undefined. That is not cosmetic: the compiler fits an upper track to the
   * box its own pictures occupy, and a picture with no size has to be fitted
   * to the delivery frame instead, which pads it with black bars and lays
   * them over the track below. The browser already holds the bytes, so this
   * is exact and costs nothing.
   *
   * Optional, and allowed to answer null: a file the browser cannot decode is
   * still importable and still cuts.
   */
  measure?(file: File): Promise<{ width: number; height: number } | null>;
  /** Returns once the bytes are in storage. `onProgress` is 0..1. */
  put(url: string, file: File, onProgress: (p: number) => void): Promise<void>;
  probe(key: string): Promise<unknown>;
}

export async function importFile(
  file: File,
  rate: Rate,
  transport: ImportTransport,
  job: JobHandle,
): Promise<ImportedMedia> {
  const kind = mediaKind(file.type, file.name);
  job.log(`${file.name}: ${kind}, ${(file.size / 1_048_576).toFixed(1)} MB`);

  const signed = await transport.presign(file.name);
  job.log('presigned', 'debug', { key: signed.key });

  await transport.put(signed.url, file, (p) => job.progress(p * 0.8));
  job.log(`uploaded to ${signed.key}`);

  let seconds: number | null = null;
  let dims: { width?: number; height?: number; codec?: string } = {};
  if (kind === 'image') {
    seconds = STILL_SECONDS;
    job.log(`a still, so it gets ${STILL_SECONDS}s to cut against`);
    if (transport.measure) {
      try {
        const size = await transport.measure(file);
        if (size) {
          dims = { width: size.width, height: size.height };
          job.log(`measured: ${size.width}x${size.height}`);
        } else {
          job.log('the browser could not measure this picture, so it will be fitted to the delivery frame', 'warn');
        }
      } catch (e) {
        job.log(`not measured: ${(e as Error).message}`, 'warn');
      }
    }
  } else {
    const probe = await transport.probe(signed.key);
    seconds = probeSeconds(probe);
    dims = probeDimensions(probe);
    if (seconds === null) {
      // Guessing a duration here would put a clip on the timeline whose
      // length is fiction, and every cut made against it would be wrong.
      throw new Error(`${file.name} uploaded, but the probe reported no duration`);
    }
    job.log(`probed: ${seconds.toFixed(3)}s${dims.width ? `, ${dims.width}x${dims.height}` : ''}${dims.codec ? `, ${dims.codec}` : ''}`);
  }
  job.progress(1);

  /**
   * Pull real frames out.
   *
   * Best effort: a file whose frames cannot be extracted is still importable
   * and still cuts. What it must not do is fall back to a drawn picture, so a
   * failure here leaves `frames` empty and the UI shows a plain slab.
   */
  let stills: string[] = [];
  if (kind !== 'audio' && transport.thumbnails) {
    try {
      stills = await transport.thumbnails(signed.key, kind === 'image' ? 1 : 8, kind);
      job.log(`${stills.length} frame${stills.length === 1 ? '' : 's'} ready to show`);
    } catch (e) {
      job.log(`no frames: ${(e as Error).message}`, 'warn');
    }
  }

  /**
   * Something the browser can play.
   *
   * Separate from the thumbnails and allowed to fail on its own: a clip with
   * frames and no proxy still cuts, it just does not play with sound. A clip
   * with neither is still in the pool and still trims.
   */
  let proxy: string | undefined;
  if (transport.proxy) {
    try {
      proxy = await transport.proxy(signed.key, kind, seconds);
      job.log(`playable copy ready`, 'info', proxy);
    } catch (e) {
      job.log(`no playable copy: ${(e as Error).message}`, 'warn');
    }
  }

  const media: MediaRef = {
    key: signed.key,
    name: file.name,
    kind,
    ...(proxy ? { proxy } : {}),
    available: timeRange(secondsToFrames(0, rate), secondsToFrames(seconds, rate)),
    frames: stills,
    width: dims.width,
    height: dims.height,
  };

  return { media, op: { op: 'add_media', media }, probe: { seconds, ...dims } };
}

/**
 * The browser half of the transport.
 *
 * XMLHttpRequest rather than fetch for the upload, and only for the upload:
 * fetch still cannot report how far a request body has got, and an import of
 * a large master with no progress is indistinguishable from one that hung.
 */
export function browserTransport(): ImportTransport {
  return {
    async presign(filename) {
      const res = await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `could not get an upload url (${res.status})`);
      return body;
    },

    put(url, file, onProgress) {
      return new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', url, true);
        // No headers. The URL signs `host` alone, so anything else we add is
        // unsigned and MinIO answers SignatureDoesNotMatch.
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`storage refused the upload: ${xhr.status} ${xhr.statusText}`));
        };
        xhr.onerror = () => reject(new Error('the upload failed to reach storage'));
        xhr.onabort = () => reject(new Error('the upload was cancelled'));
        xhr.send(file);
      });
    },

    /**
     * Frames a browser can actually show.
     *
     * Two operations, because an uploaded file cannot be shown directly. A
     * file uploaded through `POST /v1/uploads` lands under `input/`, and
     * `POST /v1/outputs/sign` refuses those keys outright: "no asset was
     * recorded for every key given". So a still is not its own frame after
     * all, however much it looks like one. It has to be passed through an
     * operation to exist under `output/`, where it can be signed and served.
     *
     *   video   ffmpeg/thumbnail      takes file:video only
     *   still   imagemagick/resize    takes file:image, one frame out
     */
    async thumbnails(key, count, kind) {
      const [op, params] = kind === 'image'
        ? ['imagemagick/resize', { input: key, width: 320, fit: 'contain', tier: 'cpu' }]
        : ['ffmpeg/thumbnail', { input: key, count, width: 320, format: 'jpg', tier: 'cpu' }];

      const started = await fetch(`/api/ops/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const accepted = await started.json();
      if (!started.ok) throw new Error(JSON.stringify(accepted).slice(0, 160));
      const id = accepted.id ?? accepted.jobId;
      if (!id) throw new Error('no job id');

      const deadline = Date.now() + 90_000;
      for (;;) {
        const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
        const body = await res.json();
        const status = String(body.status ?? '');
        if (['succeeded', 'done', 'completed'].includes(status)) {
          /**
           * Every output IS a frame. Do not filter by role.
           *
           * `ffmpeg/thumbnail` tags all of its outputs `role: "poster"`, so a
           * filter that drops posters drops the entire result and the media
           * ends up with no preview at all. That filter is right for
           * `ffmpeg/custom`, which emits one poster beside the real file, and
           * copying it here silently emptied every video's filmstrip.
           */
          return ((body.outputs ?? []) as { key: string }[]).map((o) => o.key);
        }
        if (['failed', 'error', 'cancelled'].includes(status)) {
          throw new Error(`${op} ${status}: ${JSON.stringify(body.error ?? '').slice(0, 160)}`);
        }
        if (Date.now() > deadline) throw new Error(`${op} timed out`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    },

    /**
     * A playable copy.
     *
     * A still has nothing to play, so it gets none. Video is capped at 960
     * wide: this exists to be scrubbed, not to be delivered, and a proxy the
     * size of the original makes seeking as slow as the thing it is meant to
     * make fast.
     */
    async proxy(key, kind, seconds) {
      if (kind === 'image') throw new Error('a still has nothing to play');
      const params = kind === 'audio'
        ? { input: key, container: 'mp4', audioCodec: 'aac', audioBitrate: '128k', tier: 'cpu' }
        : {
            input: key, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac',
            width: 960, crf: 26, audioBitrate: '128k', tier: 'cpu',
          };
      const started = await fetch('/api/ops/ffmpeg/transcode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const accepted = await started.json();
      if (!started.ok) throw new Error(JSON.stringify(accepted).slice(0, 160));
      const id = accepted.id ?? accepted.jobId;
      if (!id) throw new Error('no job id');

      const budget = proxyBudgetMs(seconds);
      const deadline = Date.now() + budget;
      for (;;) {
        const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
        const body = await res.json();
        const status = String(body.status ?? '');
        if (['succeeded', 'done', 'completed'].includes(status)) {
          const outs = (body.outputs ?? []) as { key: string; role?: string }[];
          // here a poster IS a by-product: transcode emits one beside the file
          const file = outs.find((o) => o.role !== 'poster') ?? outs[0];
          if (!file) throw new Error('the transcode returned no file');
          return file.key;
        }
        if (['failed', 'error', 'cancelled'].includes(status)) {
          throw new Error(`transcode ${status}: ${JSON.stringify(body.error ?? '').slice(0, 160)}`);
        }
        if (Date.now() > deadline) {
          // not "timed out": the job is still running and will very likely
          // finish. What ended is this wait, and the clip is about to be put
          // in the pool unable to play, so say that and not something vaguer
          throw new Error(
            `the playable copy was still being made after ${Math.round(budget / 1000)}s, `
            + 'so this clip cuts but will not play or carry sound until it is imported again',
          );
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
    },

    async measure(file) {
      /**
       * `createImageBitmap` and not an `Image` with a data URL: it decodes the
       * bytes we already have, reports the intrinsic size, and is the same
       * number for a file the tag would refuse to lay out.
       */
      if (typeof createImageBitmap !== 'function') return null;
      const bitmap = await createImageBitmap(file);
      try {
        return bitmap.width > 0 && bitmap.height > 0
          ? { width: bitmap.width, height: bitmap.height }
          : null;
      } finally {
        bitmap.close();
      }
    },

    async probe(key) {
      const started = await fetch('/api/ops/ffmpeg/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: key, tier: 'cpu' }),
      });
      const accepted = await started.json();
      if (!started.ok) throw new Error(`probe refused: ${JSON.stringify(accepted).slice(0, 200)}`);
      const id = accepted.id ?? accepted.jobId;
      if (!id) throw new Error('the probe returned no job id');

      const deadline = Date.now() + 120_000;
      for (;;) {
        const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
        const body = await res.json();
        const status = String(body.status ?? '');
        if (['succeeded', 'done', 'completed'].includes(status)) return body;
        if (['failed', 'error', 'cancelled'].includes(status)) {
          throw new Error(`the probe ${status}: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
        }
        if (Date.now() > deadline) throw new Error('the probe did not finish within two minutes');
        await new Promise((r) => setTimeout(r, 1200));
      }
    },
  };
}
