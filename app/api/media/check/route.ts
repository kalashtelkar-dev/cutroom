import { NextResponse } from 'next/server';

/**
 * Is this object still there, and can ffmpeg read it?
 *
 * A project outlives the bytes it points at. An upload lands under a dated
 * prefix (`input/2026-09-14/...`) and a proxy is a job output, so a document
 * saved a while ago can name two keys that no longer exist while looking
 * perfectly healthy: the clips are on the timeline, the durations are right,
 * and nothing says otherwise until something tries to read them.
 *
 * Before this route that discovery cost a pipeline run. The tool started, the
 * run reached the GPU, and the answer came back as "the job failed", with
 * `input_unreachable` visible only to whoever happened to be watching the
 * fleet. A few seconds of cpu here buys a sentence naming the file instead.
 *
 * `ffmpeg/video-info` rather than `probe`: the same cheap read, and it
 * answers with the duration, which is worth having.
 */
export const dynamic = 'force-dynamic';

/** Long enough for a cold worker, short enough that nobody watches a spinner. */
const DEADLINE_MS = 25_000;
const POLL_MS = 1_200;

export async function POST(request: Request) {
  let body: { key?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) return NextResponse.json({ error: 'a key is required' }, { status: 400 });

  const base = process.env.EDITOR_API_URL?.replace(/\/+$/, '');
  const apiKey = process.env.EDITOR_API_KEY;
  if (!base || !apiKey) {
    return NextResponse.json({ error: 'the editor API is not configured' }, { status: 500 });
  }
  const auth = { Authorization: `Bearer ${apiKey}` };

  try {
    const started = await fetch(`${base}/v1/ffmpeg/video-info`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: key, tier: 'cpu' }),
      cache: 'no-store',
    });
    const accepted = await started.json().catch(() => ({}));
    if (!started.ok) {
      return NextResponse.json({
        reachable: false,
        reason: accepted?.error?.message ?? `the check was refused, ${started.status}`,
      });
    }
    const jobId = accepted.id ?? accepted.jobId;
    if (!jobId) return NextResponse.json({ reachable: null, reason: 'the check returned no job id' });

    const until = Date.now() + DEADLINE_MS;
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const res = await fetch(`${base}/v1/jobs/${encodeURIComponent(String(jobId))}`, {
        headers: auth, cache: 'no-store',
      });
      const job = await res.json().catch(() => ({}));
      const status = String(job.status ?? '');

      if (['succeeded', 'done', 'completed'].includes(status)) {
        return NextResponse.json({ reachable: true, duration: job.result?.duration ?? null });
      }
      if (['failed', 'error', 'cancelled'].includes(status)) {
        const code = job.error?.code ?? status;
        return NextResponse.json({
          reachable: false,
          code,
          reason: code === 'input_unreachable'
            ? 'that file is not in storage any more'
            : job.error?.message ?? `the check ${status}`,
        });
      }
      if (Date.now() > until) {
        // unknown, and saying so beats refusing a run because a queue is slow
        return NextResponse.json({ reachable: null, reason: 'the check did not finish in time' });
      }
    }
  } catch (e) {
    return NextResponse.json({ reachable: null, reason: (e as Error).message });
  }
}
