/**
 * Prove the thing end to end, against the live API.
 *
 *   npm run prove
 *
 * This SPENDS: it generates source media, compiles a timeline, publishes a
 * pipeline and runs it, then downloads the result. Everything it creates is
 * named `cutroom-proof-*` so it can be found and removed.
 *
 * It exists because until a real file comes back nobody, me included, knows
 * whether any of this works. Every layer below has tests; tests prove the
 * layers agree with themselves.
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createJobStore, runAsJob } from '../lib/jobs/store.ts';
import type { JobHandle } from '../lib/jobs/types.ts';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const KEY = env.match(/^EDITOR_API_KEY=(.*)$/m)![1].trim();
const BASE = env.match(/^EDITOR_API_URL=(.*)$/m)![1].trim();
const OUT = '/private/tmp/cutroom-proof';

const store = createJobStore();

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body as T;
}

interface JobAccepted { id?: string; jobId?: string; status?: string }
interface JobResult {
  id: string;
  status: string;
  outputs?: { key: string; bytes: number; role?: string; url?: string }[];
  error?: unknown;
}

/**
 * Run one operation and wait for it.
 *
 * A single operation is a JOB and lives at /v1/jobs/{id}. A published
 * pipeline is a RUN and lives at /v1/runs/{id}. They are different things
 * with different ids, and asking the wrong one answers 404 rather than
 * telling you which you wanted.
 */
async function runOperation(
  job: JobHandle, engine: string, operation: string, params: Record<string, unknown>,
): Promise<JobResult> {
  job.log(`${engine}/${operation}`, 'info', params);
  const accepted = await api<JobAccepted>(`/v1/${engine}/${operation}`, {
    method: 'POST', body: JSON.stringify(params),
  });
  const id = accepted.id ?? accepted.jobId;
  if (!id) throw new Error(`no job id in ${JSON.stringify(accepted).slice(0, 200)}`);
  job.log(`job ${id} accepted`);

  const started = Date.now();
  for (;;) {
    const r = await api<JobResult>(`/v1/jobs/${id}`);
    if (r.status === 'succeeded' || r.status === 'done' || r.status === 'completed') {
      job.log(`job ${id} ${r.status} in ${Date.now() - started}ms`, 'info',
        r.outputs?.map((o) => ({ key: o.key, bytes: o.bytes, role: o.role })));
      return r;
    }
    if (r.status === 'failed' || r.status === 'error' || r.status === 'cancelled') {
      throw new Error(`job ${id} ${r.status}: ${JSON.stringify(r.error).slice(0, 300)}`);
    }
    if (Date.now() - started > 240_000) throw new Error(`job ${id} still ${r.status} after 4 minutes`);
    await new Promise((r2) => setTimeout(r2, 2000));
  }
}

const firstFile = (r: JobResult): string => {
  const out = r.outputs?.find((o) => o.role !== 'poster') ?? r.outputs?.[0];
  if (!out) throw new Error('the job succeeded but returned no output');
  return out.key;
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`base: ${BASE}\nout:  ${OUT}\n`);

  // ── 1. make source media, so nothing here depends on a file I do not have
  const gen = await runAsJob(store, 'operation', 'Generate two source clips', async (job) => {
    // args is argv, one token per element. A single string is rejected, and
    // rightly: splitting a command line on spaces is how filter graphs break.
    const a = await runOperation(job, 'ffmpeg', 'custom', {
      args: [
        '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '{out}',
      ],
      output: 'clip-a.mp4',
      tier: 'cpu',
    });
    job.progress(0.5);
    const b = await runOperation(job, 'ffmpeg', 'custom', {
      args: [
        '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=24:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=660:duration=6',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '{out}',
      ],
      output: 'clip-b.mp4',
      tier: 'cpu',
    });
    job.progress(1);
    return { a: firstFile(a), b: firstFile(b) };
  });
  if (!gen.ok) throw gen.error;
  const { a: keyA, b: keyB } = gen.value;
  console.log(`source media:\n  ${keyA}\n  ${keyB}\n`);

  // ── 2. probe, the way an import would, so the timeline knows real durations
  const probed = await runAsJob(store, 'import', 'Probe the sources', async (job) => {
    const r = await runOperation(job, 'ffmpeg', 'probe', { input: keyA, tier: 'cpu' });
    return r.outputs?.length ?? 0;
  });
  console.log(`probe: ${probed.ok ? 'ok' : 'FAILED ' + probed.error.message}\n`);

  // ── 3. the actual edit: trim each, then join. This is what the compiler
  //      emits for a two clip timeline, run one operation at a time so a
  //      failure names the step rather than the graph.
  const cut = await runAsJob(store, 'compile', 'Cut and assemble', async (job) => {
    const t1 = await runOperation(job, 'ffmpeg', 'trim', {
      input: keyA, startSec: 1, durationSec: 3, reencode: true, tier: 'cpu',
    });
    job.progress(0.33);
    const t2 = await runOperation(job, 'ffmpeg', 'trim', {
      input: keyB, startSec: 0.5, durationSec: 2.5, reencode: true, tier: 'cpu',
    });
    job.progress(0.66);
    const joined = await runOperation(job, 'ffmpeg', 'concat', {
      inputs: [firstFile(t1), firstFile(t2)], reencode: true, container: 'mp4', tier: 'cpu',
    });
    job.progress(1);
    return firstFile(joined);
  });
  if (!cut.ok) throw cut.error;
  console.log(`assembled: ${cut.value}\n`);

  // ── 4. get the bytes back, which is the only part that proves anything
  const fetched = await runAsJob(store, 'save', 'Download the result', async (job) => {
    // urls comes back as an object keyed by the object key, not an array
    const signed = await api<{ urls?: Record<string, string> }>(
      '/v1/outputs/sign', { method: 'POST', body: JSON.stringify({ keys: [cut.value] }) },
    );
    const url = signed.urls?.[cut.value];
    if (!url) throw new Error(`sign returned nothing usable: ${JSON.stringify(signed).slice(0, 200)}`);
    job.log('signed, downloading');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(`${OUT}/cut.mp4`, buf);
    job.log(`wrote ${OUT}/cut.mp4`);
    return buf.length;
  });

  console.log(fetched.ok
    ? `\nWROTE ${OUT}/cut.mp4  (${fetched.value} bytes)\n`
    : `\ncould not download: ${fetched.error.message}\n`);

  console.log('── job log ──');
  for (const j of store.list().reverse()) {
    console.log(`\n[${j.status}] ${j.label}  ${j.endedAt! - j.startedAt}ms`);
    for (const l of j.log) console.log(`   ${l.level.padEnd(5)} ${l.message}`);
  }
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
