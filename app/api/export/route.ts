import { exportTimeline } from '@/lib/export/render.ts';
import { serverTransport } from '@/lib/export/transport.server.ts';
import { ExportError, type ExportEvent } from '@/lib/export/types.ts';
import { EditorApiError } from '@/lib/editor-api/client.ts';
import type { Timeline } from '@/lib/timeline/types.ts';
import type { DeliverySpec } from '@/lib/compiler/types.ts';
import { frames } from '@/lib/time/frames.ts';

/**
 * Render a timeline.
 *
 * Server-sent events rather than one long request: this spends minutes on a
 * GPU and the person who pressed the button is entitled to know which of the
 * six steps it is on. The connection stays open for the whole render, so the
 * route is explicitly dynamic and nothing about it is cached.
 *
 * Every failure is caught and sent as a `failed` event carrying the reason.
 * A thrown Error would reach Next's default handler, which answers an empty
 * body, and an export that fails with no message is how this project learned
 * that rule the first time.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 800;

interface Body {
  timeline?: Timeline;
  delivery?: Partial<DeliverySpec>;
  pipelineId?: string | null;
  name?: string;
  burnSubtitles?: boolean;
  range?: { start: number; duration: number };
}

const DEFAULT_DELIVERY: DeliverySpec = {
  width: 1920,
  height: 1080,
  container: 'mp4',
  videoCodec: 'h264',
  videoBitrate: '8M',
  audioBitrate: '192k',
  // frame accurate by default. A cut that lands on a keyframe is a different
  // edit from the one on the timeline, and silently shipping that is worse
  // than the extra minutes.
  reencode: true,
  // and never crop someone's picture unless they asked for it
  fit: 'contain',
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const timeline = body.timeline;
  if (!timeline || !Array.isArray(timeline.tracks)) {
    return Response.json({ error: 'a timeline with tracks is required' }, { status: 400 });
  }

  const delivery: DeliverySpec = { ...DEFAULT_DELIVERY, ...(body.delivery ?? {}) };
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;   // the browser went away mid render
        }
      };

      try {
        const result = await exportTimeline(
          timeline,
          {
            delivery,
            pipelineId: body.pipelineId ?? null,
            name: body.name,
            burnSubtitles: body.burnSubtitles,
            range: body.range ? { start: frames(body.range.start), duration: frames(body.range.duration) } : undefined,
          },
          serverTransport(),
          (e: ExportEvent) => send('progress', e),
        );
        send('done', result);
      } catch (e) {
        const phase = e instanceof ExportError ? e.phase : 'failed';
        const detail = e instanceof ExportError ? e.detail
          : e instanceof EditorApiError ? { status: e.status, path: e.path, body: e.body }
          : undefined;
        send('failed', { phase, message: (e as Error).message ?? String(e), detail });
      } finally {
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
