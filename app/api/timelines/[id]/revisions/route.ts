import { NextResponse } from 'next/server';
import { listRevisions, EditorApiError } from '@/lib/editor-api/client.ts';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const revisions = await listRevisions(id);
    return NextResponse.json({ revisions });
  } catch (e) {
    if (e instanceof EditorApiError) {
      return NextResponse.json({ error: e.message, status: e.status }, { status: e.status || 502 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

