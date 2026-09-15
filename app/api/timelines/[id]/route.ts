import { NextResponse } from 'next/server';
import { getTimeline, getTimelineMedia, EditorApiError } from '@/lib/editor-api/client.ts';

/**
 * Read a timeline.
 *
 * `?doc=false` returns the summary; the default returns the literal OTIO
 * document, because that is what the editor actually needs. `?media=true`
 * also asks whether every reference still resolves, worth knowing before
 * compiling a render that would fail halfway through.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const wantDoc = url.searchParams.get('doc') !== 'false';
  const wantMedia = url.searchParams.get('media') === 'true';

  try {
    const [doc, media] = await Promise.all([
      getTimeline(id, wantDoc),
      wantMedia ? getTimelineMedia(id) : Promise.resolve(null),
    ]);
    return NextResponse.json({ timeline: doc, media });
  } catch (e) {
    if (e instanceof EditorApiError) {
      return NextResponse.json({ error: e.message, status: e.status }, { status: e.status || 502 });
    }
    throw e;
  }
}

/**
 * Write the document back.
 *
 * `If-Match` is required: without it the server answers 428, and that is the
 * right behaviour rather than an inconvenience. A 412 means someone else
 * moved first, so the honest answer is to reopen and reapply, never to retry
 * with a fresh etag, which would be overwriting their work on purpose.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { etag?: string; name?: string; otio?: unknown };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }
  if (!body.etag) {
    return NextResponse.json(
      { error: 'etag is required: open the project first, then save it back' },
      { status: 428 },
    );
  }

  const base = process.env.EDITOR_API_URL?.replace(/\/+$/, '');
  const key = process.env.EDITOR_API_KEY;
  if (!base || !key) {
    return NextResponse.json({ error: 'the editor API is not configured' }, { status: 500 });
  }

  try {
    const res = await fetch(`${base}/v1/timelines/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'If-Match': body.etag,
      },
      body: JSON.stringify({ ...(body.name ? { name: body.name } : {}), otio: body.otio }),
      cache: 'no-store',
    });
    const out = await res.json().catch(() => ({}));
    if (res.status === 412) {
      return NextResponse.json(
        { error: 'the project changed since you opened it; reopen and reapply', stale: true },
        { status: 412 },
      );
    }
    return NextResponse.json(out, { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

/**
 * Delete a timeline from the server.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const base = process.env.EDITOR_API_URL?.replace(/\/+$/, '');
  const key = process.env.EDITOR_API_KEY;
  if (!base || !key) {
    return NextResponse.json({ error: 'the editor API is not configured' }, { status: 500 });
  }

  try {
    const res = await fetch(`${base}/v1/timelines/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${key}`,
      },
      cache: 'no-store',
    });
    if (!res.ok && res.status !== 404) {
      const body = await res.json().catch(() => ({}));
      return NextResponse.json(body, { status: res.status });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

