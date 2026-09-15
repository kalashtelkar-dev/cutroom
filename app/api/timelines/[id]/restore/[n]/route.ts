import { NextResponse } from 'next/server';
import { restoreRevision, EditorApiError } from '@/lib/editor-api/client.ts';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; n: string }> },
) {
  const { id, n } = await params;
  const revNum = parseInt(n, 10);
  if (Number.isNaN(revNum) || revNum < 0) {
    return NextResponse.json({ error: 'valid revision number is required' }, { status: 400 });
  }

  try {
    const result = await restoreRevision(id, revNum);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    if (e instanceof EditorApiError) {
      return NextResponse.json({ error: e.message, status: e.status }, { status: e.status || 502 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

