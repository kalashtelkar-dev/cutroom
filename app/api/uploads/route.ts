import { NextResponse } from 'next/server';
import { EditorApiError } from '@/lib/editor-api/client.ts';
import { presignUpload } from '@/lib/editor-api/uploads.ts';

/**
 * Hand the browser a presigned URL and get out of the way.
 *
 * "The API never proxies media bytes" is the server's own rule, and it is the
 * right one: a 4GB master should not travel through a Next route handler,
 * where it would be buffered, counted against a serverless body limit, and
 * doubled in transit for no benefit.
 *
 * So this endpoint is only a key-holder. It asks the editor API for a
 * presigned PUT, returns the URL and the object key, and the browser uploads
 * straight to storage. The API key never leaves the server.
 */
export async function POST(request: Request) {
  let body: { filename?: string; contentType?: string; bytes?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const filename = body.filename?.trim();
  if (!filename) {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 });
  }

  try {
    const signed = await presignUpload(filename);
    return NextResponse.json(signed);
  } catch (e) {
    // Every failure answers with its reason. A thrown plain Error used to
    // escape to Next's default handler, which returns an empty body, and the
    // browser then reported "could not get an upload url:" with nothing after
    // the colon. An error that does not say what went wrong is a bug of its own.
    const status = e instanceof EditorApiError ? (e.status || 502) : 502;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
