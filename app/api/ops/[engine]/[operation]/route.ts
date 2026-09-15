import { NextResponse } from 'next/server';
import { getNode, validateParams } from '@/lib/editor-api/catalogue.ts';

/**
 * Run one operation.
 *
 * The params are checked against the node's own schema before the request
 * leaves this machine. That check is free and the alternative is a round trip
 * to be told the same thing, so the only reason not to do it is not having
 * the schema, and we have all 116 of them committed.
 *
 * A job id comes back, not a result: an operation is asynchronous and pretending
 * otherwise would mean holding a request open for the length of a transcode.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ engine: string; operation: string }> },
) {
  const { engine, operation } = await params;
  const key = `${engine}/${operation}`;

  const node = getNode(key);
  if (!node) {
    return NextResponse.json({ error: `no such operation "${key}"` }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const problems = validateParams(key, body);
  if (problems.length) {
    return NextResponse.json(
      { error: `${key} params are wrong`, problems, source: 'local' },
      { status: 400 },
    );
  }

  const base = process.env.EDITOR_API_URL?.replace(/\/+$/, '');
  const apiKey = process.env.EDITOR_API_KEY;
  if (!base || !apiKey) {
    return NextResponse.json({ error: 'the editor API is not configured' }, { status: 500 });
  }

  const res = await fetch(`${base}/v1/${engine}/${operation}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const out = await res.json().catch(() => ({}));
  return NextResponse.json(out, { status: res.status });
}
