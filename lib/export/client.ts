'use client';

/**
 * Export, from the browser.
 *
 * Reads the route's event stream and hands each phase to the caller, so the
 * jobs panel fills in as the render moves rather than all at once at the end.
 *
 * `EventSource` cannot POST and this needs a whole timeline in the body, so
 * the response body is decoded by hand. `parseSse` is the same decoder the
 * executor uses, which is written against events split across chunk
 * boundaries and a final event with no trailing blank line.
 */
import { parseSse } from '../executor/sse.ts';
import type { Timeline } from '../timeline/types.ts';
import type { DeliverySpec } from '../compiler/types.ts';
import type { ExportEvent, ExportResult } from './types.ts';

export interface ExportRequest {
  timeline: Timeline;
  delivery: Partial<DeliverySpec>;
  pipelineId?: string | null;
  name?: string;
  burnSubtitles?: boolean;
  range?: { start: number; duration: number };
}

export async function runExport(
  req: ExportRequest,
  onEvent: (e: ExportEvent) => void,
  signal?: AbortSignal,
): Promise<ExportResult> {
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });

  if (!res.ok) {
    // a body at all means the route answered rather than the stream failing
    const text = await res.text().catch(() => '');
    let why = text;
    try { why = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* keep the text */ }
    throw new Error(why || `the export route answered ${res.status}`);
  }
  if (!res.body) throw new Error('the export stream had no body');

  let result: ExportResult | null = null;
  let failure: { message: string; phase?: string } | null = null;

  for await (const ev of parseSse(res.body)) {
    if (ev.event === 'progress') {
      onEvent(JSON.parse(ev.data) as ExportEvent);
    } else if (ev.event === 'done') {
      result = JSON.parse(ev.data) as ExportResult;
    } else if (ev.event === 'failed') {
      failure = JSON.parse(ev.data) as { message: string; phase?: string };
    }
  }

  if (failure) throw new Error(failure.message);
  if (!result) {
    // the stream ended without saying either way: a dropped connection, or a
    // process that died. Saying so beats resolving with nothing.
    throw new Error('the export stream ended without a result');
  }
  return result;
}
