import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mediaKind, probeSeconds, probeDimensions, importFile, proxyBudgetMs, STILL_SECONDS,
  type ImportTransport,
} from '../lib/media/import.ts';
import { createJobStore } from '../lib/jobs/store.ts';
import { applyEdits } from '../lib/timeline/edits.ts';
import { emptyTimeline } from '../lib/timeline/document.ts';
import { RATES } from '../lib/time/frames.ts';

/** A probe result shaped like the real one the API returned during the proof. */
const REAL_PROBE = {
  status: 'succeeded',
  result: {
    format: { format_name: 'mov,mp4', duration: '5.500000', bit_rate: '224900' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 640, height: 360, duration: '5.500000', nb_frames: '132' },
      { codec_type: 'audio', codec_name: 'aac', duration: '5.482000' },
    ],
  },
};

describe('working out what a file is', () => {
  test('the content type decides when the browser gives one', () => {
    assert.equal(mediaKind('video/mp4', 'x.bin'), 'video');
    assert.equal(mediaKind('audio/wav', 'x.bin'), 'audio');
    assert.equal(mediaKind('image/png', 'x.bin'), 'image');
  });

  test('the extension is a real fallback, because browsers often give nothing', () => {
    assert.equal(mediaKind('', 'master.MOV'), 'video');
    assert.equal(mediaKind('', 'vo.WAV'), 'audio');
    assert.equal(mediaKind('application/octet-stream', 'plate.png'), 'image');
  });
});

describe('reading a probe', () => {
  test('finds the duration wherever it is, and takes the longest', () => {
    assert.equal(probeSeconds(REAL_PROBE), 5.5);
  });

  test('reports null rather than a plausible zero when there is none', () => {
    // A clip whose length is fiction makes every cut against it wrong, so
    // "I do not know" has to be expressible.
    assert.equal(probeSeconds({ format: { format_name: 'png' } }), null);
    assert.equal(probeSeconds({ streams: [{ duration: '0' }] }), null);
  });

  test('picks up dimensions and codec from the video stream', () => {
    assert.deepEqual(probeDimensions(REAL_PROBE), { width: 640, height: 360, codec: 'h264' });
  });
});

function fakeFile(name: string, type: string, size = 1024): File {
  return { name, type, size } as unknown as File;
}

function transport(over: Partial<ImportTransport> = {}): ImportTransport {
  return {
    presign: async (filename) => ({ url: 'https://storage.example/put', key: `input/${filename}` }),
    put: async (_u, _f, onProgress) => { onProgress(0.5); onProgress(1); },
    probe: async () => REAL_PROBE,
    ...over,
  };
}

describe('importing a file', () => {
  const store = createJobStore();
  const rate = RATES.film;

  test('produces media whose duration came from the probe, in frames', async () => {
    const job = store.start('import', 'x');
    const r = await importFile(fakeFile('clip.mp4', 'video/mp4'), rate, transport(), job);
    assert.equal(r.media.key, 'input/clip.mp4');
    assert.equal(r.media.kind, 'video');
    // 5.5s at 24fps is 132 frames, which is what the real proof produced
    assert.equal(r.media.available.duration, 132);
    assert.equal(r.media.available.start, 0);
  });

  test('the edit it returns really adds it to the pool', async () => {
    const job = store.start('import', 'x');
    const r = await importFile(fakeFile('clip.mp4', 'video/mp4'), rate, transport(), job);
    const { timeline } = applyEdits(emptyTimeline('t', 'T', rate), [r.op]);
    assert.equal(timeline.media['input/clip.mp4'].name, 'clip.mp4');
  });

  test('and the inverse takes it back out, so an import is one undo', async () => {
    const job = store.start('import', 'x');
    const r = await importFile(fakeFile('clip.mp4', 'video/mp4'), rate, transport(), job);
    const base = emptyTimeline('t', 'T', rate);
    const { timeline, inverse } = applyEdits(base, [r.op]);
    const { timeline: back } = applyEdits(timeline, inverse);
    assert.deepEqual(back.media, {});
  });

  test('a still gets a duration to cut against rather than zero', async () => {
    const job = store.start('import', 'x');
    const r = await importFile(fakeFile('plate.png', 'image/png'), rate, transport(), job);
    assert.equal(r.media.available.duration, STILL_SECONDS * 24);
  });

  test('an unprobeable file fails loudly instead of arriving with a fake length', async () => {
    const job = store.start('import', 'x');
    await assert.rejects(
      importFile(fakeFile('broken.mov', 'video/quicktime'), rate,
        transport({ probe: async () => ({ format: {} }) }), job),
      /reported no duration/,
    );
  });

  test('a refused upload is reported, not swallowed', async () => {
    const job = store.start('import', 'x');
    await assert.rejects(
      importFile(fakeFile('big.mov', 'video/quicktime'), rate,
        transport({ put: async () => { throw new Error('storage refused the upload: 403'); } }), job),
      /403/,
    );
  });

  test('progress is reported while the bytes move, not only at the end', async () => {
    const s = createJobStore();
    const job = s.start('import', 'x');
    await importFile(fakeFile('clip.mp4', 'video/mp4'), rate, transport(), job);
    assert.equal(s.get(job.id)!.progress, 1);
  });

  test('the log says which stage it reached, which is the useful question', async () => {
    const s = createJobStore();
    const job = s.start('import', 'x');
    await importFile(fakeFile('clip.mp4', 'video/mp4'), rate, transport(), job);
    const messages = s.get(job.id)!.log.map((l) => l.message).join('\n');
    assert.match(messages, /video, 0.0 MB/);
    assert.match(messages, /uploaded to input\/clip.mp4/);
    assert.match(messages, /probed: 5.500s, 640x360, h264/);
  });
});

/**
 * Every frame key has to be signable, or it is not a frame.
 *
 * A file uploaded through `POST /v1/uploads` lands under `input/`, and
 * `POST /v1/outputs/sign` refuses those keys: "no asset was recorded for
 * every key given". There is no endpoint anywhere that will sign one. So an
 * `input/` key in `frames` is a picture that can never be fetched, and the UI
 * can only sit on it.
 *
 * This shipped once, for stills, on the reasoning that a still is its own
 * frame. It looks true and is not: the bytes exist but nothing can serve
 * them. The rule is the invariant, not the reasoning.
 */
/**
 * How long to wait for a playable copy.
 *
 * These are not invented numbers. A ten minute video was imported twice and
 * the proxy transcode ran for 203.8s and then 208.9s, succeeding both times,
 * against a wait that was a flat 180s. Both proxies were thrown away while
 * they sat finished in storage, and the clip went into the pool unable to
 * play: pressing play moved the clock and the picture stayed on whichever of
 * eight extracted stills was nearest.
 *
 * So the case the numbers below defend is the exact one that failed.
 */
describe('waiting for a playable copy', () => {
  /** What was actually measured, in seconds of media and seconds of encode. */
  const TEN_MINUTES = 600;
  const MEASURED_MS = 208_874;

  test('the wait that lost a ten minute import would now cover it', () => {
    const budget = proxyBudgetMs(TEN_MINUTES);
    assert.ok(
      budget > MEASURED_MS,
      `${Math.round(budget / 1000)}s is not enough for a transcode measured at ${Math.round(MEASURED_MS / 1000)}s`,
    );
    // and with real margin, because the queue is shared and 209s was one run
    assert.ok(budget > MEASURED_MS * 2, 'a budget with no margin fails the next time the queue is busy');
  });

  test('the old flat wait is exactly what was not enough', () => {
    // the assertion above is only worth anything if 180s would have failed it
    assert.ok(180_000 < MEASURED_MS, 'the measurement no longer describes the bug this fixes');
  });

  test('a short file keeps the wait it already had', () => {
    assert.equal(proxyBudgetMs(5.5), 180_000);
    assert.equal(proxyBudgetMs(0), 180_000);
  });

  test('it grows with the media and then stops', () => {
    assert.ok(proxyBudgetMs(1200) > proxyBudgetMs(600), 'a longer file has to get longer');
    assert.equal(proxyBudgetMs(86_400), 900_000, 'waiting has to stop being reasonable somewhere');
  });

  test('a duration nothing reported does not become a negative wait', () => {
    assert.equal(proxyBudgetMs(-1), 180_000);
  });

  test('the probed duration is what reaches the transport, not a guess', async () => {
    // the budget is only ever right if the length the probe found gets there
    const seen: number[] = [];
    const job = createJobStore().start('import', 'x');
    await importFile(fakeFile('clip.mp4', 'video/mp4'), RATES.film, transport({
      async proxy(_key, _kind, seconds) { seen.push(seconds); return 'output/job/proxy.mp4'; },
    }), job);
    assert.deepEqual(seen, [5.5], 'the transport was not told how long the media is');
  });

  test('a copy that never arrives leaves a clip that still cuts, and says why', async () => {
    const store = createJobStore();
    const job = store.start('import', 'x');
    const r = await importFile(fakeFile('clip.mp4', 'video/mp4'), RATES.film, transport({
      async thumbnails(_key, count) {
        return Array.from({ length: count }, (_, i) => `output/job/frame${i}.jpg`);
      },
      async proxy() { throw new Error('the playable copy was still being made after 180s'); },
    }), job);

    assert.equal(r.media.proxy, undefined, 'no proxy is better than a wrong one');
    assert.ok(r.media.frames?.length, 'and the clip still has frames to show and to cut against');
    const log = store.get(job.id)?.log ?? [];
    assert.ok(log.length, 'a comparison of nothing passes: there has to be a log to read');
    assert.ok(
      log.some((e) => e.level === 'warn' && /no playable copy/.test(e.message)),
      'an import that quietly drops playback is how a frozen viewer gets shipped',
    );
  });
});

describe('frames are keys that can actually be served', () => {
  const store = createJobStore();
  const rate = RATES.film;

  const withThumbs = (calls: { key: string; count: number; kind: string }[]) =>
    transport({
      async thumbnails(key, count, kind) {
        calls.push({ key, count, kind });
        // what the real operations return: something under output/
        return kind === 'image'
          ? ['output/job/resized.png']
          : Array.from({ length: count }, (_, i) => `output/job/frame${i}.jpg`);
      },
    });

  test('a still gets a frame, and it is NOT the uploaded input key', async () => {
    const calls: { key: string; count: number; kind: string }[] = [];
    const job = store.start('import', 'x');
    const r = await importFile(fakeFile('plate.png', 'image/png'), rate, withThumbs(calls), job);

    assert.ok(r.media.frames?.length, 'a still got no frame at all');
    for (const key of r.media.frames ?? []) {
      assert.ok(
        !key.startsWith('input/'),
        `"${key}" is an upload key, which outputs/sign refuses, so it can never be shown`,
      );
      assert.ok(key.startsWith('output/'), `"${key}" is not an output key`);
    }
  });

  test('a still is read by the image operation, not the video one', async () => {
    const calls: { key: string; count: number; kind: string }[] = [];
    const job = store.start('import', 'x');
    await importFile(fakeFile('plate.png', 'image/png'), rate, withThumbs(calls), job);

    assert.equal(calls.length, 1, 'the image path did not ask for a frame');
    assert.equal(calls[0].kind, 'image', 'the transport was not told it is an image');
    assert.equal(calls[0].count, 1, 'a still wants one frame, not eight');
  });

  test('a video still asks for eight frames', async () => {
    const calls: { key: string; count: number; kind: string }[] = [];
    const job = store.start('import', 'x');
    const r = await importFile(fakeFile('clip.mp4', 'video/mp4'), rate, withThumbs(calls), job);

    assert.equal(calls[0].kind, 'video');
    assert.equal(calls[0].count, 8);
    assert.equal(r.media.frames?.length, 8);
  });

  test('audio asks for no frames, because there is nothing to see', async () => {
    const calls: { key: string; count: number; kind: string }[] = [];
    const job = store.start('import', 'x');
    const r = await importFile(fakeFile('vo.wav', 'audio/wav'), rate, withThumbs(calls), job);

    assert.deepEqual(calls, []);
    assert.deepEqual(r.media.frames, []);
  });

  test('an extraction that fails leaves frames EMPTY, never a plausible key', async () => {
    const job = store.start('import', 'x');
    const r = await importFile(
      fakeFile('plate.png', 'image/png'), rate,
      transport({ thumbnails: async () => { throw new Error('imagemagick/resize failed'); } }),
      job,
    );
    assert.deepEqual(r.media.frames, [], 'it invented a key when extraction failed');
  });
});
