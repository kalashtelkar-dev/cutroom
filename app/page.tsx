'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { browserProjects, type ProjectSummary } from '@/lib/project/store.ts';
import { NewProjectDialog, type TargetChoice } from '@/components/shell/NewProjectDialog.tsx';
import { emptyTimeline } from '@/lib/timeline/document.ts';
import { saveLocalProject } from '@/lib/project/localStore.ts';
import { TARGETS, targetFor, type ExportTarget } from '@/lib/export/targets.ts';
import { getTemplate } from '@/lib/timeline/templates.ts';
import type { Rate } from '@/lib/time/frames.ts';

export default function ProjectsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);

  const notify = useCallback((msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification((cur) => (cur === msg ? null : cur)), 3000);
  }, []);

  const refreshList = useCallback(async () => {
    // Dev helper: visit /?clear to wipe stored projects and preview the empty state.
    if (searchParams.has('clear')) {
      try {
        const keys = Object.keys(localStorage).filter(
          (k) => k.startsWith('cutroom.project.') || k === 'cutroom.projects.manifest.v1',
        );
        for (const k of keys) localStorage.removeItem(k);
      } catch { /* ignore */ }
      setProjects([]);
      setLoading(false);
      return;
    }
    try {
      const list = await browserProjects().list();
      setProjects(list);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [searchParams]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const handleCreateProject = useCallback((
    name: string,
    rate: Rate,
    templateId: string,
    target: TargetChoice,
  ) => {
    const id = `tl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const newDoc = emptyTimeline(id, name, rate, templateId, {
      targetId: target.targetId,
      width: target.width,
      height: target.height,
    });
    saveLocalProject(newDoc, null);
    notify(`Created project "${name}" with ${getTemplate(templateId).name} layout`);
    router.push(`/edit?project=${encodeURIComponent(id)}`);
  }, [notify, router]);

  const handleOpenProject = useCallback((id: string) => {
    router.push(`/edit?project=${encodeURIComponent(id)}`);
  }, [router]);

  const handleDeleteProject = useCallback(async (id: string, name: string) => {
    if (!window.confirm(`Delete project "${name}"? This cannot be undone.`)) return;
    try {
      await browserProjects().delete(id);
      notify(`Deleted "${name}"`);
      await refreshList();
    } catch (e) {
      notify(`Could not delete: ${(e as Error).message}`);
    }
  }, [refreshList, notify]);

  const handleRenameProject = useCallback(async (id: string, currentName: string) => {
    const nextName = window.prompt('Rename project to:', currentName);
    if (!nextName || nextName.trim() === '' || nextName === currentName) return;
    try {
      await browserProjects().rename(id, nextName.trim());
      notify(`Renamed to "${nextName.trim()}"`);
      await refreshList();
    } catch (e) {
      notify(`Could not rename: ${(e as Error).message}`);
    }
  }, [refreshList, notify]);

  const handleDuplicateProject = useCallback(async (id: string, name: string) => {
    try {
      const copy = await browserProjects().duplicate(id, `${name} Copy`);
      notify(`Duplicated "${copy.name}"`);
      await refreshList();
    } catch (e) {
      notify(`Could not duplicate: ${(e as Error).message}`);
    }
  }, [refreshList, notify]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, query]);

  return (
    <>
      <style href="cutroom-projects-page" precedence="medium">{CSS}</style>
      <div className="cr-gallery-wrap">
        <header className="cr-gallery-head">
          <div />

          <div className="cr-head-actions">
            <div className="cr-search-box">
              <svg viewBox="0 0 16 16" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <circle cx="6.5" cy="6.5" r="4.5" />
                <path d="M10 10l4 4" strokeLinecap="round" />
              </svg>
              <input
                type="text"
                placeholder="Search projects..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query ? (
                <button type="button" onClick={() => setQuery('')} aria-label="Clear search">✕</button>
              ) : null}
            </div>

            <a href="/workbench" className="cr-wb-link" title="Open workbench and diagnostics">
              Workbench
            </a>
          </div>
        </header>

        <main className="cr-gallery-main">
          <div className="cr-gallery-title-row">
            <div>
              <h1 className="cr-gallery-title">Projects</h1>
              <p className="cr-gallery-sub">
                {projects.length} {projects.length === 1 ? 'project' : 'projects'} stored
              </p>
            </div>
          </div>

          {loading ? (
            <div className="cr-empty-state">
              <span className="cr-loading-spinner" />
              <p>Loading projects...</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="cr-empty-state">
              {query ? (
                <>
                  <p className="cr-empty-hdr">No matching projects</p>
                  <p className="cr-empty-msg">No projects match the search query &quot;{query}&quot;.</p>
                  <button type="button" className="cr-ghost-btn" onClick={() => setQuery('')}>
                    Clear search
                  </button>
                </>
              ) : (
                <>
                  <div className="cr-empty-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width={32} height={32} fill="none" stroke="currentColor" strokeWidth={1.4}>
                      <rect x="2" y="4" width="20" height="16" rx="3" />
                      <path d="M7 4v16M17 4v16M2 12h20" />
                    </svg>
                  </div>
                  <p className="cr-empty-hdr">No projects yet</p>
                  <p className="cr-empty-msg">
                    Create a new project below to start cutting footage, adding B-roll, and generating captions.
                  </p>
                  <button
                    type="button"
                    className="cr-create-btn-inline"
                    onClick={() => setNewProjectOpen(true)}
                  >
                    + Create new project
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="cr-cards-grid">
              {filtered.map((project) => {
                const target: ExportTarget = (project.targetId && TARGETS.find((t) => t.id === project.targetId))
                  || (project.width && project.height && targetFor(project.width, project.height))
                  || TARGETS[0];
                const isVertical = target.shape === 'vertical';
                const isSquare = target.shape === 'square';
                const aspectStr = isVertical ? '9 / 16' : isSquare ? '1 / 1' : '16 / 9';

                return (
                  <div
                    key={project.id}
                    className="cr-proj-card"
                    onClick={() => handleOpenProject(project.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleOpenProject(project.id);
                      }
                    }}
                  >
                    <div className="cr-card-thumb-stage">
                      <div
                        className="cr-card-preview-box"
                        style={{ aspectRatio: aspectStr }}
                      >
                        <span className="cr-preview-target-tag">{target.name}</span>
                        <span className="cr-preview-size-tag">
                          {project.width && project.height ? `${project.width}x${project.height}` : `${target.width}x${target.height}`}
                        </span>
                        <div className="cr-preview-play-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24" width={22} height={22} fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </div>
                      </div>
                    </div>

                    <div className="cr-card-body">
                      <div className="cr-card-title-row">
                        <span className="cr-card-name" title={project.name}>{project.name}</span>
                        <span className="cr-card-rev">rev {project.revision}</span>
                      </div>

                      <div className="cr-card-meta">
                        <span>{project.clipCount} {project.clipCount === 1 ? 'clip' : 'clips'}</span>
                        <span className="cr-dot" />
                        <span>{project.durationSec ? `${project.durationSec.toFixed(1)}s` : '0.0s'}</span>
                        {project.updatedAt ? (
                          <>
                            <span className="cr-dot" />
                            <span>{new Date(project.updatedAt).toLocaleDateString()}</span>
                          </>
                        ) : null}
                      </div>

                      <div className="cr-card-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="cr-act-btn pri"
                          onClick={() => handleOpenProject(project.id)}
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          className="cr-act-btn"
                          title="Rename project"
                          onClick={() => void handleRenameProject(project.id, project.name)}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="cr-act-btn"
                          title="Duplicate project"
                          onClick={() => void handleDuplicateProject(project.id, project.name)}
                        >
                          Duplicate
                        </button>
                        <button
                          type="button"
                          className="cr-act-btn del"
                          title="Delete project"
                          onClick={() => void handleDeleteProject(project.id, project.name)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>

        <div className="cr-bottom-bar">
          <button
            type="button"
            className="cr-create-project-btn"
            onClick={() => setNewProjectOpen(true)}
          >
            <svg viewBox="0 0 16 16" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
            Create new project
          </button>
        </div>

        <NewProjectDialog
          open={newProjectOpen}
          onClose={() => setNewProjectOpen(false)}
          onCreate={handleCreateProject}
        />

        {notification ? <div className="cr-toast">{notification}</div> : null}
      </div>
    </>
  );
}

const CSS = `
.cr-gallery-wrap{
  min-height:100vh;display:flex;flex-direction:column;background:var(--app);
  color:var(--t1);font-family:var(--ui);padding-bottom:90px;position:relative;
}
.cr-gallery-head{
  height:48px;border-bottom:1px solid var(--edge);background:var(--head);
  display:flex;align-items:center;justify-content:space-between;padding:0 24px;
  position:sticky;top:0;z-index:20;box-shadow:var(--sink);
}
.cr-brand{display:flex;align-items:center;gap:9px}
.cr-brand-mark{
  width:16px;height:16px;border-radius:3px;
  background:linear-gradient(135deg, var(--orange), #b81414);flex-shrink:0;
}
.cr-brand-name{font-size:14px;font-weight:700;letter-spacing:-0.02em;color:var(--t1)}
.cr-brand-badge{
  font-size:10px;font-weight:600;padding:2px 7px;border-radius:3px;
  background:var(--panel-2);color:var(--t3);border:1px solid var(--edge-soft);
  text-transform:uppercase;letter-spacing:0.04em;
}
.cr-head-actions{display:flex;align-items:center;gap:12px}
.cr-search-box{
  display:flex;align-items:center;gap:7px;background:var(--app);
  border:1px solid var(--edge-soft);border-radius:5px;padding:4px 9px;
  color:var(--t2);width:220px;transition:border-color .15s;
}
.cr-search-box:focus-within{border-color:var(--orange);color:var(--t1)}
.cr-search-box input{
  background:none;border:0;color:inherit;font:inherit;font-size:12px;
  width:100%;outline:none;
}
.cr-search-box button{
  background:none;border:0;color:var(--t3);cursor:pointer;padding:0;font-size:11px;
}
.cr-search-box button:hover{color:var(--t1)}
.cr-wb-link{
  font-size:12px;font-weight:500;color:var(--t2);text-decoration:none;
  padding:5px 11px;border-radius:4px;border:1px solid var(--edge-soft);
  transition:all .15s;
}
.cr-wb-link:hover{color:var(--t1);border-color:var(--t3);background:var(--panel)}
.cr-gallery-main{
  flex:1;max-width:1280px;width:100%;margin:0 auto;padding:28px 24px;
}
.cr-gallery-title-row{
  display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:24px;
}
.cr-gallery-title{font-size:22px;font-weight:700;letter-spacing:-0.02em;margin:0}
.cr-gallery-sub{font-size:12px;color:var(--t3);margin:3px 0 0 0}
.cr-cards-grid{
  display:grid;grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));
  gap:18px;align-items:start;
}
.cr-proj-card{
  background:var(--panel);border:1px solid var(--edge);border-radius:7px;
  overflow:hidden;cursor:pointer;transition:transform .15s, border-color .15s, box-shadow .15s;
  display:flex;flex-direction:column;outline:none;
}
.cr-proj-card:hover{
  border-color:var(--edge-soft);box-shadow:0 12px 28px rgba(0,0,0,0.4);
  transform:translateY(-2px);
}
.cr-proj-card:focus-visible{
  border-color:var(--orange);box-shadow:0 0 0 2px var(--orange-dim);
}
.cr-card-thumb-stage{
  height:168px;background:var(--panel-2);display:flex;align-items:center;
  justify-content:center;position:relative;border-bottom:1px solid var(--edge);
  overflow:hidden;padding:12px;
}
.cr-card-preview-box{
  height:100%;max-width:100%;border-radius:4px;background:var(--app);
  border:1px solid var(--edge-soft);position:relative;display:flex;
  align-items:center;justify-content:center;box-shadow:var(--sink);
}
.cr-preview-target-tag{
  position:absolute;top:6px;left:6px;font-size:9.5px;font-weight:600;
  padding:2px 6px;border-radius:3px;background:rgba(0,0,0,0.7);
  border:1px solid rgba(255,255,255,0.08);color:var(--t2);backdrop-filter:blur(4px);
}
.cr-preview-size-tag{
  position:absolute;bottom:6px;right:6px;font-family:var(--mono);font-size:9px;
  padding:1px 5px;border-radius:2px;background:rgba(0,0,0,0.65);color:var(--t3);
}
.cr-preview-play-icon{
  width:36px;height:36px;border-radius:50%;background:rgba(0,0,0,0.6);
  border:1px solid rgba(255,255,255,0.12);display:flex;align-items:center;
  justify-content:center;color:var(--t2);transition:all .15s;
}
.cr-proj-card:hover .cr-preview-play-icon{
  color:var(--orange);background:var(--app);transform:scale(1.08);
}
.cr-card-body{padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.cr-card-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.cr-card-name{
  font-size:13.5px;font-weight:600;color:var(--t1);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;
}
.cr-card-rev{
  font-family:var(--mono);font-size:10px;color:var(--orange);
  background:color-mix(in srgb, var(--orange) 12%, transparent);
  padding:1px 5px;border-radius:3px;flex-shrink:0;
}
.cr-card-meta{
  display:flex;align-items:center;gap:6px;font-size:11px;color:var(--t3);
  font-family:var(--mono);
}
.cr-dot{width:3px;height:3px;border-radius:50%;background:var(--edge-soft)}
.cr-card-actions{
  display:flex;align-items:center;gap:5px;margin-top:6px;padding-top:8px;
  border-top:1px solid var(--edge);
}
.cr-act-btn{
  background:none;border:1px solid var(--edge-soft);border-radius:4px;
  color:var(--t2);font-family:inherit;font-size:11px;padding:3px 7px;
  cursor:pointer;transition:all .12s;
}
.cr-act-btn:hover{color:var(--t1);border-color:var(--t3);background:var(--panel-2)}
.cr-act-btn.pri{
  background:var(--edge);color:var(--t1);font-weight:600;
}
.cr-act-btn.pri:hover{border-color:var(--orange);color:var(--orange)}
.cr-act-btn.del:hover{color:var(--red);border-color:var(--red)}
.cr-empty-state{
  border:1px dashed var(--edge-soft);border-radius:8px;padding:56px 20px;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;gap:12px;margin:32px 0;
}
.cr-empty-icon{color:var(--t3);opacity:0.7}
.cr-empty-hdr{font-size:15px;font-weight:600;color:var(--t1);margin:0}
.cr-empty-msg{font-size:12.5px;color:var(--t3);max-width:420px;margin:0;line-height:1.5}
.cr-create-btn-inline{
  margin-top:8px;background:var(--orange);color:var(--on-accent);border:0;
  border-radius:5px;font-family:inherit;font-size:12.5px;font-weight:600;
  padding:8px 18px;cursor:pointer;transition:filter .15s;
}
.cr-create-btn-inline:hover{filter:brightness(1.12)}
.cr-ghost-btn{
  background:var(--panel);border:1px solid var(--edge-soft);color:var(--t2);
  border-radius:4px;padding:6px 14px;font:inherit;font-size:12px;cursor:pointer;
}
.cr-ghost-btn:hover{color:var(--t1);border-color:var(--t3)}
.cr-loading-spinner{
  width:24px;height:24px;border:2px solid var(--edge-soft);border-top-color:var(--orange);
  border-radius:50%;animation:cr-spin .8s linear infinite;
}
@keyframes cr-spin{to{transform:rotate(360deg)}}
.cr-bottom-bar{
  position:fixed;bottom:24px;left:0;right:0;display:flex;justify-content:center;
  pointer-events:none;z-index:30;
}
.cr-create-project-btn{
  pointer-events:auto;background:var(--orange);color:var(--on-accent);
  border:1px solid rgba(255,255,255,0.18);border-radius:24px;
  font-family:inherit;font-size:13px;font-weight:600;padding:10px 24px;
  display:flex;align-items:center;gap:8px;cursor:pointer;
  box-shadow:0 8px 24px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4);
  transition:transform .15s, filter .15s;
}
.cr-create-project-btn:hover{filter:brightness(1.12);transform:scale(1.03)}
.cr-toast{
  position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
  background:var(--panel-2);border:1px solid var(--edge-soft);color:var(--t1);
  padding:8px 16px;border-radius:6px;font-size:12px;box-shadow:0 8px 20px rgba(0,0,0,0.6);
  z-index:99;
}
`;
