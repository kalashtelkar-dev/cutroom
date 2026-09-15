import { NextResponse } from 'next/server';
import { cancelRun, EditorApiError } from '@/lib/editor-api/client.ts';

/**
 * Stop a run.
 *
 * The executor's browser transport calls this on cancel and swallows what it
 * answers, so the route's job is to exist: without it the call went to a
 * route that was not there, a run kept burning GPU after the user pressed
 * stop, and nothing said so.
 *
 * Upstream this is DELETE on the run itself. See `cancelRun`.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const runId = id.trim();
  if (!runId) return NextResponse.json({ error: 'a run id is required' }, { status: 400 });

  try {
    await cancelRun(runId);
    return NextResponse.json({ runId, cancelled: true });
  } catch (e) {
    if (e instanceof EditorApiError) {
      // a run that already finished cannot be cancelled, and that is not a
      // failure worth showing anyone
      const why = e.status === 404 ? `no run "${runId}"` : e.message;
      return NextResponse.json({ error: why, status: e.status }, { status: e.status || 500 });
    }
    return NextResponse.json({ error: (e as Error).message || String(e) }, { status: 500 });
  }
}
