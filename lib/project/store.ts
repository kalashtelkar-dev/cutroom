/**
 * Saving and opening a project.
 *
 * The server is the home for a timeline, and it is strict about concurrency
 * in a way worth honouring rather than working around: a write without an
 * `If-Match` is refused with 428, and a stale one with 412. That is the
 * server refusing to let two people silently overwrite each other, so a 412
 * means re-read and reapply, never retry harder.
 *
 * The OTIO document lives under an `otio` key in the response, not at the
 * root. The root carries the id, the name, the revision and the etag.
 */
import type { Timeline } from '../timeline/types.ts';
import { fromOtio, otioRate, toOtio } from '../timeline/otio.ts';
import { RATES, type Rate } from '../time/frames.ts';

export interface SavedProject {
  id: string;
  name: string;
  /** Needed for the next write. Losing it costs a round trip, not data. */
  etag: string;
  revision: number;
  updatedAt?: string;
}

export interface ProjectSummary extends SavedProject {
  trackCount: number;
  clipCount: number;
  durationSec: number;
  targetId?: string;
  width?: number;
  height?: number;
}

export class StaleProjectError extends Error {
  /**
   * Declared and assigned, not a parameter property.
   *
   * `node --test --experimental-strip-types` erases types and compiles
   * nothing, so a parameter property is a syntax error and the whole module
   * is unimportable. That is why this file had no test, and why a default
   * rate of 24fps could quietly conform every project anybody opened.
   */
  readonly id: string;

  constructor(id: string) {
    super('this project changed since you opened it; reopen it and reapply your edits');
    this.name = 'StaleProjectError';
    this.id = id;
  }
}

async function json<T>(res: Response, what: string): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: { message?: string; hint?: string } }).error;
    throw new Error(err?.message ? `${what}: ${err.message}` : `${what}: ${res.status}`);
  }
  return body as T;
}

export interface ProjectTransport {
  create(name: string): Promise<SavedProject>;
  put(id: string, etag: string, name: string, otio: unknown): Promise<SavedProject>;
  get(id: string): Promise<{ project: SavedProject; otio: unknown }>;
  list(): Promise<ProjectSummary[]>;
  delete(id: string): Promise<void>;
  rename(id: string, newName: string): Promise<SavedProject>;
  duplicate(id: string, newName?: string): Promise<SavedProject>;
  listRevisions?(id: string): Promise<Array<{ revision: number; createdAt?: string; name?: string }>>;
  restoreRevision?(id: string, n: number): Promise<SavedProject>;
}

/** Save a project that has never been saved, or one that has. */
export async function saveProject(
  timeline: Timeline,
  saved: SavedProject | null,
  transport: ProjectTransport,
): Promise<{ project: SavedProject; timeline: Timeline }> {
  const home = saved ?? (await transport.create(timeline.name));
  const project = await transport.put(home.id, home.etag, timeline.name, toOtio(timeline));
  return {
    project,
    // carry the server's id, revision and etag back into the document, so the
    // next save is a write rather than a second create
    timeline: { ...timeline, id: project.id, revision: project.revision, etag: project.etag },
  };
}

/**
 * Open a saved project.
 *
 * `projectRate` conforms the document to a rate the caller already works at,
 * frame by frame. Stating one is therefore a decision, and the default used
 * to make it for everybody: 24fps, so a project made at 30 opened at 24 and
 * the frame rate in the new project dialog was a control that did nothing.
 * Unstated, the document's own rate wins.
 */
export async function openProject(
  id: string,
  transport: ProjectTransport,
  projectRate?: Rate,
): Promise<{ project: SavedProject; timeline: Timeline }> {
  const { project, otio } = await transport.get(id);
  const timeline = fromOtio(otio, projectRate ?? otioRate(otio) ?? RATES.film);
  return {
    project,
    timeline: { ...timeline, id: project.id, name: project.name, revision: project.revision, etag: project.etag },
  };
}

import {
  listLocalProjects, getLocalProject, saveLocalProject as saveLocal,
  deleteLocalProject, renameLocalProject, duplicateLocalProject,
} from './localStore.ts';

/** The browser half, going through our own routes and mirroring to local storage. */
export function browserProjects(): ProjectTransport {
  const transport: ProjectTransport = {
    async create(name) {
      try {
        const res = await fetch('/api/timelines', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (res.ok) {
          const remote = await json<SavedProject>(res, 'could not create the project');
          return remote;
        }
      } catch {
        // remote unavailable: proceed with local store
      }
      const local = saveLocal({
        id: `tl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        rate: RATES.film,
        tracks: [],
        markers: [],
        media: {},
        revision: 0,
      }, null);
      return local.project;
    },

    async put(id, etag, name, otio) {
      try {
        const res = await fetch(`/api/timelines/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ etag, name, otio }),
        });
        if (res.status === 412 || res.status === 428) throw new StaleProjectError(id);
        if (res.ok) {
          const remote = await json<SavedProject>(res, 'could not save');
          try {
            // the document's own rate, never a default: this is a SAVE, and
            // reading it back at 24 to mirror it would rescale a 30fps cut
            // into the copy the next open reads
            const doc = fromOtio(otio, otioRate(otio) ?? RATES.film);
            saveLocal(doc, remote);
          } catch {
            // ignore local mirror failure
          }
          return remote;
        }
      } catch (e) {
        if (e instanceof StaleProjectError) throw e;
        // remote unavailable: proceed with local store
      }
      try {
        const doc = fromOtio(otio, otioRate(otio) ?? RATES.film);
        const local = saveLocal(doc, { id, name, etag, revision: 0 });
        return local.project;
      } catch (err) {
        throw new Error(`could not save locally: ${(err as Error).message}`);
      }
    },

    async get(id) {
      try {
        const res = await fetch(`/api/timelines/${encodeURIComponent(id)}?doc=true`);
        if (res.ok) {
          const body = await json<{ timeline: Record<string, unknown> }>(res, 'could not open');
          const t = body.timeline ?? body;
          return {
            project: {
              id: String(t.id), name: String(t.name ?? 'Untitled'),
              etag: String(t.etag ?? ''), revision: Number(t.revision ?? 0),
              updatedAt: t.updatedAt as string | undefined,
            },
            otio: t.otio,
          };
        }
      } catch {
        // remote unavailable: fallback to local store
      }
      const local = getLocalProject(id);
      if (local) {
        return {
          project: local.project,
          otio: toOtio(local.timeline),
        };
      }
      throw new Error(`could not open project ${id}`);
    },

    async list() {
      try {
        const res = await fetch('/api/timelines');
        if (res.ok) {
          const body = await json<{ timelines: ProjectSummary[] }>(res, 'could not list projects');
          const remoteList = body.timelines ?? [];
          const localList = listLocalProjects();
          const seen = new Set(remoteList.map((p) => p.id));
          return [...remoteList, ...localList.filter((p) => !seen.has(p.id))];
        }
      } catch {
        // remote unavailable: fallback to local store
      }
      return listLocalProjects();
    },

    async delete(id) {
      deleteLocalProject(id);
      try {
        await fetch(`/api/timelines/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch {
        // ignore remote delete failure if offline
      }
    },

    async rename(id, newName) {
      renameLocalProject(id, newName);
      try {
        const { project, otio } = await transport.get(id);
        return transport.put(id, project.etag, newName, otio);
      } catch {
        const local = getLocalProject(id);
        if (local) return local.project;
        throw new Error(`could not rename project ${id}`);
      }
    },

    async duplicate(id, newName) {
      const copy = duplicateLocalProject(id, newName);
      if (copy) return copy;
      const { project, otio } = await transport.get(id);
      const copyName = newName || `${project.name} Copy`;
      const created = await transport.create(copyName);
      return transport.put(created.id, created.etag, copyName, otio);
    },

    async listRevisions(id) {
      try {
        const res = await fetch(`/api/timelines/${encodeURIComponent(id)}/revisions`);
        if (res.ok) {
          const body = await json<{ revisions: Array<{ revision: number; createdAt?: string; name?: string }> }>(res, 'could not list revisions');
          return body.revisions ?? [];
        }
      } catch {
        // fallback
      }
      return [];
    },

    async restoreRevision(id, n) {
      const res = await fetch(`/api/timelines/${encodeURIComponent(id)}/restore/${n}`, {
        method: 'POST',
      });
      return json<SavedProject>(res, 'could not restore revision');
    },
  };
  return transport;
}
