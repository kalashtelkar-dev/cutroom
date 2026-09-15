/**
 * OTIO in and out.
 *
 * This is the serialization boundary, and the only file besides `frames.ts`
 * allowed to see a `RationalTime`. Everything crossing it goes through
 * `toRationalTime` / `fromRationalTime`, including the times stashed in our
 * own metadata, so a document read back at a different project rate is either
 * conformed exactly or refused: it is never quietly off by a frame.
 *
 * Two things the format does not have, and how they are carried anyway:
 *
 *  - our ids. OTIO items have no id, so `trk_…` / `clp_…` live in
 *    `metadata.editor_api.id`, which is where the editor API puts them too.
 *  - a media pool. OTIO hangs a media_reference off each clip, so media that
 *    no clip uses would vanish on a round trip, and so would the rate of a
 *    source that differs from the project's. Both are written per clip, for
 *    other OTIO tools to read, AND kept whole in the timeline's metadata,
 *    which is the copy `fromOtio` believes.
 *
 * A round trip through this pair is lossless for everything the model
 * represents. What OTIO knows and we do not (a global start time, nested
 * stacks, per-item markers) is not invented on the way out and not preserved
 * on the way back: a foreign document is imported, not mirrored.
 */
import {
  RATES, ZERO, rate as makeRate, rateFps, toRationalTime, fromRationalTime, timeRange,
  type Frames, type Rate, type RationalTime, type TimeRange,
} from '../time/frames.ts';
import type {
  Caption,
  Clip, Effect, Marker, MediaRef, Timeline, Track, TrackItem, TrackKind,
} from './types.ts';

// ── the document shape ──────────────────────────────────────────────────

export interface OtioMetadata {
  editor_api?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OtioRationalTime extends RationalTime {
  OTIO_SCHEMA: 'RationalTime.1';
}

export interface OtioTimeRange {
  OTIO_SCHEMA: 'TimeRange.1';
  start_time: OtioRationalTime;
  duration: OtioRationalTime;
}

export interface OtioEffect {
  OTIO_SCHEMA: 'Effect.1';
  name: string;
  effect_name: string;
  enabled: boolean;
  metadata: OtioMetadata;
}

export interface OtioMediaReference {
  OTIO_SCHEMA: 'ExternalReference.1';
  target_url: string;
  available_range: OtioTimeRange | null;
  metadata: OtioMetadata;
}

export interface OtioClip {
  OTIO_SCHEMA: 'Clip.2';
  name: string;
  source_range: OtioTimeRange;
  media_reference: OtioMediaReference;
  effects: OtioEffect[];
  markers: [];
  enabled: boolean;
  metadata: OtioMetadata;
}

export interface OtioGap {
  OTIO_SCHEMA: 'Gap.1';
  name: string;
  source_range: OtioTimeRange;
  effects: [];
  markers: [];
  metadata: OtioMetadata;
}

export interface OtioTransition {
  OTIO_SCHEMA: 'Transition.1';
  name: string;
  transition_type: string;
  in_offset: OtioRationalTime;
  out_offset: OtioRationalTime;
  metadata: OtioMetadata;
}

export type OtioItem = OtioClip | OtioGap | OtioTransition;

export interface OtioMarker {
  OTIO_SCHEMA: 'Marker.2';
  name: string;
  color: string;
  marked_range: OtioTimeRange;
  metadata: OtioMetadata;
}

export interface OtioTrack {
  OTIO_SCHEMA: 'Track.1';
  name: string;
  /** OTIO's own kinds. Ours, including `subtitle`, is in the metadata. */
  kind: 'Video' | 'Audio';
  children: OtioItem[];
  source_range: null;
  markers: [];
  effects: [];
  enabled: boolean;
  metadata: OtioMetadata;
}

export interface OtioStack {
  OTIO_SCHEMA: 'Stack.1';
  name: string;
  children: OtioTrack[];
  source_range: null;
  markers: OtioMarker[];
  effects: [];
  metadata: OtioMetadata;
}

export interface OtioTimeline {
  OTIO_SCHEMA: 'Timeline.1';
  name: string;
  global_start_time: OtioRationalTime;
  tracks: OtioStack;
  metadata: OtioMetadata;
}

export class OtioError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'OtioError';
    this.path = path;
  }
}

// ── out ─────────────────────────────────────────────────────────────────

const OTIO_KIND: Record<TrackKind, 'Video' | 'Audio'> = {
  video: 'Video',
  audio: 'Audio',
  // OTIO has no subtitle track kind and readers switch on this field, so a
  // subtitle track goes out as video and is recognised again by our metadata
  subtitle: 'Video',
};

export function toOtio(timeline: Timeline): OtioTimeline {
  const rate = timeline.rate;
  const time = (f: Frames): OtioRationalTime =>
    ({ OTIO_SCHEMA: 'RationalTime.1', ...toRationalTime(f, rate) });
  const range = (r: TimeRange): OtioTimeRange =>
    ({ OTIO_SCHEMA: 'TimeRange.1', start_time: time(r.start), duration: time(r.duration) });

  const effect = (e: Effect): OtioEffect => ({
    OTIO_SCHEMA: 'Effect.1',
    name: e.kind,
    effect_name: e.kind,
    enabled: e.enabled,
    metadata: { editor_api: { params: structuredClone(e.params) } },
  });

  const mediaReference = (clip: Clip): OtioMediaReference => {
    const media = timeline.media[clip.mediaKey];
    return {
      OTIO_SCHEMA: 'ExternalReference.1',
      target_url: clip.mediaKey,
      // a clip whose media is not in the pool is a real state (validate.ts
      // reports it); it serialises as a reference with nothing known about it
      available_range: media ? range(media.available) : null,
      metadata: media ? { editor_api: { name: media.name, kind: media.kind } } : {},
    };
  };

  const item = (i: TrackItem): OtioItem => {
    if (i.kind === 'clip') {
      return {
        OTIO_SCHEMA: 'Clip.2',
        name: i.name,
        source_range: range(i.sourceRange),
        media_reference: mediaReference(i),
        effects: i.effects.map(effect),
        markers: [],
        enabled: i.enabled,
        metadata: { editor_api: { id: i.id, mediaKey: i.mediaKey } },
      };
    }
    if (i.kind === 'gap') {
      return {
        OTIO_SCHEMA: 'Gap.1',
        name: '',
        source_range: range(timeRange(ZERO, i.duration)),
        effects: [],
        markers: [],
        metadata: { editor_api: { id: i.id } },
      };
    }
    if (i.kind === 'caption') {
      /**
       * OTIO has no caption. It is written as a Clip with no media and the
       * text in our own metadata, which every other reader will see as an
       * empty clip of the right length rather than as nothing: the timing
       * survives interchange even where the words do not.
       */
      return {
        OTIO_SCHEMA: 'Clip.2',
        name: i.text.slice(0, 60),
        enabled: i.enabled,
        source_range: range(timeRange(ZERO, i.duration)),
        // no file stands behind a caption; the empty url is what every OTIO
        // reader treats as "this clip references nothing"
        media_reference: {
          OTIO_SCHEMA: 'ExternalReference.1',
          target_url: '',
          available_range: null,
          metadata: {},
        },
        effects: [],
        markers: [],
        metadata: {
          editor_api: {
            id: i.id,
            kind: 'caption',
            text: i.text,
            ...(i.style ? { style: i.style } : {}),
          },
        },
      };
    }
    return {
      OTIO_SCHEMA: 'Transition.1',
      name: i.transitionType,
      transition_type: i.transitionType,
      in_offset: time(i.inOffset),
      out_offset: time(i.outOffset),
      metadata: { editor_api: { id: i.id } },
    };
  };

  const track = (t: Track): OtioTrack => ({
    OTIO_SCHEMA: 'Track.1',
    name: t.name,
    kind: OTIO_KIND[t.kind],
    children: t.items.map(item),
    source_range: null,
    markers: [],
    effects: [],
    enabled: t.enabled,
    metadata: {
      editor_api: {
        id: t.id, kind: t.kind, locked: t.locked, muted: t.muted,
        solo: t.solo, autoSelect: t.autoSelect,
      },
    },
  });

  const marker = (m: Marker): OtioMarker => ({
    OTIO_SCHEMA: 'Marker.2',
    name: m.name,
    color: m.colour,
    marked_range: range(timeRange(m.at, ZERO)),
    metadata: { editor_api: { id: m.id } },
  });

  /**
   * The pool, whole.
   *
   * `frames`, `proxy` and the pixel dimensions used to be dropped here, which
   * meant a project survived a save and came back with no thumbnails, no
   * filmstrips and nothing playable: the two things import spends the most
   * time making were the two things the document did not carry. They are
   * object keys rather than urls, so they outlive a signature and are safe to
   * store.
   */
  const media = Object.fromEntries(
    Object.entries(timeline.media).map(([key, m]) => [key, {
      key: m.key,
      name: m.name,
      kind: m.kind,
      available: range(m.available),
      ...(m.rate ? { rate: { num: m.rate.num, den: m.rate.den } } : {}),
      ...(m.frames?.length ? { frames: [...m.frames] } : {}),
      ...(m.proxy ? { proxy: m.proxy } : {}),
      ...(typeof m.width === 'number' ? { width: m.width } : {}),
      ...(typeof m.height === 'number' ? { height: m.height } : {}),
    }]),
  );

  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: timeline.name,
    global_start_time: time(ZERO),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: timeline.tracks.map(track),
      source_range: null,
      markers: timeline.markers.map(marker),
      effects: [],
      metadata: {},
    },
    metadata: {
      editor_api: {
        id: timeline.id,
        revision: timeline.revision,
        rate: { num: rate.num, den: rate.den },
        ...(timeline.etag === undefined ? {} : { etag: timeline.etag }),
        ...(timeline.exportPipelineId ? { exportPipelineId: timeline.exportPipelineId } : {}),
        media,
      },
    },
  };
}

// ── in ──────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function object(v: unknown, path: string): Record<string, unknown> {
  if (!isObject(v)) throw new OtioError(path, `expected an object, got ${describe(v)}`);
  return v;
}

function array(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new OtioError(path, `expected an array, got ${describe(v)}`);
  return v;
}

const describe = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v;

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const editorMeta = (node: Record<string, unknown>): Record<string, unknown> => {
  const meta = isObject(node.metadata) ? node.metadata : {};
  return isObject(meta.editor_api) ? meta.editor_api : {};
};

function readTime(v: unknown, path: string, project: Rate): Frames {
  const rt = object(v, path);
  if (typeof rt.value !== 'number' || typeof rt.rate !== 'number') {
    throw new OtioError(path, 'a RationalTime needs a numeric value and rate');
  }
  try {
    return fromRationalTime({ value: rt.value, rate: rt.rate }, project);
  } catch (err) {
    // the conversion refuses anything that would land off a frame boundary,
    // and the caller needs to know which item in a 400-clip document it was
    throw new OtioError(path, err instanceof Error ? err.message : String(err));
  }
}

function readRange(v: unknown, path: string, project: Rate): TimeRange {
  const tr = object(v, path);
  return timeRange(
    readTime(tr.start_time, `${path}.start_time`, project),
    readTime(tr.duration, `${path}.duration`, project),
  );
}

function readEffect(v: unknown, path: string): Effect {
  const node = object(v, path);
  const meta = editorMeta(node);
  return {
    kind: str(node.effect_name, str(node.name, 'unknown')),
    params: isObject(meta.params) ? structuredClone(meta.params) : {},
    enabled: bool(node.enabled, true),
  };
}

function readItem(v: unknown, path: string, project: Rate, fallbackId: string): TrackItem {
  const node = object(v, path);
  const schema = str(node.OTIO_SCHEMA, '');
  const meta = editorMeta(node);
  const id = str(meta.id, fallbackId);

  if (schema.startsWith('Transition')) {
    return {
      id,
      kind: 'transition',
      transitionType: str(node.transition_type, str(node.name, 'SMPTE_Dissolve')),
      inOffset: node.in_offset === undefined ? ZERO : readTime(node.in_offset, `${path}.in_offset`, project),
      outOffset: node.out_offset === undefined ? ZERO : readTime(node.out_offset, `${path}.out_offset`, project),
    };
  }

  if (schema.startsWith('Gap')) {
    return { id, kind: 'gap', duration: readRange(node.source_range, `${path}.source_range`, project).duration };
  }

  /**
   * A caption is written as a Clip with our own kind in its metadata, so it
   * has to be recognised before the clip reader runs: read as a clip it would
   * become an empty media reference and the words would be gone, which is a
   * silent loss rather than a loud one.
   */
  if (schema.startsWith('Clip') && str(meta.kind, '') === 'caption') {
    const style = isObject(meta.style) ? meta.style as Caption['style'] : undefined;
    return {
      id,
      kind: 'caption',
      text: str(meta.text, str(node.name, '')),
      duration: readRange(node.source_range, `${path}.source_range`, project).duration,
      enabled: bool(node.enabled, true),
      ...(style ? { style } : {}),
    };
  }

  if (!schema.startsWith('Clip')) {
    // Stack, nested timelines, anything else: there is nowhere in the model to
    // put it, and dropping it silently would change the length of the track
    throw new OtioError(path, `unsupported item "${schema || 'unnamed'}"`);
  }

  const ref = isObject(node.media_reference) ? node.media_reference : {};
  return {
    id,
    kind: 'clip',
    name: str(node.name, id),
    mediaKey: str(meta.mediaKey, str(ref.target_url, '')),
    sourceRange: readRange(node.source_range, `${path}.source_range`, project),
    enabled: bool(node.enabled, true),
    effects: array(node.effects ?? [], `${path}.effects`).map((e, i) => readEffect(e, `${path}.effects[${i}]`)),
  };
}

const MEDIA_KIND = new Set(['video', 'audio', 'image']);

function readMediaPool(
  raw: unknown,
  path: string,
  project: Rate,
): Record<string, MediaRef> {
  const pool = object(raw, path);
  const out: Record<string, MediaRef> = {};
  for (const [key, value] of Object.entries(pool)) {
    const entry = object(value, `${path}.${key}`);
    const kind = str(entry.kind, 'video');
    out[key] = {
      key: str(entry.key, key),
      name: str(entry.name, key),
      kind: (MEDIA_KIND.has(kind) ? kind : 'video') as MediaRef['kind'],
      available: readRange(entry.available, `${path}.${key}.available`, project),
      ...(isObject(entry.rate) && typeof entry.rate.num === 'number' && typeof entry.rate.den === 'number'
        ? { rate: { num: entry.rate.num, den: entry.rate.den } }
        : {}),
      // written by import, and worth carrying: without them a reopened
      // project has no thumbnails and nothing that will play
      ...(Array.isArray(entry.frames)
        ? { frames: entry.frames.filter((f): f is string => typeof f === 'string') }
        : {}),
      ...(typeof entry.proxy === 'string' ? { proxy: entry.proxy } : {}),
      ...(typeof entry.width === 'number' ? { width: entry.width } : {}),
      ...(typeof entry.height === 'number' ? { height: entry.height } : {}),
    };
  }
  return out;
}

/** A foreign document has no pool, so one is rebuilt from the references. */
function poolFromClips(
  stack: Record<string, unknown>,
  project: Rate,
): Record<string, MediaRef> {
  const out: Record<string, MediaRef> = {};
  const tracks = array(stack.children ?? [], 'tracks.children');
  tracks.forEach((rawTrack, t) => {
    const track = object(rawTrack, `tracks.children[${t}]`);
    const otioKind = str(track.kind, 'Video');
    array(track.children ?? [], `tracks.children[${t}].children`).forEach((rawItem, i) => {
      const path = `tracks.children[${t}].children[${i}]`;
      const node = object(rawItem, path);
      if (!str(node.OTIO_SCHEMA, '').startsWith('Clip')) return;
      const ref = isObject(node.media_reference) ? node.media_reference : {};
      const key = str(editorMeta(node).mediaKey, str(ref.target_url, ''));
      if (!key || out[key] || ref.available_range == null) return;
      const refMeta = editorMeta(ref);
      const kind = str(refMeta.kind, otioKind === 'Audio' ? 'audio' : 'video');
      out[key] = {
        key,
        name: str(refMeta.name, key.split('/').pop() || key),
        kind: (MEDIA_KIND.has(kind) ? kind : 'video') as MediaRef['kind'],
        available: readRange(ref.available_range, `${path}.media_reference.available_range`, project),
      };
    });
  });
  return out;
}

/**
 * Read an OTIO document at `projectRate`.
 *
 * The caller's rate wins: it is the rate the rest of the application will do
 * arithmetic at, and a document at another rate is conformed to it frame by
 * frame or refused. The schema version is not checked, only the shape, so a
 * document from a newer OTIO that still has the fields we read is readable.
 */
export function fromOtio(doc: unknown, projectRate: Rate): Timeline {
  const root = object(doc, 'document');
  const stack = object(root.tracks, 'tracks');
  const meta = editorMeta(root);

  const tracks: Track[] = array(stack.children ?? [], 'tracks.children').map((rawTrack, t) => {
    const path = `tracks.children[${t}]`;
    const node = object(rawTrack, path);
    const trackMeta = editorMeta(node);
    const id = str(trackMeta.id, `trk_${t + 1}`);
    const kind = str(trackMeta.kind, str(node.kind, 'Video') === 'Audio' ? 'audio' : 'video');
    return {
      id,
      kind: (kind === 'audio' || kind === 'subtitle' ? kind : 'video') as TrackKind,
      name: str(node.name, id),
      items: array(node.children ?? [], `${path}.children`)
        .map((item, i) => readItem(item, `${path}.children[${i}]`, projectRate, `${id}_item_${i + 1}`)),
      locked: bool(trackMeta.locked, false),
      muted: bool(trackMeta.muted, false),
      solo: bool(trackMeta.solo, false),
      enabled: bool(node.enabled, true),
      // an importer that cannot tell gets the safe answer: a track that
      // ripples with everything else, which is what a fresh timeline has
      autoSelect: bool(trackMeta.autoSelect, true),
    };
  });

  const markers: Marker[] = array(stack.markers ?? [], 'tracks.markers').map((raw, i) => {
    const path = `tracks.markers[${i}]`;
    const node = object(raw, path);
    return {
      id: str(editorMeta(node).id, `mrk_${i + 1}`),
      at: readRange(node.marked_range, `${path}.marked_range`, projectRate).start,
      name: str(node.name, ''),
      colour: str(node.color, 'red'),
    };
  });

  /**
   * Markers arrive in file order, which for a foreign document is whatever
   * order they were written in. `insertMarker` assumes the array is sorted by
   * (at, id) and puts a marker back at its sorted index, so on an unsorted
   * document undoing a delete returned the marker to the wrong place and the
   * inverse was not exact. Establishing the invariant here, at the boundary,
   * is cheaper and safer than re-sorting inside every edit.
   */
  markers.sort((a, b) => (a.at - b.at) || a.id.localeCompare(b.id));

  const etag = meta.etag;
  return {
    id: str(meta.id, 'tl_imported'),
    name: str(root.name, 'Timeline'),
    rate: projectRate,
    tracks,
    markers,
    media: meta.media === undefined
      ? poolFromClips(stack, projectRate)
      : readMediaPool(meta.media, 'metadata.editor_api.media', projectRate),
    revision: typeof meta.revision === 'number' ? meta.revision : 0,
    ...(typeof etag === 'string' ? { etag } : {}),
    ...(typeof meta.exportPipelineId === 'string' ? { exportPipelineId: meta.exportPipelineId } : {}),
  };
}

/**
 * A decimal rate read back as the exact rational everyone means by it.
 *
 * OTIO only has the decimal, and 23.976023976023978 is a truncation of
 * 24000/1001 rather than a rate of its own, so the standard rates are matched
 * first. The arithmetic fallback is for a document at a rate no one uses.
 */
function rateFromFps(fps: number): Rate | null {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  const known = Object.values(RATES).find((r) => Math.abs(rateFps(r) - fps) < 1e-3);
  if (known) return { num: known.num, den: known.den };
  try {
    return makeRate(fps);
  } catch {
    return null;
  }
}

/**
 * What a document says its rate is, for offering the user a conform.
 *
 * Answers a `Rate` and not a decimal, so a caller cannot compare two of these
 * and decide that 23.976 and 24000/1001 are different timelines. Our own
 * metadata carries the exact rational and is therefore read first: a clip's
 * `RationalTime.rate` is a double that has already lost that distinction, and
 * scanning for one in a document that declares its rate outright would throw
 * away the only exact thing in the file. The scan is the fallback for a
 * foreign document, which has no such metadata.
 */
export function otioRate(doc: unknown): Rate | null {
  const root = isObject(doc) ? doc : {};
  const meta = isObject(root.metadata) && isObject(root.metadata.editor_api) ? root.metadata.editor_api : {};
  const declared = isObject(meta.rate) ? meta.rate : {};
  if (typeof declared.num === 'number' && typeof declared.den === 'number') {
    try {
      return makeRate(declared.num, declared.den);
    } catch {
      // a rate of 0/1 is not a rate: fall through to what the items say
    }
  }
  const stack = isObject(root.tracks) ? root.tracks : {};
  for (const rawTrack of Array.isArray(stack.children) ? stack.children : []) {
    const track = isObject(rawTrack) ? rawTrack : {};
    for (const rawItem of Array.isArray(track.children) ? track.children : []) {
      const item = isObject(rawItem) ? rawItem : {};
      const range = isObject(item.source_range) ? item.source_range : {};
      const start = isObject(range.start_time) ? range.start_time : {};
      if (typeof start.rate === 'number') return rateFromFps(start.rate);
    }
  }
  return null;
}
