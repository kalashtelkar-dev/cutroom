import { GraphBuilder, preflight } from '../lib/editor-api/graph.ts';
import { readFileSync } from 'node:fs';
const env = readFileSync('.env.local','utf8');
const KEY = env.match(/^EDITOR_API_KEY=(.*)$/m)![1].trim();
const URL_ = env.match(/^EDITOR_API_URL=(.*)$/m)![1].trim();

async function server(graph: unknown) {
  const r = await fetch(`${URL_}/v1/pipelines/validate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

const cases: Array<[string, () => ReturnType<GraphBuilder['build']>]> = [
  ['clean: thumbnail 4 frames', () => {
    const b = new GraphBuilder();
    const s = b.input('video','file:video'); const t = b.op('ffmpeg','thumbnail',{count:4,width:320});
    const o = b.output(['frames']);
    b.wire(s,'value',t,'input').wire(t,'frames',o,'frames'); return b.build();
  }],
  ['clean: fan-out then collapse (montage takes images)', () => {
    const b = new GraphBuilder();
    const s = b.input('video','file:video'); const t = b.op('ffmpeg','thumbnail',{count:8});
    // `inputs` and `file` were guessed. The catalogue says this node takes
    // `input` and returns `files`, and with the guessed names the case
    // labelled "clean" did not compile on either side, which is the exact
    // kind of thing this script exists to catch and was quietly printing.
    const m = b.op('imagemagick','montage'); const o = b.output(['files']);
    b.wire(s,'value',t,'input').wire(t,'frames',m,'input').wire(m,'files',o,'files'); return b.build();
  }],
  ['bad: fan_out_twice', () => {
    const b = new GraphBuilder();
    const s = b.input('video','file:video');
    const a = b.op('ffmpeg','thumbnail',{count:4});
    const d = b.op('ffmpeg','thumbnail',{count:4,atSec:1});
    const m = b.op('imagemagick','composite'); const o = b.output(['file']);
    b.wire(s,'value',a,'input').wire(s,'value',d,'input')
     .wire(a,'frames',m,'base').wire(d,'frames',m,'overlay').wire(m,'file',o,'file');
    return b.build();
  }],
  ['bad: unknown port', () => {
    const b = new GraphBuilder();
    const s = b.input('video','file:video'); const p = b.op('ffmpeg','probe');
    const o = b.output(['format']);
    b.wire(s,'value',p,'inpt').wire(p,'format',o,'format'); return b.build();
  }],
  ['bad: type mismatch', () => {
    const b = new GraphBuilder();
    const s = b.input('words','text'); const p = b.op('ffmpeg','probe');
    const o = b.output(['format']);
    b.wire(s,'value',p,'input').wire(p,'format',o,'format'); return b.build();
  }],
];

/**
 * A check that cannot fail is not a check.
 *
 * This script used to print a table and exit 0 whatever it found, so
 * AGENTS.md's claim that offline preflight "is checked to match the server's"
 * rested on somebody reading the output. Nobody did: a case named "clean"
 * sat in here for a long time not compiling on either side, and the run
 * still reported success.
 *
 * The contract is now asserted. A case named `clean:` has to be clean
 * locally AND compile on the server; a case named `bad:` has to be refused
 * by both. Local and server disagreeing about whether a graph compiles is
 * the failure this exists to find, and it now exits non-zero.
 */
const failures: string[] = [];

for (const [name, make] of cases) {
  const g = make();
  const mine = preflight(g);
  const { status, body } = await server(g);
  const b = body as Record<string, unknown> & { compiles?: boolean; issues?: unknown[] };
  const theirs = b.issues ?? [];
  console.log(`\n── ${name}`);
  console.log(`   local : ${mine.length ? mine.map(d=>d.code).join(', ') : 'clean'}`);
  console.log(`   server: HTTP ${status} compiles=${b.compiles ?? '?'} ${Array.isArray(theirs)&&theirs.length?JSON.stringify(theirs).slice(0,260):'(no issues)'}`);
  if (mine.length) console.log(`   local msg: ${mine[0].message.slice(0,120)}`);

  const shouldCompile = name.startsWith('clean:');
  if (status !== 200) {
    failures.push(`${name}: the server answered HTTP ${status}, so nothing was compared`);
    continue;
  }
  const localOk = mine.length === 0;
  const serverOk = b.compiles === true;
  if (localOk !== serverOk) {
    failures.push(`${name}: local says ${localOk ? 'clean' : mine.map((d) => d.code).join(', ')}, server says compiles=${b.compiles}`);
  } else if (localOk !== shouldCompile) {
    failures.push(`${name}: expected it to ${shouldCompile ? 'compile' : 'be refused'}, both sides ${localOk ? 'compiled it' : 'refused it'}`);
  }
}

// A comparison of nothing passes. If the case list is ever emptied or the
// loop stops running, this is what says so instead of reporting success.
if (cases.length < 5) {
  failures.push(`only ${cases.length} cases, so this run proved almost nothing`);
}

console.log('');
if (failures.length) {
  console.log(`xcheck: ${failures.length} of ${cases.length} disagree\n`);
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`xcheck: ${cases.length} cases, offline preflight agrees with the server\n`);
