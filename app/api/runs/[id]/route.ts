import { NextResponse } from 'next/server';
import { getRun, EditorApiError } from '@/lib/editor-api/client.ts';

/**
 * One run, including what it produced.
 *
 * The SSE stream beside this carries progress, and progress is not a result:
 * a pipeline whose output is JSON rather than a file emits no job outputs at
 * all, so a run could complete with the editor having nothing to show for it.
 * This is where the answer is read from.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const runId = id.trim();
  if (!runId) return NextResponse.json({ error: 'a run id is required' }, { status: 400 });

  try {
    const run = await getRun(runId) as Record<string, unknown>;
    return NextResponse.json({
      runId: (run.runId as string) ?? runId,
      status: run.status ?? 'unknown',
      output: run.output ?? null,
      error: run.error ?? null,
      steps: run.steps ?? [],
    });
  } catch (e) {
    if (e instanceof EditorApiError) {
      const why = e.status === 404 ? `no run "${runId}"` : e.message;
      return NextResponse.json({ error: why, status: e.status }, { status: e.status || 500 });
    }
    return NextResponse.json({ error: (e as Error).message || String(e) }, { status: 500 });
  }
}
