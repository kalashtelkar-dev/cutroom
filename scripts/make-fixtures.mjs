/**
 * Real media for the harness to import.
 *
 * Generated once through the API and cached on disk, because there is no
 * local ffmpeg and a hand-crafted MP4 is not a real file. The harness needs
 * genuine bytes: every media bug this project has had was in what the server
 * did with the file, not in what the browser thought it was.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const OUT = '/private/tmp/cutroom-fixtures';
mkdirSync(OUT, { recursive: true });

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);
const BASE = env.EDITOR_API_URL;
const KEY = env.EDITOR_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, init = {}) => {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
};

const wait = async (id) => {
  for (let i = 0; i < 90; i++) {
    await sleep(1500);
    const j = await api(`/v1/jobs/${id}`);
    if (['succeeded', 'done', 'completed'].includes(j.status)) return j;
    if (['failed', 'error', 'cancelled'].includes(j.status)) throw new Error(`job ${j.status}`);
  }
  throw new Error('job never finished');
};

const FIXTURES = [
  { file: 'fixture.mp4', args: ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=6',
                                '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
                                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '{out}'] },
  { file: 'fixture.jpg', args: ['-f', 'lavfi', '-i', 'smptebars=size=320x180', '-frames:v', '1', '{out}'] },
  { file: 'fixture.png', args: ['-f', 'lavfi', '-i', 'testsrc=size=320x180', '-frames:v', '1', '{out}'] },
  { file: 'fixture.wav', args: ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '{out}'] },
];

let made = 0;
for (const f of FIXTURES) {
  const path = `${OUT}/${f.file}`;
  if (existsSync(path) && readFileSync(path).length > 0) { console.log(`have  ${f.file}`); continue; }
  const started = await api('/v1/ffmpeg/custom', {
    method: 'POST', body: JSON.stringify({ args: f.args, output: f.file, tier: 'cpu' }),
  });
  const done = await wait(started.id);
  const key = done.outputs[0].key;
  const signed = await api('/v1/outputs/sign', { method: 'POST', body: JSON.stringify({ keys: [key] }) });
  const bytes = Buffer.from(await (await fetch(signed.urls[key])).arrayBuffer());
  writeFileSync(path, bytes);
  console.log(`made  ${f.file}  ${bytes.length} bytes`);
  made += 1;
}
console.log(made ? `\n${made} fixture(s) written to ${OUT}` : `\nall fixtures present in ${OUT}`);
