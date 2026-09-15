import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createJobStore, runAsJob } from '../lib/jobs/store.ts';

/** A clock we drive, so duration and ordering are assertable without sleeping. */
function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('the job store', () => {
  test('a job records what was attempted before it records how it went', () => {
    const store = createJobStore({ now: fakeClock().now });
    const job = store.start('import', 'Import 3 files');
    assert.equal(store.get(job.id)!.log[0].message, 'Import 3 files');
    assert.equal(store.get(job.id)!.status, 'running');
  });

  test('duration is measured, not guessed', () => {
    const clock = fakeClock();
    const store = createJobStore({ now: clock.now });
    const job = store.start('save', 'Save');
    clock.advance(1234);
    store.finish(job.id, 'done');
    const j = store.get(job.id)!;
    assert.equal(j.endedAt! - j.startedAt, 1234);
    assert.match(j.log.at(-1)!.message, /done in 1234ms/);
  });

  test('newest first, because that is the order anyone reads a log in', () => {
    const store = createJobStore({ now: fakeClock().now });
    store.start('edit', 'first');
    store.start('edit', 'second');
    assert.deepEqual(store.list().map((j) => j.label), ['second', 'first']);
  });

  test('finishing twice is a no-op, so a late error cannot rewrite a success', () => {
    const store = createJobStore({ now: fakeClock().now });
    const job = store.start('edit', 'Blade');
    store.finish(job.id, 'done');
    store.finish(job.id, 'failed', { error: 'too late' });
    assert.equal(store.get(job.id)!.status, 'done');
    assert.equal(store.get(job.id)!.error, null);
  });

  test('a done job reads as complete, so a progress bar never stops at 97%', () => {
    const store = createJobStore({ now: fakeClock().now });
    const job = store.start('pipeline', 'Weave b-roll');
    job.progress(0.97);
    store.finish(job.id, 'done');
    assert.equal(store.get(job.id)!.progress, 1);
  });

  test('progress is clamped rather than trusted', () => {
    const store = createJobStore({ now: fakeClock().now });
    const job = store.start('pipeline', 'x');
    job.progress(4);
    assert.equal(store.get(job.id)!.progress, 1);
    job.progress(-1);
    assert.equal(store.get(job.id)!.progress, 0);
    job.progress(null);
    assert.equal(store.get(job.id)!.progress, null);
  });

  test('subscribers hear the current list immediately, not only the next change', () => {
    const store = createJobStore({ now: fakeClock().now });
    store.start('edit', 'already here');
    let seen: string[] = [];
    store.subscribe((jobs) => { seen = jobs.map((j) => j.label); });
    assert.deepEqual(seen, ['already here']);
  });

  test('unsubscribing actually stops the calls', () => {
    const store = createJobStore({ now: fakeClock().now });
    let calls = 0;
    const off = store.subscribe(() => { calls += 1; });
    const before = calls;
    off();
    store.start('edit', 'x');
    assert.equal(calls, before);
  });
});

describe('limits, because a session is unbounded and a tab is not', () => {
  test('the oldest jobs fall off the end', () => {
    const store = createJobStore({ now: fakeClock().now, limits: { maxJobs: 3 } });
    for (const label of ['a', 'b', 'c', 'd']) store.start('edit', label);
    assert.deepEqual(store.list().map((j) => j.label), ['d', 'c', 'b']);
    assert.equal(store.get('job_edit_1'), undefined, 'and are really gone, not just hidden');
  });

  test('a truncated log says so, and keeps both ends', () => {
    const store = createJobStore({ now: fakeClock().now, limits: { maxLogLines: 10 } });
    const job = store.start('pipeline', 'the attempt');
    for (let i = 0; i < 40; i++) job.log(`line ${i}`);
    const j = store.get(job.id)!;
    assert.ok(j.truncated, 'a truncated log must never read as a complete one');
    assert.equal(j.log.length, 10);
    assert.equal(j.log[0].message, 'the attempt', 'what was attempted survives');
    assert.equal(j.log.at(-1)!.message, 'line 39', 'and so does how it ended');
  });

  test('clear keeps jobs that are still running', () => {
    const store = createJobStore({ now: fakeClock().now });
    const done = store.start('edit', 'finished');
    store.finish(done.id, 'done');
    store.start('pipeline', 'still going');
    store.clear();
    assert.deepEqual(store.list().map((j) => j.label), ['still going']);
  });

  test('active() is exactly the jobs in flight', () => {
    const store = createJobStore({ now: fakeClock().now });
    const a = store.start('edit', 'a');
    store.start('edit', 'b');
    store.finish(a.id, 'done');
    assert.deepEqual(store.active().map((j) => j.label), ['b']);
  });
});

describe('runAsJob owns the outcome so no caller can forget one', () => {
  test('a return value becomes a done job', async () => {
    const store = createJobStore({ now: fakeClock().now });
    const r = await runAsJob(store, 'compile', 'Compile', (job) => {
      job.log('flattening tracks');
      return 42;
    });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.value, 42);
    assert.equal(store.get(r.id)!.status, 'done');
  });

  test('a throw becomes a failed job with the reason in the log', async () => {
    const store = createJobStore({ now: fakeClock().now });
    const r = await runAsJob(store, 'save', 'Save', () => {
      throw new Error('the timeline moved since you read it');
    });
    assert.equal(r.ok, false);
    const j = store.get(r.id)!;
    assert.equal(j.status, 'failed');
    assert.equal(j.error, 'the timeline moved since you read it');
    assert.ok(j.log.some((l) => l.level === 'error'));
  });

  test('a rejected promise is recorded too, not swallowed', async () => {
    const store = createJobStore({ now: fakeClock().now });
    const r = await runAsJob(store, 'import', 'Import', async () => {
      await Promise.resolve();
      throw new Error('upload refused');
    });
    assert.equal(r.ok, false);
    assert.equal(store.get(r.id)!.error, 'upload refused');
  });

  test('a thrown non-Error still produces a readable message', async () => {
    const store = createJobStore({ now: fakeClock().now });
    const r = await runAsJob(store, 'edit', 'x', () => { throw 'just a string'; });
    assert.equal(store.get(r.id)!.error, 'just a string');
  });
});
