import { readFileSync } from 'node:fs';
const env = readFileSync('.env.local', 'utf8');
const KEY = env.match(/^EDITOR_API_KEY=(.*)$/m)![1].trim();
const URL_ = env.match(/^EDITOR_API_URL=(.*)$/m)![1].trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api<T>(p: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${URL_}${p}`, { ...init, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const b = await r.json();
  if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(b).slice(0,200)}`);
  return b as T;
}
async function run(engine: string, op: string, params: Record<string, unknown>) {
  const s = await api<{ id?: string }>(`/v1/${engine}/${op}`, { method: 'POST', body: JSON.stringify(params) });
  if (!s.id) return s as Record<string, unknown>;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const j = await api<{ status: string; result?: Record<string, unknown>; error?: unknown }>(`/v1/jobs/${s.id}`);
    if (['succeeded','done','completed'].includes(j.status)) return j.result ?? {};
    if (['failed','error'].includes(j.status)) throw new Error(JSON.stringify(j.error).slice(0,200));
  }
  throw new Error('never finished');
}
const outs = (r: Record<string, unknown>) => (r.outputs ?? []) as { key: string }[];

const src = outs(await run('ffmpeg','synthetic',{pattern:'color',color:'black',width:320,height:180,fps:24,durationSec:3,audio:false,container:'mp4',videoCodec:'h264'}))[0].key;
console.log('source', src);

const CASES: [string, string][] = [
  ['plain, no gate',      `drawtext=text='HELLO':fontcolor=white:fontsize=20:x=10:y=10`],
  ['plain, with gate',    `drawtext=text='HELLO':fontcolor=white:fontsize=20:x=10:y=10:enable='between(t,0.5,1.5)'`],
  ['two gated filters',   `drawtext=text='ONE':fontcolor=white:fontsize=20:x=10:y=10:enable='between(t,0.5,1.5)',drawtext=text='TWO':fontcolor=white:fontsize=20:x=10:y=40:enable='between(t,1.5,2.5)'`],
  ['apostrophe raw',      `drawtext=text='IT'S':fontcolor=white:fontsize=20:x=10:y=10`],
  ["apostrophe '\\'' ",   `drawtext=text='IT'\\''S':fontcolor=white:fontsize=20:x=10:y=10`],
  ['colon escaped',       `drawtext=text='A\\: B':fontcolor=white:fontsize=20:x=10:y=10`],
  ['colon bare in quotes',`drawtext=text='A: B':fontcolor=white:fontsize=20:x=10:y=10`],
  ['comma bare in quotes',`drawtext=text='A, B':fontcolor=white:fontsize=20:x=10:y=10`],
  ['percent bare',        `drawtext=text='50%':fontcolor=white:fontsize=20:x=10:y=10`],
  ['brackets bare',       `drawtext=text='A[1]':fontcolor=white:fontsize=20:x=10:y=10`],
];

for (const [name, vf] of CASES) {
  try {
    await run('ffmpeg','custom',{ input:[src], args:['-i','{in0}','-vf',vf,'-an','{out}'], output:'p.mp4', tier:'cpu' });
    console.log(`  OK    ${name}`);
  } catch (e) {
    console.log(`  FAIL  ${name}  ${(e as Error).message.slice(0,90)}`);
  }
}
