import { NextResponse } from 'next/server';

/**
 * Whether this account can translate, and under what name.
 *
 * Named for what it answers rather than for what answers it: the route this
 * replaced was `/api/config/vllm`, which put the name of the engine behind it
 * in the network tab of anyone who opened one.
 *
 * `vllm/translate` takes a connection, and a connection is a name configured
 * under Connections in the AISuite dashboard. The API has no endpoint that
 * lists them: asking for one that does not exist starts a job, which fails
 * seconds later with `no connection named "..." - add it under Connections in
 * the dashboard`. That is a real answer and a terrible way to find out, since
 * by then the transcription has already been paid for.
 *
 * So the name lives in `VLLM_CONNECTION` and the editor reads it BEFORE it
 * starts anything. A name is a label, not a credential: the key behind it
 * never leaves the dashboard, and this route hands over a name or a null and
 * nothing else.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const name = process.env.VLLM_CONNECTION?.trim();
    return NextResponse.json({ connection: name ? name : null });
  } catch (e) {
    // Never let a thrown Error become an empty 500: a browser reading this
    // one is deciding whether to offer translation at all.
    return NextResponse.json({ error: (e as Error).message || String(e) }, { status: 500 });
  }
}
