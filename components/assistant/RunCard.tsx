'use client';

/**
 * One run, as the executor reports it.
 *
 * Rendered from `RunState` (the fold of the executor's event stream) and
 * from nothing else, so a reload that replays a persisted run draws exactly
 * the same card. Progress lives on the row and never inside a result: a tool
 * call that has a result is finished, and a half-filled result is how a model
 * ends up reasoning about an answer that has not arrived.
 *
 * The whole run is one entry in history, because the server stores it as one
 * revision. One undo reverses the run, not its last step.
 */

import { useEffect, useState } from 'react';
import type { JobOutput, RunState, StepState } from '@/lib/executor/types.ts';

export interface RunCardProps {
  run: RunState;
  /** What the run is for, in a phrase, usually the plan's intent. */
  title?: string;
}

const PHASE_LABEL: Record<StepState['phase'], string> = {
  pending: 'waiting',
  queued: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
};

export function RunCard({ run, title }: RunCardProps) {
  const live = run.status === 'planning' || run.status === 'running';
  const elapsed = useElapsed(run.startedAt, run.endedAt, live);

  return (
    <>
      <style href="cutroom-runcard" precedence="medium">{CSS}</style>
      <section className="cr-run" aria-label={`Run ${run.runId}`}>
        <header className="cr-runhead">
          <Phase status={run.status} />
          <span className="cr-runttl">{title ?? run.cardId ?? 'Run'}</span>
          <span className="cr-runel" aria-label="elapsed">{(elapsed / 1000).toFixed(1)}s</span>
        </header>

        {run.steps.map((step) => (
          <div className="cr-tool" key={step.stepId} data-done={step.phase === 'done' ? 'true' : undefined}>
            <div className="cr-tl">
              <StepMark phase={step.phase} />
              <span className="cr-toolnm">{step.label}</span>
              <span className="cr-toolst">{PHASE_LABEL[step.phase]}</span>
            </div>

            {step.phase === 'running' && step.pct !== null ? (
              <div
                className="cr-bar"
                role="progressbar"
                aria-valuenow={Math.round(step.pct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${step.label} progress`}
              >
                <i style={{ width: `${Math.max(0, Math.min(100, step.pct))}%` }} />
              </div>
            ) : null}

            {step.message ? <p className="cr-toolmeta">{step.message}</p> : null}
            {step.outputs.length ? <Outputs outputs={step.outputs} /> : null}
          </div>
        ))}

        {run.error ? <p className="cr-runerr">{run.error}</p> : null}

        {run.status === 'done' && run.revision !== null ? (
          <p className="cr-runfoot">
            Applied as <b>one revision</b> (rev {run.revision}). One undo reverses the whole run.
          </p>
        ) : null}
      </section>
    </>
  );
}

function Outputs({ outputs }: { outputs: JobOutput[] }) {
  return (
    <ul className="cr-outs">
      {outputs.map((o) => (
        <li key={o.key}>
          <span className="cr-outk">{o.key}</span>
          <span className="cr-outb">{formatBytes(o.bytes)}</span>
          {o.role ? <span className="cr-outr">{o.role}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function Phase({ status }: { status: RunState['status'] }) {
  if (status === 'done') return <Tick />;
  if (status === 'failed') return <Cross />;
  return <span className="cr-spin" aria-hidden="true" />;
}

function StepMark({ phase }: { phase: StepState['phase'] }) {
  if (phase === 'done') return <Tick />;
  if (phase === 'failed') return <Cross />;
  if (phase === 'running') return <span className="cr-spin" aria-hidden="true" />;
  return <span className="cr-dotq" aria-hidden="true" />;
}

const Tick = () => (
  <svg className="cr-tick" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
    <path d="M3 8.5l3.5 3.5L13 5" />
  </svg>
);

const Cross = () => (
  <svg className="cr-cross" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

/**
 * Elapsed milliseconds, ticking only while the run is live.
 *
 * It reads the clock rather than counting its own ticks: a backgrounded tab
 * throttles timers, and a counter would report a two-minute pipeline as
 * having taken forty seconds.
 */
function useElapsed(startedAt: number, endedAt: number | null, live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [live]);
  // once the run has ended its own end time is the answer, so the stopped
  // clock never matters
  return Math.max(0, (endedAt ?? now) - startedAt);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const CSS = `
.cr-run{
  border:1px solid var(--edge-soft);border-radius:4px;background:var(--panel);
  overflow:hidden;font-family:var(--ui);
}
.cr-runhead{
  padding:7px 10px;background:var(--panel-2);border-bottom:1px solid var(--edge-soft);
  display:flex;align-items:center;gap:7px;font-size:11.5px;font-weight:600;color:var(--t1);
}
.cr-runttl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cr-runel{
  font-family:var(--mono);font-size:10px;color:var(--t3);
  font-variant-numeric:tabular-nums;flex:none;
}
.cr-tool{
  border-bottom:1px solid var(--edge);padding:7px 10px;font-size:11.5px;
  display:flex;flex-direction:column;gap:5px;
}
.cr-tool:last-child{border-bottom:0}
.cr-tl{display:flex;align-items:center;gap:7px}
.cr-toolnm{
  font-family:var(--mono);font-size:10.5px;color:var(--t1);flex:1;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.cr-tool[data-done] .cr-toolnm{color:var(--t2)}
.cr-toolst{font-family:var(--mono);font-size:9.5px;color:var(--t3);white-space:nowrap}
.cr-spin{
  width:10px;height:10px;border-radius:50%;flex:none;
  border:1.5px solid var(--orange-dim);border-top-color:var(--orange);
  animation:cr-sp .7s linear infinite;
}
@keyframes cr-sp{to{transform:rotate(360deg)}}
.cr-tick{flex:none;color:var(--green)}
.cr-cross{flex:none;color:var(--red)}
.cr-dotq{width:10px;height:10px;flex:none;border-radius:50%;border:1.5px solid var(--ctl-off)}
.cr-bar{height:3px;background:var(--app);border-radius:4px;overflow:hidden}
.cr-bar i{display:block;height:100%;background:var(--orange);transition:width .3s linear}
.cr-toolmeta{
  font-family:var(--mono);font-size:9.5px;color:var(--t3);line-height:1.5;margin:0;
}
.cr-outs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.cr-outs li{display:flex;gap:7px;align-items:baseline;font-family:var(--mono);font-size:9.5px}
.cr-outk{color:var(--t2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cr-outb{color:var(--t3);flex:none}
.cr-outr{color:var(--blue);flex:none}
.cr-runerr{
  margin:0;padding:8px 10px;border-top:1px solid var(--edge);
  font-size:11.5px;color:var(--red);line-height:1.45;
}
.cr-runfoot{
  margin:0;padding:8px 10px;border-top:1px solid var(--edge);
  font-size:11.5px;color:var(--t2);line-height:1.45;background:var(--panel-2);
}
.cr-runfoot b{color:var(--orange);font-weight:600}
`;
