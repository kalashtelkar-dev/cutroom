/**
 * Every destination the export dialog offers, compiled and put to the server.
 *
 *   npm run check:delivery
 *
 * `POST /v1/pipelines/validate` stores nothing, runs nothing and costs
 * nothing, so this is free to run as often as it is worth running.
 *
 * It exists because of the one mistake that has cost this project the most.
 * `ffmpeg/transcode` takes a width and a height and the catalogue does not say
 * what it does when their shape is not its input's, which did not matter while
 * every export was 16:9 into 16:9. A reel is the first time the readings
 * differ, so the compiler now sets the frame itself with a filter of its own,
 * and a filter of our own is exactly the kind of thing that typechecks, unit
 * tests green, and comes back `ffmpeg exited 234` with no diagnostics.
 *
 * Offline preflight answers ten of the twelve compiler codes and the server is
 * still the authority, so both are asked and disagreement is a failure.
 */
import { readFileSync } from 'node:fs';

import { compile } from '../lib/compiler/compile.ts';
import { preflight } from '../lib/editor-api/graph.ts';
import { demoProject } from '../lib/fixtures/project.ts';
import { TARGETS } from '../lib/export/targets.ts';
import type { DeliverySpec, FrameFit } from '../lib/compiler/types.ts';
import type { Timeline } from '../lib/timeline/types.ts';

const env = readFileSync('.env.local', 'utf8');
const KEY = env.match(/^EDITOR_API_KEY=(.*)$/m)?.[1].trim();
const URL_ = env.match(/^EDITOR_API_URL=(.*)$/m)?.[1].trim();
if (!KEY || !URL_) {
  console.error('\n.env.local needs EDITOR_API_KEY and EDITOR_API_URL\n');
  process.exit(1);
}

interface Answer { compiles?: boolean; errors?: unknown[]; unfinished?: unknown[] }

async function validate(graph: unknown): Promise<Answer> {
  const r = await fetch(`${URL_}/v1/pipelines/validate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph }),
  });
  const body = (await r.json().catch(() => ({}))) as Answer;
  if (!r.ok) throw new Error(`validate answered ${r.status}: ${JSON.stringify(body)}`);
  return body;
}

/**
 * The same programme with a measured picture on the track above.
 *
 * The demo pool reports no dimensions, which is the conservative path: an
 * upper track cannot be built at the box its own pictures occupy, so it is
 * fitted to the delivery frame and the bars that adds are laid over the track
 * below as black. Measuring it takes the other branch, where a layer is a
 * different size from the frame and `overlay` places it, and that graph has
 * to compile too.
 */
function measured(): Timeline {
  const t = demoProject();
  const upper = t.tracks.filter((tr) => tr.kind === 'video')
    .find((tr, i) => i === 0 && tr.items.some((it) => it.kind === 'clip'));
  if (!upper) throw new Error('the demo project has no upper picture track to measure');
  const square = new Set(
    upper.items.filter((it) => it.kind === 'clip').map((it) => it.mediaKey),
  );
  if (square.size === 0) throw new Error('the upper track holds no media to measure');
  for (const [key, m] of Object.entries(t.media)) {
    if (m.kind === 'audio') continue;
    t.media[key] = square.has(key)
      ? { ...m, width: 1500, height: 1500 }
      : { ...m, width: 1920, height: 1080 };
  }
  return t;
}

const docs: { label: string; doc: Timeline }[] = [
  { label: 'unmeasured', doc: demoProject() },
  { label: 'measured', doc: measured() },
];

const cases: { name: string; doc: Timeline; delivery: DeliverySpec }[] = [];
for (const t of TARGETS) {
  for (const fit of ['contain', 'cover'] as FrameFit[]) {
    for (const d of docs) {
      cases.push({
        name: `${t.name} ${t.width}x${t.height} ${fit} ${d.label}`,
        doc: d.doc,
        delivery: {
          width: t.width, height: t.height, container: 'mp4', videoCodec: 'h264',
          videoBitrate: '8M', audioBitrate: '192k', reencode: true, fit,
        },
      });
    }
  }
}

if (cases.length === 0) {
  console.error('no destinations to check, so this script proved nothing');
  process.exit(1);
}

/**
 * The two documents have to compile to two different graphs.
 *
 * Otherwise the measured half of this table is the unmeasured half again,
 * checked twice and reported as twice the coverage. It has been exactly that
 * once already: `demoProject()` handed every caller the same media pool, so
 * measuring one document measured both.
 */
{
  const spec: DeliverySpec = {
    width: 1080, height: 1920, container: 'mp4', videoCodec: 'h264', reencode: true, fit: 'contain',
  };
  const [plain, sized] = docs.map((d) => JSON.stringify(compile(d.doc, { delivery: spec }).graph));
  if (plain === sized) {
    console.error('the measured document compiles to the same graph as the unmeasured one');
    process.exit(1);
  }
}

let bad = 0;
for (const c of cases) {
  let line = `  ${c.name}`;
  try {
    const compiled = compile(c.doc, { delivery: c.delivery, burnSubtitles: true });
    const local = preflight(compiled.graph);
    const server = await validate(compiled.graph);
    const problems = [...(server.errors ?? []), ...(server.unfinished ?? [])];
    const ok = local.length === 0 && server.compiles === true && problems.length === 0;
    if (!ok) {
      bad += 1;
      line = `  FAIL ${c.name}`;
      if (local.length) line += `\n    preflight: ${JSON.stringify(local)}`;
      if (problems.length) line += `\n    server: ${JSON.stringify(problems)}`;
    } else {
      line = `  pass ${c.name}  ${compiled.graph.nodes.length} nodes`;
    }
  } catch (e) {
    bad += 1;
    line = `  FAIL ${c.name}\n    ${(e as Error).message}`;
  }
  console.log(line);
}

console.log(`\n${cases.length - bad}/${cases.length} compile on both sides\n`);
process.exit(bad ? 1 : 0);
