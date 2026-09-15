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
import { fromOtio, toOtio } from '../timeline/otio.ts';
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
}

export class StaleProjectError extends Error {
  constructor(readonly id: string) {
    super('this project changed since you opened it; reopen it and reapply your edits');
    this.name = 'StaleProjectError';
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

export async function openProject(
  id: string,
  transport: ProjectTransport,
  projectRate: Rate = RATES.film,
): Promise<{ project: SavedProject; timeline: Timeline }> {
  const { project, otio } = await transport.get(id);
  const timeline = fromOtio(otio, projectRate);
  return {
    project,
    timeline: { ...timeline, id: project.id, name: project.name, revision: project.revision, etag: project.etag },
  };
}

/** The browser half, going through our own routes so the key stays server-side. */
export function browserProjects(): ProjectTransport {
  const transport: ProjectTransport = {
    async create(name) {
      const res = await fetch('/api/timelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      return json<SavedProject>(res, 'could not create the project');
    },

    async put(id, etag, name, otio) {
      const res = await fetch(`/api/timelines/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ etag, name, otio }),
      });
      if (res.status === 412 || res.status === 428) throw new StaleProjectError(id);
      return json<SavedProject>(res, 'could not save');
    },

    async get(id) {
      const res = await fetch(`/api/timelines/${encodeURIComponent(id)}?doc=true`);
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
    },

    async list() {
      const res = await fetch('/api/timelines');
      const body = await json<{ timelines: ProjectSummary[] }>(res, 'could not list projects');
      return body.timelines ?? [];
    },

    async delete(id) {
      const res = await fetch(`/api/timelines/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        await json(res, 'could not delete the project');
      }
    },

    async rename(id, newName) {
      const { project, otio } = await transport.get(id);
      return transport.put(id, project.etag, newName, otio);
    },

    async duplicate(id, newName) {
      const { project, otio } = await transport.get(id);
      const copyName = newName || `${project.name} Copy`;
      const created = await transport.create(copyName);
      return transport.put(created.id, created.etag, copyName, otio);
    },

    async listRevisions(id) {
      const res = await fetch(`/api/timelines/${encodeURIComponent(id)}/revisions`);
      const body = await json<{ revisions: Array<{ revision: number; createdAt?: string; name?: string }> }>(res, 'could not list revisions');
      return body.revisions ?? [];
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
