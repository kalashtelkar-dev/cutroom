import { NextResponse } from 'next/server';

/**
 * A single operation's job.
 *
 * Note the path: an operation is a JOB at /v1/jobs/{id}, a published pipeline
 * is a RUN at /v1/runs/{id}. They are different resources with different ids,
 * and asking the wrong one answers 404 rather than saying which you meant.
 *
 * Output links are presigned when the job is read, so they never outlive their
 * own expiry. That means a stale poll response holds a dead URL: re-read
 * rather than caching what came back.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const base = process.env.EDITOR_API_URL?.replace(/\/+$/, '');
  const apiKey = process.env.EDITOR_API_KEY;
  if (!base || !apiKey) {
    return NextResponse.json({ error: 'the editor API is not configured' }, { status: 500 });
  }

  const res = await fetch(`${base}/v1/jobs/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: 'no-store',
  });
  const body = await res.json().catch(() => ({}));
  return NextResponse.json(body, { status: res.status });
}
