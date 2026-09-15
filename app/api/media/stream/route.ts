/**
 * Stream a piece of media so a `<video>` can play it.
 *
 * A `<video>` needs three things a plain proxy does not give it: byte ranges,
 * so seeking does not re-download the file; a stable URL, because a signed
 * one dies in an hour and the element would stall mid-playback; and the real
 * content type, or the browser refuses to decode it.
 *
 * The key must be an `output/` key. An upload lands under `input/` and
 * `POST /v1/outputs/sign` refuses those, so import makes a playable copy with
 * `ffmpeg/transcode` and the document carries that key as `proxy`.
 */
export const dynamic = 'force-dynamic';

/** Headers worth passing straight through, and nothing else. */
const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get('key');
  if (!key) return Response.json({ error: 'key is required' }, { status: 400 });

  const base = process.env.EDITOR_API_URL?.replace(/\/+$/, '');
  const apiKey = process.env.EDITOR_API_KEY;
  if (!base || !apiKey) {
    return Response.json({ error: 'the editor API is not configured' }, { status: 500 });
  }

  try {
    const signRes = await fetch(`${base}/v1/outputs/sign`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [key] }),
      cache: 'no-store',
    });
    const signed = (await signRes.json().catch(() => ({}))) as { urls?: Record<string, string> };
    const url = signed.urls?.[key];
    if (!url) {
      const why = key.startsWith('input/')
        ? `"${key}" is an upload key and cannot be signed. Playable media is the "proxy" key, not the original.`
        : `could not sign "${key}"`;
      return Response.json({ error: why }, { status: 404 });
    }

    // The Range header is the whole point: without forwarding it the browser
    // downloads the file from the start for every seek, and a scrub through a
    // long clip re-fetches it over and over.
    const range = request.headers.get('range');
    const upstream = await fetch(url, {
      headers: range ? { Range: range } : {},
      cache: 'no-store',
    });

    if (!upstream.ok && upstream.status !== 206) {
      return Response.json({ error: `storage answered ${upstream.status}` }, { status: 502 });
    }

    const headers = new Headers();
    for (const h of PASS) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    // say so even when storage does not, or the element will not try to seek
    if (!headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes');
    headers.set('Cache-Control', 'private, max-age=3600');

    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
