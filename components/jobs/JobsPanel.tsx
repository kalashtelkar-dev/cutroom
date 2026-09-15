'use client';

/**
 * Jobs and their logs.
 *
 * Every piece of work the app does on your behalf appears here, from a 20ms
 * blade to a GPU pipeline, with a timestamped log. This is the answer to
 * "what did it just do to my cut", and in an editor where a model makes
 * changes for you that question gets asked.
 */
import { useEffect, useState } from 'react';
import type { JobStore } from '../../lib/jobs/store.ts';
import type { Job } from '../../lib/jobs/types.ts';

const STATUS_COLOUR: Record<string, string> = {
  running: 'var(--yellow)',
  done: 'var(--green)',
  failed: 'var(--orange)',
  cancelled: 'var(--t3)',
  queued: 'var(--t3)',
};

const LEVEL_COLOUR: Record<string, string> = {
  debug: 'var(--t3)',
  info: 'var(--t2)',
  warn: 'var(--yellow)',
  error: 'var(--orange)',
};

const clock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour12: false });

/** Elapsed for a job still running. `tick` is only there to force the redraw. */
const elapsed = (startedAt: number, tick: number): number => {
  void tick;
  return Date.now() - startedAt;
};

export function JobsPanel({
  store, open, onOpen, onClose,
}: {
  store: JobStore;
  open: boolean;
  onOpen?: () => void;
  onClose: () => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => store.subscribe(setJobs), [store]);

  /**
   * A running job's elapsed time ticks from here rather than from Date.now()
   * during render. Reading the clock while rendering makes the output depend
   * on when React happened to run, which is neither pure nor reproducible.
   */
  useEffect(() => {
    if (!jobs.some((j) => j.endedAt === null)) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [jobs]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const running = jobs.filter((j) => j.endedAt === null);
  const latestRunning = running[0] ?? null;

  return (
    <>
      {!open && latestRunning ? (
        <div className="cr-jobs-notif" role="status" aria-live="polite">
          <i className="dot" style={{ background: STATUS_COLOUR[latestRunning.status] ?? 'var(--t3)' }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {latestRunning.label}
          </span>
          {latestRunning.progress !== null ? (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)' }}>
              {Math.round(latestRunning.progress * 100)}%
            </span>
          ) : null}
          {onOpen ? (
            <button type="button" onClick={onOpen}>
              Open
            </button>
          ) : null}
        </div>
      ) : null}

      {open ? (
    <aside className="cr-jobs" aria-label="Jobs and logs">
      <header>
        <b>Jobs</b>
        <span className="count">{jobs.length}</span>
        <span className="sp" />
        <button type="button" onClick={() => store.clear()} className="quiet">Clear finished</button>
        <button type="button" onClick={onClose} aria-label="Close">✕</button>
      </header>

      {jobs.length === 0 ? (
        <p className="empty">Nothing has run yet. Every edit, import and render lands here with its log.</p>
      ) : (
        <ol>
          {jobs.map((j) => {
            const isOpen = expanded === j.id;
            const ms = j.endedAt !== null ? j.endedAt - j.startedAt : elapsed(j.startedAt, tick);
            return (
              <li key={j.id}>
                <button
                  type="button"
                  className="row"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : j.id)}
                >
                  <i className="dot" style={{ background: STATUS_COLOUR[j.status] ?? 'var(--t3)' }} />
                  <span className="kind">{j.kind}</span>
                  <span className="label">{j.label}</span>
                  {j.progress !== null && j.status === 'running' ? (
                    <span className="pct">{Math.round(j.progress * 100)}%</span>
                  ) : null}
                  <span className="ms">{ms}ms</span>
                </button>

                {isOpen ? (
                  <div className="log">
                    {j.truncated ? <p className="trunc">log truncated; the middle was dropped</p> : null}
                    {j.log.map((l, i) => (
                      <p key={i}>
                        <span className="at">{clock(l.at)}</span>
                        <span className="lv" style={{ color: LEVEL_COLOUR[l.level] }}>{l.level}</span>
                        <span className="msg">{l.message}</span>
                        {l.data !== undefined ? (
                          <span className="data">{JSON.stringify(l.data).slice(0, 300)}</span>
                        ) : null}
                      </p>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  ) : null}
  </>
  );
}
