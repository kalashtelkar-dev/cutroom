/**
 * What survives the tab closing.
 *
 * The server is the home for a project, but it is a home you have to ask for:
 * nothing reaches it until Save. Between those moments the whole document
 * lived in React state, so a refresh, a crash or a stray navigation threw
 * away everything since the last save, including the imports, which are the
 * slowest thing in the app to redo.
 *
 * This is not a second source of truth. It is the same OTIO document the
 * server stores, written to the browser instead, and read back through the
 * same reader. That matters: `fromOtio` is strict and tested, so a snapshot
 * written by an older build fails loudly with a path into the document
 * rather than half-loading and leaving the editor holding a document with
 * pieces missing.
 */
import { fromOtio, toOtio } from '../timeline/otio.ts';
import type { Timeline } from '../timeline/types.ts';
import { RATES, type Rate } from '../time/frames.ts';
import type { SavedProject } from './store.ts';

/** Bumped when the shape changes. An older key is dropped, never guessed at. */
export const SESSION_VERSION = 1;
export const SESSION_KEY = `cutroom.session.v${SESSION_VERSION}`;

export interface SessionState {
  timeline: Timeline;
  /** Where it lives on the server, if it has been saved at all. */
  project: SavedProject | null;
  /** Whether there is work here the server has not seen. */
  dirty: boolean;
  /** The pipeline export reuses, so a second session does not leave a second. */
  pipelineId: string | null;
  playhead: number;
}

export interface SessionSnapshot {
  version: number;
  savedAt: string;
  rate: Rate;
  project: SavedProject | null;
  dirty: boolean;
  pipelineId: string | null;
  playhead: number;
  otio: unknown;
}

/** Only the three methods used, so a test can pass an object literal. */
export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function toSnapshot(state: SessionState, now = new Date().toISOString()): SessionSnapshot {
  return {
    version: SESSION_VERSION,
    savedAt: now,
    rate: { num: state.timeline.rate.num, den: state.timeline.rate.den },
    project: state.project,
    dirty: state.dirty,
    pipelineId: state.pipelineId,
    playhead: Math.max(0, Math.round(state.playhead)),
    otio: toOtio(state.timeline),
  };
}

function readProject(raw: unknown): SavedProject | null {
  if (raw === null || raw === undefined) return null;
  if (!isObject(raw)) throw new SessionError('the saved project reference is not an object');
  if (typeof raw.id !== 'string' || !raw.id) {
    throw new SessionError('the saved project reference has no id');
  }
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : 'Untitled',
    etag: typeof raw.etag === 'string' ? raw.etag : '',
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
  };
}

function readRate(raw: unknown, fallback: Rate): Rate {
  if (!isObject(raw)) return fallback;
  const { num, den } = raw;
  if (typeof num !== 'number' || typeof den !== 'number' || num <= 0 || den <= 0) return fallback;
  return { num, den };
}

/**
 * A snapshot back into state. Throws `SessionError` or `OtioError`, both of
 * which carry a reason worth showing, rather than returning a half-document.
 */
export function fromSnapshot(raw: unknown, fallbackRate: Rate = RATES.film): SessionState {
  if (!isObject(raw)) throw new SessionError('the stored session is not an object');
  if (raw.version !== SESSION_VERSION) {
    throw new SessionError(`this session was written by another version of the editor (${String(raw.version)})`);
  }
  if (raw.otio === undefined || raw.otio === null) {
    throw new SessionError('the stored session has no document in it');
  }

  const project = readProject(raw.project);
  const rate = readRate(raw.rate, fallbackRate);
  const base = fromOtio(raw.otio, rate);

  // the server's id, revision and etag are authoritative over whatever the
  // document carried, exactly as in `openProject`
  const timeline: Timeline = project
    ? { ...base, id: project.id, revision: project.revision, etag: project.etag }
    : base;

  const playhead = typeof raw.playhead === 'number' && Number.isFinite(raw.playhead)
    ? Math.max(0, Math.round(raw.playhead))
    : 0;

  return {
    timeline,
    project,
    dirty: raw.dirty === true,
    pipelineId: typeof raw.pipelineId === 'string' ? raw.pipelineId : null,
    playhead,
  };
}

export type ReadResult =
  | { found: false }
  | { found: true; ok: true; state: SessionState; savedAt: string }
  | { found: true; ok: false; reason: string };

/**
 * Read what is there. An unreadable snapshot is reported, not thrown and not
 * silently swallowed: the editor still opens, and the person is told why the
 * work they expected to see is not in front of them.
 */
export function readSession(store: SessionStore, fallbackRate: Rate = RATES.film): ReadResult {
  let text: string | null;
  try {
    text = store.getItem(SESSION_KEY);
  } catch (e) {
    return { found: true, ok: false, reason: (e as Error).message };
  }
  if (!text) return { found: false };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { found: true, ok: false, reason: 'the stored session is not valid JSON' };
  }

  try {
    const state = fromSnapshot(raw, fallbackRate);
    const savedAt = isObject(raw) && typeof raw.savedAt === 'string' ? raw.savedAt : '';
    return { found: true, ok: true, state, savedAt };
  } catch (e) {
    return { found: true, ok: false, reason: (e as Error).message };
  }
}

export type WriteResult = { ok: true; bytes: number } | { ok: false; reason: string };

/**
 * Write, and say so if it did not happen.
 *
 * `setItem` throws when the quota is full, and a storage that silently stops
 * accepting writes is the worst version of this feature: it looks saved and
 * is not. The caller gets the failure and can say it out loud once.
 */
export function writeSession(
  store: SessionStore,
  state: SessionState,
  now?: string,
): WriteResult {
  let text: string;
  try {
    text = JSON.stringify(toSnapshot(state, now));
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  try {
    store.setItem(SESSION_KEY, text);
    return { ok: true, bytes: text.length };
  } catch (e) {
    const err = e as Error;
    const full = /quota|exceeded/i.test(err.name + err.message);
    return {
      ok: false,
      reason: full
        ? 'this browser has no room left to keep a copy of the project. Save it to the server.'
        : err.message,
    };
  }
}

export function clearSession(store: SessionStore): void {
  try {
    store.removeItem(SESSION_KEY);
  } catch {
    // a storage that will not forget is not worth crashing the editor over
  }
}

/**
 * The browser's own, or null where there is none: Safari in private mode
 * throws on the property itself, so even reaching for it is guarded.
 */
export function browserSession(): SessionStore | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    // prove it accepts a write before anything depends on it
    const probe = `${SESSION_KEY}.probe`;
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}
