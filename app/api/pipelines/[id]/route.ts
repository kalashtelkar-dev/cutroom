import { NextResponse } from 'next/server';
import { getPipeline, EditorApiError } from '@/lib/editor-api/client.ts';

/**
 * One pipeline, by its id.
 *
 * This is the read half of the Publish button. The REST API cannot list
 * pipelines, so the id is the only handle there is on one, and without this
 * route the workbench could put a pipeline into the account and then have no
 * way of ever opening it again.
 *
 * Free and non-mutating: it reads a draft, it does not run anything.
 *
 * Everything is caught and answered with a reason. A thrown Error here would
 * reach Next's default handler, which returns an empty body, and the fetch
 * would report a failure with nothing after the colon.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const wanted = id.trim();
  if (!wanted) {
    return NextResponse.json({ error: 'a pipeline id is required' }, { status: 400 });
  }

  try {
    const p = await getPipeline(wanted);
    return NextResponse.json({
      id: p.id,
      name: p.name,
      description: p.description ?? null,
      version: p.version,
      published: p.published,
      compiles: p.compiles,
      issues: Array.isArray(p.issues) ? p.issues : [],
      etag: p.etag,
      graph: p.graph,
    });
  } catch (e) {
    if (e instanceof EditorApiError) {
      // 404 is the common one and the server's own wording for it says less
      // than the id the person actually typed
      const why = e.status === 404
        ? `no pipeline "${wanted}" in this account`
        : e.message;
      return NextResponse.json({ error: why, status: e.status }, { status: e.status || 500 });
    }
    return NextResponse.json(
      { error: (e as Error).message || String(e) },
      { status: 500 },
    );
  }
}
