import { NextResponse } from 'next/server';

/**
 * Serve one extracted frame.
 *
 * Frames live in the bucket and their URLs are presigned for an hour, so a
 * URL baked into the document goes dead while someone is still editing. This
 * route signs on demand and serves the bytes, which means an `<img src>`
 * keeps working for the length of a session without the document holding
 * anything that expires.
 *
 * Only `output/` keys can be signed. A file straight from `POST /v1/uploads`
 * lands under `input/`, and `POST /v1/outputs/sign` answers "no asset was
 * recorded for every key given" for those. There is no endpoint that signs an
 * upload key, so anything meant to be SHOWN has to be passed through an
 * operation first: `ffmpeg/thumbnail` for video, `imagemagick/resize` for a
 * still.
 */
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 });

  const base = process.env.EDITOR_API_URL?.replace(/\/+$/, '');
  const apiKey = process.env.EDITOR_API_KEY;
  if (!base || !apiKey) {
    return NextResponse.json({ error: 'the editor API is not configured' }, { status: 500 });
  }

  try {
    const res = await fetch(`${base}/v1/outputs/sign`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [key] }),
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => ({}))) as { urls?: Record<string, string> };
    const url = body.urls?.[key];
    if (!url) {
      // The commonest cause by far, and it used to answer a bare "could not
      // sign" that said nothing about why: only keys under `output/` are
      // signable. A file straight from `POST /v1/uploads` lands under
      // `input/` and no endpoint anywhere will sign one, so it has to be
      // passed through an operation first.
      const why = key.startsWith('input/')
        ? `"${key}" is an upload key. Only output/ keys can be signed, so this media needs its frames extracting again.`
        : `could not sign "${key}"`;
      return NextResponse.json({ error: why }, { status: 404 });
    }

    // Fetch and return the bytes rather than redirecting: a redirect to a
    // signed URL leaks the signature into the browser's history and network
    // log, and the image is a few kilobytes.
    const img = await fetch(url, { cache: 'no-store' });
    if (!img.ok) return NextResponse.json({ error: `frame fetch failed: ${img.status}` }, { status: 502 });

    return new NextResponse(img.body, {
      headers: {
        'Content-Type': img.headers.get('content-type') ?? 'image/jpeg',
        // the bytes behind a key never change, so this is safe to hold
        'Cache-Control': 'private, max-age=3600, immutable',
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
