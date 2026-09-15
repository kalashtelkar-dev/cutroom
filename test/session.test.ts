/**
 * Persistence, and the reasons it is allowed to refuse.
 *
 * The point of these is not that a document round trips. It is that an
 * unreadable one is *reported*: a session store that silently loses work, or
 * silently half-loads it, is worse than none, because the editor then looks
 * like it kept your project and did not.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RATES, frames, timeRange, type Rate } from '../lib/time/frames.ts';
import { emptyTimeline } from '../lib/timeline/document.ts';
import { applyEdits } from '../lib/timeline/edits.ts';
import type { MediaRef, Timeline } from '../lib/timeline/types.ts';
import {
  SESSION_KEY, SESSION_VERSION, SessionError, browserSession, clearSession, fromSnapshot,
  readSession, toSnapshot, writeSession, type SessionState, type SessionStore,
} from '../lib/project/session.ts';
import { openProject, type ProjectTransport } from '../lib/project/store.ts';
import { toOtio } from '../lib/timeline/otio.ts';

const R = RATES.film;
const f = frames;

/** A storage double that can be told to fail, because a real one does. */
function fakeStore(opts: { full?: boolean; blind?: boolean } = {}): SessionStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem(k) {
      if (opts.blind) throw new Error('storage is disabled in this browser');
      return data.get(k) ?? null;
    },
    setItem(k, v) {
      if (opts.full) {
        const e = new Error('The quota has been exceeded.');
        e.name = 'QuotaExceededError';
        throw e;
      }
      data.set(k, v);
    },
    removeItem(k) { data.delete(k); },
  };
}

/** A pool entry with everything import actually writes onto one. */
const rich = (key: string): MediaRef => ({
  key,
  name: key.split('/').pop() ?? key,
  kind: 'video',
  available: timeRange(f(0), f(240)),
  rate: R,
  frames: [`output/${key}-0.jpg`, `output/${key}-1.jpg`, `output/${key}-2.jpg`],
  proxy: `output/${key}-proxy.mp4`,
  width: 1920,
  height: 1080,
});

function project(): Timeline {
  const empty = emptyTimeline('tl_1', 'A cut', R);
  const { timeline } = applyEdits(empty, [
    { op: 'add_media', media: rich('input/a.mp4') },
    {
      op: 'add_clip',
      trackId: 'trk_v1',
      at: f(0),
      clip: {
        id: 'clp_a', kind: 'clip', name: 'a', mediaKey: 'input/a.mp4',
        sourceRange: timeRange(f(10), f(72)), enabled: true, effects: [],
      },
    },
  ]);
  return timeline;
}

const state = (over: Partial<SessionState> = {}): SessionState => ({
  timeline: project(),
  project: null,
  dirty: true,
  pipelineId: null,
  playhead: 0,
  ...over,
});

describe('session snapshots', () => {
  test('a document comes back the same, pool and all', () => {
    const before = state();
    const back = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(before))), R);
    assert.deepEqual(back.timeline, before.timeline);
  });

  test('the thumbnails and the proxy survive, which is the whole point', () => {
    // a project that comes back with an empty pool thumbnail and nothing
    // playable has not been restored, it has been re-imported by hand
    const back = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(state()))), R);
    const m = back.timeline.media['input/a.mp4'];
    assert.equal(m.proxy, 'output/input/a.mp4-proxy.mp4');
    assert.equal(m.frames?.length, 3);
    assert.equal(m.width, 1920);
    assert.equal(m.height, 1080);
  });

  test('the rate travels with the snapshot, not with the reader', () => {
    const pal = emptyTimeline('tl_p', 'PAL', RATES.pal);
    const back = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(state({ timeline: pal })))), RATES.film);
    assert.deepEqual(back.timeline.rate, RATES.pal);
  });

  test('the server reference wins over what the document carried', () => {
    const snap = toSnapshot(state({
      project: { id: 'tl_server', name: 'On the server', etag: 'W/"9"', revision: 9 },
    }));
    const back = fromSnapshot(JSON.parse(JSON.stringify(snap)), R);
    assert.equal(back.timeline.id, 'tl_server');
    assert.equal(back.timeline.revision, 9);
    assert.equal(back.timeline.etag, 'W/"9"');
    assert.equal(back.project?.id, 'tl_server');
  });

  test('the playhead is an integer frame, whatever was stored', () => {
    const snap = { ...toSnapshot(state()), playhead: 12.7 };
    assert.equal(fromSnapshot(JSON.parse(JSON.stringify(snap)), R).playhead, 13);
    const neg = { ...toSnapshot(state()), playhead: -4 };
    assert.equal(fromSnapshot(JSON.parse(JSON.stringify(neg)), R).playhead, 0);
  });

  test('a snapshot from another version is refused, not guessed at', () => {
    const snap = { ...toSnapshot(state()), version: SESSION_VERSION + 1 };
    assert.throws(() => fromSnapshot(snap, R), (e: unknown) => e instanceof SessionError);
  });

  test('a snapshot with no document in it is refused', () => {
    const { otio, ...rest } = toSnapshot(state());
    assert.ok(otio);
    assert.throws(() => fromSnapshot(rest, R), (e: unknown) => e instanceof SessionError);
  });

  test('a corrupt document fails with the path to what is wrong', () => {
    const snap = { ...toSnapshot(state()), otio: { OTIO_SCHEMA: 'Timeline.1', tracks: { children: 'not an array' } } };
    assert.throws(() => fromSnapshot(snap, R), (e: unknown) => /tracks\.children/.test((e as Error).message));
  });
});

describe('session storage', () => {
  test('written then read is the same state', () => {
    const store = fakeStore();
    const before = state({ pipelineId: 'tpl_abc', playhead: 48 });
    const w = writeSession(store, before);
    assert.equal(w.ok, true);

    const r = readSession(store, R);
    assert.equal(r.found, true);
    assert.ok(r.found && r.ok);
    if (!r.found || !r.ok) return;
    assert.deepEqual(r.state.timeline, before.timeline);
    assert.equal(r.state.pipelineId, 'tpl_abc');
    assert.equal(r.state.playhead, 48);
    assert.equal(r.state.dirty, true);
  });

  test('nothing stored is "nothing", not an error', () => {
    assert.deepEqual(readSession(fakeStore(), R), { found: false });
  });

  test('a full quota is reported, never swallowed', () => {
    const r = writeSession(fakeStore({ full: true }), state());
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /no room|Save it to the server/);
  });

  test('a storage that throws on read is reported too', () => {
    const r = readSession(fakeStore({ blind: true }), R);
    assert.equal(r.found, true);
    assert.ok(r.found && !r.ok);
  });

  test('garbage in storage is reported and does not throw', () => {
    const store = fakeStore();
    store.data.set(SESSION_KEY, '{not json');
    const r = readSession(store, R);
    assert.ok(r.found && !r.ok);
    if (!r.found || r.ok) return;
    assert.match(r.reason, /valid JSON/);
  });

  test('clearing means the next read finds nothing', () => {
    const store = fakeStore();
    writeSession(store, state());
    assert.equal(store.data.size, 1);
    clearSession(store);
    assert.deepEqual(readSession(store, R), { found: false });
  });

  test('no localStorage means no session store, not a crash', () => {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    assert.equal(browserSession(), had ? browserSession() : null);
  });
});

// ── the rate a project opens at ─────────────────────────────────────────
// `fromOtio` rescales every position into the rate it is handed, so a rate
// passed to a reader is a conform and not a default. Every reader defaulted
// to 24fps, which is how the frame rate in the new project dialog came to be
// a control that did nothing: a project made at 30 was saved at 30, reopened
// at 24, and the number in the corner said 24.

describe('a project opens at the rate it was made at', () => {
  const at = (rate: Rate): Timeline => {
    const empty = emptyTimeline('tl_r', 'Thirty', rate);
    const { timeline } = applyEdits(empty, [
      { op: 'add_media', media: { ...rich('input/a.mp4'), rate } },
      {
        op: 'add_clip',
        trackId: 'trk_v1',
        at: f(0),
        clip: {
          id: 'clp_a', kind: 'clip', name: 'a', mediaKey: 'input/a.mp4',
          sourceRange: timeRange(f(30), f(90)), enabled: true, effects: [],
        },
      },
    ]);
    return timeline;
  };

  /** A transport that hands back exactly what was put into it. */
  const shelf = (doc: Timeline): ProjectTransport => {
    const otio = JSON.parse(JSON.stringify(toOtio(doc)));
    const saved = { id: doc.id, name: doc.name, etag: 'tag_1', revision: 1 };
    return {
      list: async () => [{ ...saved, trackCount: doc.tracks.length, clipCount: 1, durationSec: 0 }],
      create: async () => saved,
      get: async () => ({ project: saved, otio }),
      put: async () => saved,
      delete: async () => {},
      rename: async () => saved,
      duplicate: async () => saved,
    };
  };

  test('a 30fps cut comes back at 30, with its positions where they were', async () => {
    const made = at(RATES.web);
    const r = await openProject('tl_r', shelf(made));
    assert.deepEqual(r.timeline.rate, RATES.web, '24fps here is the bug this is for');
    const clip = r.timeline.tracks.find((t) => t.id === 'trk_v1')?.items[0];
    assert.ok(clip && clip.kind === 'clip');
    assert.deepEqual(clip.sourceRange, timeRange(f(30), f(90)),
      'conforming 30fps to 24 moves every frame position, silently',
    );
  });

  test('the exact rationals survive, so 23.976 is not 24', async () => {
    const r = await openProject('tl_r', shelf(at(RATES.ntscFilm)));
    assert.deepEqual(r.timeline.rate, RATES.ntscFilm);
  });

  test('a caller that states a rate still gets the conform it asked for', async () => {
    // the parameter is not dead: it is how a document at another rate is
    // brought into a project already running at this one
    const r = await openProject('tl_r', shelf(at(RATES.web)), RATES.film);
    assert.deepEqual(r.timeline.rate, RATES.film);
  });
});
