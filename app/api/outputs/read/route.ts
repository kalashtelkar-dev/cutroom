import { NextResponse } from 'next/server';
import { signOutputs, EditorApiError } from '@/lib/editor-api/client.ts';

/**
 * Read one text file a run produced.
 *
 * Returns the bytes as text and parses nothing: a caller wanting JSON parses
 * it, a caller wanting SRT parses that. Named `read` rather than `json`
 * because it was the second caller, the subtitle placer, that made the
 * original name a lie.
 *
 * Signing happens here so the key never leaves the server, exactly like
 * `/api/media/frame`. The browser asks for a key and gets the text back; it
 * never holds a signed url and never holds the API key.
 *
 * Bounded on purpose. A transcript is tens of kilobytes; anything in the
 * megabytes is not something a plan should be pulling through the browser to
 * make a decision with, and saying so beats hanging the run.
 */
export const dynamic = 'force-dynamic';

const MAX_BYTES = 4 * 1024 * 1024;

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'a key is required' }, { status: 400 });
  if (key.startsWith('input/')) {
    // the same rule the rest of the app lives by: nothing signs an upload key
    return NextResponse.json(
      { error: 'an upload key cannot be signed; read the output an operation made from it' },
      { status: 400 },
    );
  }

  try {
    const signed = await signOutputs([key]);
    const url = (signed.urls ?? {})[key];
    if (!url) return NextResponse.json({ error: `no signed url came back for ${key}` }, { status: 502 });

    const res = await fetch(url);
    if (!res.ok) {
      return NextResponse.json({ error: `could not fetch ${key}: ${res.status}` }, { status: 502 });
    }

    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES) {
      return NextResponse.json(
        { error: `${key} is ${Math.round(length / 1024)}kB, past the ${MAX_BYTES / 1024 / 1024}MB a plan may read` },
        { status: 413 },
      );
    }

    const text = await res.text();
    if (text.length > MAX_BYTES) {
      return NextResponse.json({ error: `${key} is larger than a plan may read` }, { status: 413 });
    }
    return NextResponse.json({ key, text });
  } catch (e) {
    if (e instanceof EditorApiError) {
      return NextResponse.json({ error: e.message, status: e.status }, { status: e.status || 500 });
    }
    return NextResponse.json({ error: (e as Error).message || String(e) }, { status: 500 });
  }
}
