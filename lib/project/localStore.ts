/**
 * Local storage project manager.
 *
 * Stores projects in browser localStorage so projects survive refreshes,
 * tab closures, and work offline without requiring remote credentials.
 */

import type { Timeline } from '../timeline/types.ts';
import { fromOtio, otioRate, toOtio } from '../timeline/otio.ts';
import { RATES, type Rate, framesToSeconds } from '../time/frames.ts';
import { timelineDuration } from '../timeline/document.ts';
import type { SavedProject, ProjectSummary } from './store.ts';

const MANIFEST_KEY = 'cutroom.projects.manifest.v1';
const PROJECT_PREFIX = 'cutroom.project.';

interface StoredProjectRecord {
  id: string;
  name: string;
  etag: string;
  revision: number;
  updatedAt: string;
  targetId?: string;
  width?: number;
  height?: number;
  otio: unknown;
}

function getStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function listLocalProjects(): ProjectSummary[] {
  const store = getStorage();
  if (!store) return [];
  try {
    const raw = store.getItem(MANIFEST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ProjectSummary[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeManifest(store: Storage, list: ProjectSummary[]): void {
  try {
    store.setItem(MANIFEST_KEY, JSON.stringify(list));
  } catch {
    // quota exceeded or storage disabled
  }
}

/**
 * Read a project back.
 *
 * `rate` is a conform, not a default: `fromOtio` rescales every position into
 * the rate it is handed, so passing one means "open this document at my
 * rate". Almost nobody wants that, and everybody used to get it, because the
 * parameter defaulted to 24fps. A project made at 30 came back at 24, which
 * is how picking a frame rate in the new project dialog did nothing at all.
 * With no rate stated the document's own wins: `otioRate` reads the exact
 * rational we wrote into its metadata.
 */
export function getLocalProject(
  id: string,
  rate?: Rate,
): { project: SavedProject; timeline: Timeline } | null {
  const store = getStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(`${PROJECT_PREFIX}${id}`);
    if (!raw) return null;
    const record = JSON.parse(raw) as StoredProjectRecord;
    const timeline = fromOtio(record.otio, rate ?? otioRate(record.otio) ?? RATES.film);
    const restoredTimeline: Timeline = {
      ...timeline,
      id: record.id,
      name: record.name,
      revision: record.revision,
      etag: record.etag,
      targetId: record.targetId ?? timeline.targetId,
      width: record.width ?? timeline.width,
      height: record.height ?? timeline.height,
    };
    const project: SavedProject = {
      id: record.id,
      name: record.name,
      etag: record.etag,
      revision: record.revision,
      updatedAt: record.updatedAt,
    };
    return { project, timeline: restoredTimeline };
  } catch {
    return null;
  }
}

export function saveLocalProject(
  timeline: Timeline,
  saved: SavedProject | null,
): { project: SavedProject; timeline: Timeline } {
  const store = getStorage();
  const id = saved?.id || timeline.id || `tl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const revision = (saved?.revision ?? timeline.revision ?? 0) + 1;
  const etag = `tag_${revision}_${Date.now()}`;
  const now = new Date().toISOString();

  const project: SavedProject = {
    id,
    name: timeline.name,
    etag,
    revision,
    updatedAt: now,
  };

  const updatedTimeline: Timeline = {
    ...timeline,
    id,
    revision,
    etag,
  };

  const record: StoredProjectRecord = {
    id,
    name: timeline.name,
    etag,
    revision,
    updatedAt: now,
    targetId: timeline.targetId,
    width: timeline.width,
    height: timeline.height,
    otio: toOtio(updatedTimeline),
  };

  if (store) {
    try {
      store.setItem(`${PROJECT_PREFIX}${id}`, JSON.stringify(record));
      const manifest = listLocalProjects().filter((p) => p.id !== id);
      const clips = updatedTimeline.tracks.reduce(
        (n, t) => n + t.items.filter((i) => i.kind === 'clip').length, 0,
      );
      const dur = framesToSeconds(timelineDuration(updatedTimeline), updatedTimeline.rate);
      const summary: ProjectSummary = {
        ...project,
        trackCount: updatedTimeline.tracks.length,
        clipCount: clips,
        durationSec: dur,
        targetId: updatedTimeline.targetId,
        width: updatedTimeline.width,
        height: updatedTimeline.height,
      };
      manifest.unshift(summary);
      writeManifest(store, manifest);
    } catch {
      // quota exceeded
    }
  }

  return { project, timeline: updatedTimeline };
}

export function deleteLocalProject(id: string): void {
  const store = getStorage();
  if (!store) return;
  try {
    store.removeItem(`${PROJECT_PREFIX}${id}`);
    const manifest = listLocalProjects().filter((p) => p.id !== id);
    writeManifest(store, manifest);
  } catch {
    // ignore
  }
}

export function renameLocalProject(id: string, newName: string): SavedProject | null {
  const existing = getLocalProject(id);
  if (!existing) return null;
  const updatedDoc: Timeline = { ...existing.timeline, name: newName };
  return saveLocalProject(updatedDoc, existing.project).project;
}

export function duplicateLocalProject(id: string, newName?: string): SavedProject | null {
  const existing = getLocalProject(id);
  if (!existing) return null;
  const copyName = newName || `${existing.project.name} Copy`;
  const copyDoc: Timeline = {
    ...existing.timeline,
    id: `tl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: copyName,
  };
  return saveLocalProject(copyDoc, null).project;
}

