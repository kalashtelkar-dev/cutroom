'use client';

/**
 * Export settings, and the render itself.
 *
 * Three states in one dialog rather than three dialogs: what you are about to
 * do, what it is doing, and where the file is. A render takes minutes, so the
 * middle state is not a spinner, it names the step and counts them.
 *
 * The first state used to open on a width, a height, a container, a video
 * bitrate and an audio bitrate. That is five questions, none of which anyone
 * outside this repo can answer, and between them they cannot express the only
 * thing most people want to say: this is going on Instagram. So the question
 * is now where the file is going, and the frame comes with the answer. The
 * encoding is still there to be overridden under Advanced; the frame is not,
 * because a destination whose size can be typed over is no longer a
 * destination, it is a label sitting next to two numbers that disagree.
 */

import { useCallback, useState } from 'react';
import type { DeliverySpec, FrameFit } from '@/lib/compiler/types.ts';
import type { ExportEvent, ExportResult } from '@/lib/export/types.ts';
import { getEncoderLimits } from '@/lib/export/limits.ts';
import {
  TARGETS, QUALITIES, targetFor, videoBitrateFor,
  type ExportTarget, type QualityId,
} from '@/lib/export/targets.ts';

export interface ExportSettings {
  width: number;
  height: number;
  container: 'mp4' | 'mov' | 'webm';
  videoBitrate: string;
  audioBitrate: string;
  reencode: boolean;
  burnSubtitles: boolean;
  /** Which destination the frame came from, or null for a size set elsewhere. */
  target?: string | null;
  quality?: QualityId;
  /** What to do when the footage is not the shape of the frame. */
  fit?: FrameFit;
}

const OPENS_ON = TARGETS[0];

export const DEFAULT_EXPORT: ExportSettings = {
  width: OPENS_ON.width,
  height: OPENS_ON.height,
  container: 'mp4',
  videoBitrate: videoBitrateFor(OPENS_ON.height, 'standard'),
  audioBitrate: '192k',
  // frame accurate by default: a cut that lands on a keyframe is a different
  // edit from the one on the timeline
  reencode: true,
  // on by default: cues on the timeline were put there to be seen, and an
  // export that quietly drops them is found after the render, not before
  burnSubtitles: true,
  target: OPENS_ON.id,
  quality: 'standard',
  // never crop someone's picture without being asked
  fit: 'contain',
};

export const toDelivery = (s: ExportSettings): Partial<DeliverySpec> => ({
  width: s.width,
  height: s.height,
  container: s.container,
  videoCodec: s.container === 'webm' ? 'vp9' : 'h264',
  videoBitrate: s.videoBitrate,
  audioBitrate: s.audioBitrate,
  reencode: s.reencode,
  fit: s.fit ?? 'contain',
});

const RATES = ['2M', '5M', '8M', '12M', '20M', '40M'];

export interface ExportDialogProps {
  open: boolean;
  projectName: string;
  clipCount: number;
  durationLabel: string;
  /**
   * The shape of the footage, when the pool agrees on one.
   *
   * Only used to say what a mismatched frame will do to it. Null when the
   * clips disagree or never reported a size, and then nothing is said, which
   * is the honest answer: telling someone their picture will be letterboxed
   * when it might already be vertical is worse than telling them nothing.
   */
  sourceSize?: { width?: number; height?: number } | null;
  settings: ExportSettings;
  onSettings: (s: ExportSettings) => void;
  /** null until a render is running, then the last event seen. */
  progress: ExportEvent | null;
  result: ExportResult | null;
  error: string | null;
  onStart: () => void;
  onClose: () => void;
}

export function ExportDialog(props: ExportDialogProps) {
  const {
    open, projectName, clipCount, durationLabel, settings, onSettings,
    progress, result, error, onStart, onClose,
  } = props;

  const [advanced, setAdvanced] = useState(false);

  const set = useCallback(
    (patch: Partial<ExportSettings>) => onSettings({ ...settings, ...patch }),
    [onSettings, settings],
  );

  const encoderLimits = getEncoderLimits();

  if (!open) return null;

  const running = progress !== null && !result && !error;
  const nothingToRender = clipCount === 0;
  const quality: QualityId = settings.quality ?? 'standard';
  // the card the current numbers came from, so a size set anywhere else is
  // named by whatever card matches it rather than by a stale id
  const chosen = settings.target ? TARGETS.find((t) => t.id === settings.target) ?? null : null;
  const lit = chosen && chosen.width === settings.width && chosen.height === settings.height
    ? chosen
    : targetFor(settings.width, settings.height);

  return (
    <>
      <style href="cutroom-export" precedence="medium">{CSS}</style>
      <div className="cx-scrim" role="dialog" aria-modal="true" aria-labelledby="cx-t">
        <div className="cx-box">
          <header className="cx-head">
            <h2 id="cx-t">Export video</h2>
            <span className="cx-sub">{projectName}</span>
            <button
              type="button"
              className="cx-x"
              onClick={onClose}
              aria-label={running ? 'Hide, the render keeps going' : 'Close'}
            >
              ✕
            </button>
          </header>

          {result ? (
            <Finished result={result} onClose={onClose} />
          ) : (
            <>
            <div className="cx-body">
              <dl className="cx-facts">
                <div><dt>timeline</dt><dd>{clipCount} clip{clipCount === 1 ? '' : 's'}</dd></div>
                <div><dt>length</dt><dd>{durationLabel}</dd></div>
                <div><dt>destination</dt><dd>{lit ? `${lit.name} (${settings.width}x${settings.height})` : `${settings.width}x${settings.height}`}</dd></div>
              </dl>

              <fieldset className="cx-set" disabled={running}>
                <legend>Quality</legend>
                <div className="cx-chips">
                  {QUALITIES.map((q) => (
                    <button
                      key={q.id}
                      type="button"
                      className="cx-chip"
                      data-on={quality === q.id ? 'true' : undefined}
                      aria-pressed={quality === q.id}
                      onClick={() => set({
                        quality: q.id,
                        videoBitrate: videoBitrateFor(settings.height, q.id),
                      })}
                    >
                      {q.name}
                    </button>
                  ))}
                </div>
                <p className="cx-hint">
                  {QUALITIES.find((q) => q.id === quality)?.note}. {settings.videoBitrate}bit/s.
                </p>
              </fieldset>

              <fieldset className="cx-set" disabled={running}>
                <legend>Subtitles</legend>
                <label className="cx-check">
                  <input
                    type="checkbox"
                    checked={settings.burnSubtitles}
                    onChange={(e) => set({ burnSubtitles: e.target.checked })}
                  />
                  <span>
                    <b>Burn in subtitles</b>
                    <em>The cues on the timeline are drawn into the picture. Nothing to switch off later.</em>
                  </span>
                </label>
              </fieldset>

              <details className="cx-adv" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
                <summary>Advanced</summary>

                <fieldset className="cx-set" disabled={running}>
                  <legend>Format</legend>
                  <div className="cx-rows">
                    <label>
                      <span>Container</span>
                      <select
                        value={settings.container}
                        onChange={(e) => set({ container: e.target.value as ExportSettings['container'] })}
                      >
                        {encoderLimits.containers.map((c) => (
                          <option key={c} value={c}>
                            {c.toUpperCase()} {c === 'webm' ? '(vp9 + opus)' : '(h264 + aac)'}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Video rate</span>
                      <select value={settings.videoBitrate} onChange={(e) => set({ videoBitrate: e.target.value })}>
                        {RATES.map((r) => <option key={r} value={r}>{r}bit/s</option>)}
                      </select>
                    </label>
                    <label>
                      <span>Audio rate</span>
                      <select value={settings.audioBitrate} onChange={(e) => set({ audioBitrate: e.target.value })}>
                        {['128k', '192k', '256k', '320k'].map((r) => <option key={r} value={r}>{r}bit/s</option>)}
                      </select>
                    </label>
                  </div>
                </fieldset>

                <fieldset className="cx-set" disabled={running}>
                  <legend>Cuts</legend>
                  <label className="cx-check">
                    <input
                      type="checkbox"
                      checked={settings.reencode}
                      onChange={(e) => set({ reencode: e.target.checked })}
                    />
                    <span>
                      <b>Frame accurate</b>
                      <em>
                        {settings.reencode
                          ? 'Every cut lands on the frame you set. Slower.'
                          : 'Cuts land on the nearest keyframe, which is not the edit on your timeline. Faster.'}
                      </em>
                    </span>
                  </label>
                </fieldset>
              </details>

              {progress ? <Progress event={progress} /> : null}
              {error ? <p className="cx-err" role="alert">{error}</p> : null}
            </div>

            {/*
              Outside the body, so it is a bar and not the last paragraph of a
              scroll. Advanced open used to push Render off the bottom.
            */}
            <footer className="cx-foot">
              <span className="cx-note">
                {nothingToRender
                  ? 'There is nothing on the timeline yet.'
                  : 'This runs on the GPU and costs money.'}
              </span>
              <button type="button" className="cx-ghost" onClick={onClose}>
                {running ? 'Hide' : 'Cancel'}
              </button>
              <button
                type="button"
                className="cx-go"
                onClick={onStart}
                disabled={running || nothingToRender}
              >
                {running ? 'Rendering...' : error ? 'Try again' : 'Render'}
              </button>
            </footer>
            </>
          )}
        </div>
      </div>
    </>
  );
}

const PHASES: { id: string; label: string }[] = [
  { id: 'compiling', label: 'Compile' },
  { id: 'checking', label: 'Check' },
  { id: 'validating', label: 'Validate' },
  { id: 'saving', label: 'Save' },
  { id: 'publishing', label: 'Publish' },
  { id: 'running', label: 'Render' },
  { id: 'signing', label: 'Collect' },
];

function Progress({ event }: { event: ExportEvent }) {
  const at = PHASES.findIndex((p) => p.id === event.phase);
  return (
    <div className="cx-prog">
      <ol className="cx-steps">
        {PHASES.map((p, i) => (
          <li
            key={p.id}
            data-state={i < at ? 'done' : i === at ? 'now' : 'waiting'}
          >
            <span className="cx-dot" aria-hidden="true" />
            {p.label}
          </li>
        ))}
      </ol>
      <p className="cx-msg">{event.message}</p>
      {typeof event.progress === 'number' ? (
        <div className="cx-bar"><i style={{ width: `${Math.round(event.progress * 100)}%` }} /></div>
      ) : null}
    </div>
  );
}

/**
 * Where the file is.
 *
 * Three ids, each long enough to run out of dialog, so they are a label
 * column and a value column rather than a wrapped sentence: the labels line
 * up, the values start at one left edge, and what will not fit is cut at the
 * end with the whole of it on the element's title.
 */
function Finished({ result, onClose }: { result: ExportResult; onClose: () => void }) {
  return (
    <>
      <div className="cx-body">
        <div className="cx-done">
          <span className="cx-tick" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
              strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 12.5l5.5 5.5L20 7" />
            </svg>
          </span>
          <span className="cx-donetext">
            <b>Rendered</b>
            <em>
              {typeof result.runMs === 'number'
                ? `in ${(result.runMs / 1000).toFixed(1)}s`
                : 'and ready'}
            </em>
          </span>
        </div>

        {result.warnings.length ? (
          <ul className="cx-warn">
            {result.warnings.map((w, i) => <li key={i}>{w.message}</li>)}
          </ul>
        ) : null}

        <dl className="cx-ids">
          <div><dt>File</dt><dd title={result.key}>{result.key}</dd></div>
          <div><dt>Run</dt><dd title={result.runId}>{result.runId}</dd></div>

        </dl>

        <p className="cx-fine">
          The link is signed and stops working in about an hour. Export again for a fresh one.
        </p>
      </div>

      <footer className="cx-foot">
        <button type="button" className="cx-ghost" onClick={onClose}>Close</button>
        <a className="cx-go" href={result.url} target="_blank" rel="noreferrer">Open the file</a>
      </footer>
    </>
  );
}

const CSS = `
.cx-scrim{
  position:fixed;inset:0;z-index:120;background:rgba(0,0,0,.72);
  display:flex;align-items:center;justify-content:center;padding:20px;font-family:var(--ui);
}
.cx-box{
  width:min(540px,100%);max-height:min(86vh,760px);display:flex;flex-direction:column;
  background:var(--panel);border:1px solid var(--edge-soft);border-radius:6px;
  box-shadow:0 24px 70px rgba(0,0,0,.7);overflow:hidden;
}
.cx-head{
  display:flex;align-items:baseline;gap:9px;padding:12px 14px;flex:none;
  background:var(--head);border-bottom:1px solid var(--edge);
}
.cx-head h2{margin:0;font-size:13.5px;font-weight:700;color:var(--t1)}
.cx-sub{
  font-family:var(--mono);font-size:11px;color:var(--t3);flex:1;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.cx-x{
  background:none;border:0;color:var(--t3);cursor:pointer;font-size:13px;
  padding:0 2px;line-height:1;flex:none;
}
.cx-x:hover{color:var(--t1)}
.cx-body{
  padding:14px;flex:1 1 auto;overflow:auto;min-height:0;
  display:flex;flex-direction:column;gap:13px;
}

/* the two facts panels: what is about to be rendered, and where it went */
.cx-facts,.cx-ids{
  margin:0;padding:10px 11px;border:1px solid var(--edge);border-radius:5px;
  background:var(--panel-2);min-width:0;
}
.cx-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:9px 16px}
.cx-facts>div{display:flex;flex-direction:column;gap:3px;min-width:0}
.cx-ids{display:grid;gap:7px}
.cx-ids>div{display:grid;grid-template-columns:58px minmax(0,1fr);align-items:baseline;gap:10px}
.cx-facts dt,.cx-ids dt{
  font-size:9.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--t3);
}
.cx-facts dd,.cx-ids dd{
  margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.cx-facts dd{font-size:12px;color:var(--t1)}
.cx-ids dd{font-family:var(--mono);font-size:11px;color:var(--t1)}

.cx-set{border:0;padding:0;margin:0;min-width:0}
.cx-set[disabled]{opacity:.5}
.cx-set legend{
  padding:0;font-size:10px;font-weight:700;letter-spacing:.08em;
  text-transform:uppercase;color:var(--t3);margin-bottom:7px;
}
.cx-chips{display:flex;flex-wrap:wrap;gap:5px}

/* destinations: two columns on a laptop, one on a phone */
.cx-targets{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:6px}
.cx-target{
  display:flex;align-items:center;gap:9px;text-align:left;min-width:0;
  font-family:inherit;padding:8px 10px;border-radius:5px;cursor:pointer;
  border:1px solid var(--edge-soft);background:var(--app);color:var(--t2);
}
.cx-target:hover{border-color:var(--t3)}
.cx-target[data-on]{border-color:var(--orange);background:var(--orange-dim)}
.cx-target b{display:block;font-size:12px;font-weight:600;color:var(--t1);line-height:1.3}
.cx-target em{
  display:block;font-style:normal;font-size:10.5px;color:var(--t3);line-height:1.35;margin-top:1px;
}
.cx-tname{flex:1;min-width:0}
.cx-tsize{font-family:var(--mono);font-size:9.5px;color:var(--t3);flex:none}
.cx-shape{
  width:19px;height:19px;flex:none;display:flex;align-items:center;justify-content:center;
}
.cx-shape i{display:block;border:1.5px solid currentColor;border-radius:1.5px;opacity:.75}
.cx-target[data-on] .cx-shape{color:var(--orange)}

.cx-fits{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:6px}
.cx-fit{
  font-family:inherit;text-align:left;padding:8px 10px;border-radius:5px;cursor:pointer;min-width:0;
  border:1px solid var(--edge-soft);background:var(--app);color:var(--t2);
}
.cx-fit:hover{border-color:var(--t3)}
.cx-fit[data-on]{border-color:var(--orange);background:var(--orange-dim)}
.cx-fit b{display:block;font-size:12px;font-weight:600;color:var(--t1)}
.cx-fit em{display:block;font-style:normal;font-size:10.5px;color:var(--t3);line-height:1.4;margin-top:2px}

.cx-hint{margin:7px 0 0;font-size:10.5px;line-height:1.5;color:var(--t3)}

.cx-adv{border-top:1px solid var(--edge);padding-top:11px}
.cx-adv summary{
  font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  color:var(--t3);cursor:pointer;list-style:none;
}
.cx-adv summary::-webkit-details-marker{display:none}
.cx-adv summary::before{content:'▸';font-size:11px;margin-right:5px;vertical-align:-1px}
.cx-adv[open] summary::before{content:'▾'}
.cx-adv summary:hover{color:var(--t1)}
.cx-adv .cx-set{margin-top:13px}
.cx-chip{
  font-family:inherit;font-size:11.5px;font-weight:600;padding:5px 11px;border-radius:4px;
  border:1px solid var(--edge-soft);background:var(--app);color:var(--t2);cursor:pointer;
}
.cx-chip:hover{color:var(--t1);border-color:var(--t3)}
.cx-chip[data-on]{background:var(--orange);border-color:var(--orange);color:var(--on-accent)}
.cx-rows{display:flex;flex-wrap:wrap;gap:9px}
.cx-rows label{display:flex;flex-direction:column;gap:4px;flex:1 1 150px;min-width:0}
.cx-rows span{font-size:11px;color:var(--t2)}
.cx-rows select,.cx-rows input{
  background:var(--app);border:1px solid var(--edge-soft);border-radius:4px;color:var(--t1);
  font-family:inherit;font-size:11.5px;padding:5px 6px;min-width:0;
}
.cx-rows select:focus,.cx-rows input:focus{outline:none;border-color:var(--orange)}

.cx-check{display:flex;gap:9px;align-items:flex-start;padding:4px 0;cursor:pointer}
.cx-check input{margin:2px 0 0;accent-color:var(--orange);flex:none}
.cx-check b{display:block;font-size:11.5px;font-weight:600;color:var(--t1)}
.cx-check em{display:block;font-style:normal;font-size:11px;color:var(--t3);line-height:1.45;margin-top:1px}

.cx-prog{
  border:1px solid var(--edge);border-radius:5px;background:var(--panel-2);padding:11px;
  display:flex;flex-direction:column;gap:9px;
}
.cx-steps{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px 12px}
.cx-steps li{
  display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--t3);
}
.cx-steps li[data-state="done"]{color:var(--t2)}
.cx-steps li[data-state="now"]{color:var(--t1);font-weight:600}
.cx-dot{width:5px;height:5px;border-radius:50%;background:var(--ctl-off);flex:none}
.cx-steps li[data-state="done"] .cx-dot{background:var(--green)}
.cx-steps li[data-state="now"] .cx-dot{background:var(--orange)}
.cx-msg{margin:0;font-family:var(--mono);font-size:11px;color:var(--t2);line-height:1.5}
.cx-bar{height:3px;border-radius:3px;background:var(--app);overflow:hidden}
.cx-bar i{display:block;height:100%;background:var(--orange);transition:width .3s}

.cx-err{
  margin:0;padding:9px 11px;border-radius:5px;font-size:11.5px;line-height:1.5;
  background:var(--orange-dim);border:1px solid var(--orange);color:var(--t1);
}
.cx-warn{
  margin:0;padding:9px 11px 9px 26px;border-radius:5px;font-size:11px;line-height:1.55;
  background:var(--panel-2);border:1px solid var(--edge);color:var(--t2);
}

.cx-done{display:flex;align-items:center;gap:11px;min-width:0}
.cx-tick{
  width:30px;height:30px;border-radius:50%;flex:none;display:flex;align-items:center;
  justify-content:center;color:var(--green);border:1px solid var(--green);
  background:color-mix(in srgb, var(--green) 10%, transparent);
}
/* one baseline for the two lines, so the tick sits on their middle */
.cx-donetext{display:flex;flex-direction:column;gap:2px;min-width:0}
.cx-done b{font-size:13px;font-weight:700;color:var(--t1);line-height:1.15}
.cx-done em{font-style:normal;font-size:11.5px;color:var(--t3);line-height:1.15}
.cx-fine{margin:0;font-size:10.5px;line-height:1.5;color:var(--t3)}

/* a bar, not the last line of the body: it stays put while the body scrolls */
.cx-foot{
  flex:none;display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;
  padding:11px 14px;border-top:1px solid var(--edge);background:var(--head);
}
.cx-note{margin-right:auto;min-width:120px;font-size:10.5px;color:var(--t3)}
.cx-ghost,.cx-go{
  font-family:inherit;font-size:12px;font-weight:600;padding:7px 15px;border-radius:4px;
  cursor:pointer;border:1px solid var(--edge-soft);text-decoration:none;display:inline-block;
}
.cx-ghost{background:var(--app);color:var(--t2)}
.cx-ghost:hover{color:var(--t1);border-color:var(--t3)}
.cx-go{background:var(--orange);border-color:var(--orange);color:var(--on-accent)}
.cx-go:hover{filter:brightness(1.12)}
.cx-go:disabled{opacity:.45;cursor:not-allowed;filter:none}
@media (max-width:520px){
  .cx-rows label{flex-basis:100%}
}
`;
