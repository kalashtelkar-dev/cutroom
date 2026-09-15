/**
 * Getting media in.
 *
 * Two routes exist and they are for different sizes of file. `/v1/uploads`
 * returns a presigned PUT so the browser talks to storage directly, which is
 * what anything above a few megabytes should do. `/v1/uploads/direct` streams
 * through the API, which is simpler but puts every byte through a hop that
 * gains nothing.
 *
 * We use the presigned route. The direct one is here because a server-side
 * import (a file already on this machine, a fixture, a test) has no browser
 * to do the PUT, and reaching for fetch-with-a-stream twice is worse than
 * naming it once.
 */
import type { MediaRef } from '../timeline/types.ts';

export interface PresignedUpload {
  /** PUT the bytes here, with no extra headers. Expires in an hour. */
  url: string;
  /** What to pass as `input` to any operation afterwards. */
  key: string;
  expiresAt?: string;
}

function config() {
  const base = process.env.EDITOR_API_URL?.replace(/\/+$/, '');
  const key = process.env.EDITOR_API_KEY;
  if (!base || !key) throw new Error('EDITOR_API_URL and EDITOR_API_KEY must be set');
  return { base, key };
}

/**
 * `filename` and nothing else.
 *
 * The endpoint rejects any other key outright, including `contentType`, which
 * is the obvious thing to send and is wrong. It derives the type from the
 * extension and picks the object key itself.
 *
 * The returned URL signs only `host` (X-Amz-SignedHeaders=host), so the PUT
 * must not add headers of its own. A Content-Type on the way up is the
 * classic way to turn a valid presigned URL into a signature mismatch.
 */
export async function presignUpload(filename: string): Promise<PresignedUpload> {
  const { base, key } = config();
  const res = await fetch(`${base}/v1/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = body.error as { message?: string; issues?: unknown[] } | undefined;
    const detail = err?.issues ? ` (${JSON.stringify(err.issues)})` : '';
    throw new Error(`${err?.message ?? `POST /v1/uploads failed: ${res.status}`}${detail}`);
  }
  const url = body.url as string | undefined;
  const objectKey = body.key as string | undefined;
  if (!url || !objectKey) {
    throw new Error(`/v1/uploads answered without a url and key: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return { url, key: objectKey, expiresAt: body.expiresAt as string | undefined };
}

/** For an import with no browser in it. Streams, so size is storage-bound. */
export async function uploadDirect(filename: string, bytes: BodyInit): Promise<{ key: string; bytes: number }> {
  const { base, key } = config();
  const res = await fetch(`${base}/v1/uploads/direct?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: bytes,
    // @ts-expect-error duplex is required by fetch for a stream body and is
    // not yet in the DOM lib types Next ships.
    duplex: 'half',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`direct upload failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { key: string; bytes: number };
  return body;
}

/** The media kinds the timeline understands, from what the browser tells us. */
export function mediaKind(contentType: string, filename: string): MediaRef['kind'] {
  const type = contentType.toLowerCase();
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('image/')) return 'image';
  // A browser hands over an empty type often enough that the extension has to
  // be a real fallback rather than a formality.
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mpg', 'mpeg'].includes(ext)) return 'video';
  if (['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a', 'aiff', 'aif'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff', 'bmp', 'avif'].includes(ext)) return 'image';
  return 'video';
}
