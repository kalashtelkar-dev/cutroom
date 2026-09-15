import { streamRun, EditorApiError } from '@/lib/editor-api/client.ts';

/**
 * Proxy a run's SSE stream to the browser.
 *
 * The upstream body is piped straight through rather than buffered: buffering
 * would turn a live progress stream into one late lump, which is the whole
 * thing this endpoint exists to avoid on a render that takes minutes.
 *
 * The key stays on this side. The browser talks to us; we talk to the worker.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const upstream = await streamRun(id, request.signal);
    if (!upstream.body) {
      return new Response('the run stream had no body', { status: 502 });
    }
    return new Response(upstream.body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // some proxies buffer SSE unless told not to
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (e) {
    if (e instanceof EditorApiError) {
      return Response.json({ error: e.message, status: e.status }, { status: e.status || 502 });
    }
    throw e;
  }
}
