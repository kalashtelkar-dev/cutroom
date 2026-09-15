import { NextResponse } from 'next/server';
import { editTimeline, EditorApiError } from '@/lib/editor-api/client.ts';

const MAX_OPS = 500;

/**
 * Apply a batch of edits.
 *
 * All of them or none, landing as ONE revision. That is the structural payoff
 * of "timeline is truth": an AI run is one batch, so a single undo reverses
 * the whole run instead of its last step, and `POST /restore/{n}` is itself
 * recorded, so an accidental undo is undoable too.
 *
 * `If-Match` carries the etag. A 412 back means someone else moved first and
 * the client should re-read rather than retry blindly.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { ops?: unknown[]; etag?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const ops = body.ops;
  if (!Array.isArray(ops) || ops.length === 0) {
    return NextResponse.json({ error: 'ops must be a non-empty array' }, { status: 400 });
  }
  if (ops.length > MAX_OPS) {
    return NextResponse.json(
      { error: `${ops.length} ops exceeds the ${MAX_OPS} the server applies atomically, split the run` },
      { status: 400 },
    );
  }

  try {
    const result = await editTimeline(id, ops, body.etag);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof EditorApiError) {
      const stale = e.status === 412 || e.status === 428;
      return NextResponse.json(
        {
          error: stale
            ? 'the timeline moved since you read it, re-read and reapply rather than retrying'
            : e.message,
          status: e.status,
          stale,
        },
        { status: e.status || 502 },
      );
    }
    throw e;
  }
}
