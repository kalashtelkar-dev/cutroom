import { NextResponse } from 'next/server';
import { runPipeline, getPipeline, EditorApiError } from '@/lib/editor-api/client.ts';
import { bodyMismatch, inputContract } from '@/lib/editor-api/run-body.ts';

/**
 * Start a published pipeline.
 *
 * SPENDS. This is the route the tool rail reaches when a rung 3 tool is run,
 * and until it existed every rung 3 and rung 4 tool in the editor was a
 * button that said "this account does not have a published pipeline yet"
 * without ever having asked the account anything.
 *
 * The body is `{ pipelineId, input }`, and `input` is keyed by the input
 * node's NAME, not its id: `broll b1` has one input node `in_video` whose
 * name is `video`, so its run body is `{ video: "<object key>" }`. The
 * compiler builds the same shape for an export, which is the path this
 * contract was proved on.
 *
 * Everything is caught and answered with the reason. A thrown Error here
 * would reach Next's default handler and the browser would report a failed
 * run with nothing after the colon.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: { pipelineId?: unknown; input?: unknown; idempotencyKey?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const pipelineId = typeof body.pipelineId === 'string' ? body.pipelineId.trim() : '';
  if (!pipelineId) {
    return NextResponse.json({ error: 'a pipelineId is required to start a run' }, { status: 400 });
  }

  const input = body.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return NextResponse.json(
      { error: 'a run needs an input object, keyed by the input node name' },
      { status: 400 },
    );
  }
  if (!Object.keys(input).length) {
    // the server takes an empty body and then fails inside the run, minutes
    // later, which is a slow way to learn the card bound nothing
    return NextResponse.json(
      { error: 'the plan bound no inputs, so there is nothing for the pipeline to read' },
      { status: 400 },
    );
  }

  /**
   * Read the pipeline before spending on it.
   *
   * A wrong key comes back from the server as "the request body does not
   * match this pipeline", which names neither the key that was wrong nor the
   * ones that would have been right. This call stores nothing and costs
   * nothing, and turns that into a sentence someone can act on. A failure to
   * read is not a failure to run: if the check itself cannot be made, the run
   * goes ahead and the server stays the authority.
   */
  try {
    const p = await getPipeline(pipelineId);
    const why = bodyMismatch(
      input as Record<string, unknown>,
      inputContract((p as { graph?: { nodes?: { kind?: string; name?: string; required?: boolean }[] } }).graph?.nodes),
      (p as { name?: string }).name,
    );
    if (why) return NextResponse.json({ error: why }, { status: 400 });
  } catch (e) {
    if (e instanceof EditorApiError && e.status === 404) {
      return NextResponse.json(
        { error: `no pipeline "${pipelineId}" in this account` },
        { status: 404 },
      );
    }
    // could not check: that is not a reason to refuse the run
  }

  try {
    const started = await runPipeline(
      pipelineId,
      input,
      typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
    );
    // `runId`, not `id`: reading the wrong one leaves a string that looks like
    // a run id until it 404s on the first poll
    const runId = started.runId ?? started.id;
    if (!runId) {
      return NextResponse.json(
        { error: 'the run started and returned no run id' },
        { status: 502 },
      );
    }
    return NextResponse.json({ runId });
  } catch (e) {
    if (e instanceof EditorApiError) {
      const why = e.status === 404
        ? `no published pipeline "${pipelineId}" in this account`
        : e.message;
      return NextResponse.json({ error: why, status: e.status }, { status: e.status || 500 });
    }
    return NextResponse.json({ error: (e as Error).message || String(e) }, { status: 500 });
  }
}
