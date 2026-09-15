import { NextResponse } from 'next/server';

const api = () => {
  const base = process.env.EDITOR_API_URL?.replace(/\/+$/, '');
  const key = process.env.EDITOR_API_KEY;
  if (!base || !key) throw new Error('the editor API is not configured');
  return { base, key };
};

/** Projects, newest first. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get('q');
  try {
    const { base, key } = api();
    const res = await fetch(`${base}/v1/timelines?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: 'no-store',
    });
    return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Make a home for a project.
 *
 * `name` is the only thing it takes, and it is required. The document goes up
 * afterwards with a PUT, which needs the etag this returns.
 */
export async function POST(request: Request) {
  let body: { name?: string };
  try { body = await request.json(); } catch { body = {}; }
  const name = body.name?.trim() || 'Untitled';

  try {
    const { base, key } = api();
    const res = await fetch(`${base}/v1/timelines`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      cache: 'no-store',
    });
    const created = await res.json().catch(() => ({}));
    return NextResponse.json(created, { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
