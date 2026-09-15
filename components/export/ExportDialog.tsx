'use client';

/**
 * Export settings, and the render itself.
 *
 * Three states in one dialog rather than three dialogs: what you are about to
 * do, what it is doing, and where the file is. A render takes minutes, so the
 * middle state is not a spinner, it names the step and counts them.
 *
 * The presets are the sizes people actually deliver. Anything else is typed
 * in, and the numbers are clamped where the encoder would refuse them rather
 * than at the point the render fails.
 */

import { useCallback, useState } from 'react';
import type { DeliverySpec } from '@/lib/compiler/types.ts';
import type { ExportEvent, ExportResult } from '@/lib/export/types.ts';
import { getEncoderLimits } from '@/lib/export/limits.ts';

export interface ExportSettings {
  width: number;
  height: number;
  container: 'mp4' | 'mov' | 'webm';
  videoBitrate: string;
  audioBitrate: string;
  reencode: boolean;
  burnSubtitles: boolean;
  rangeMode?: 'entire' | 'custom';
  rangeStart?: number;
  rangeDuration?: number;
}

export const DEFAULT_EXPORT: ExportSettings = {
  width: 1920,
  height: 1080,
  container: 'mp4',
  videoBitrate: '8M',
  audioBitrate: '192k',
  // frame accurate by default: a cut that lands on a keyframe is a different
  // edit from the one on the timeline
  reencode: true,
  burnSubtitles: false,
  rangeMode: 'entire',
  rangeStart: 0,
  rangeDuration: 120,
};

export const toDelivery = (s: ExportSettings): Partial<DeliverySpec> => ({
  width: s.width,
  height: s.height,
  container: s.container,
  videoCodec: s.container === 'webm' ? 'vp9' : 'h264',
  videoBitrate: s.videoBitrate,
  audioBitrate: s.audioBitrate,
  reencode: s.reencode,
});

const SIZES: { label: string; w: number; h: number }[] = [
  { label: '2160p', w: 3840, h: 2160 },
  { label: '1080p', w: 1920, h: 1080 },
  { label: '720p', w: 1280, h: 720 },
  { label: '1080x1920', w: 1080, h: 1920 },
  { label: '1080x1080', w: 1080, h: 1080 },
];

const RATES = ['2M', '5M', '8M', '12M', '20M', '40M'];

export interface ExportDialogProps {
  open: boolean;
  projectName: string;
  clipCount: number;
  durationLabel: string;
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

  const [size, setSize] = useState(() =>
    SIZES.findIndex((s) => s.w === settings.width && s.h === settings.height));

  const set = useCallback(
    (patch: Partial<ExportSettings>) => onSettings({ ...settings, ...patch }),
    [onSettings, settings],
  );

  const encoderLimits = getEncoderLimits();

  if (!open) return null;

  const running = progress !== null && !result && !error;
  const nothingToRender = clipCount === 0;

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
            <div className="cx-body">
              <dl className="cx-what">
                <div><dt>timeline</dt><dd>{clipCount} clip{clipCount === 1 ? '' : 's'}</dd></div>
                <div><dt>length</dt><dd>{durationLabel}</dd></div>
              </dl>

              <fieldset className="cx-set" disabled={running}>
                <legend>Range</legend>
                <div className="cx-chips">
                  <button
                    type="button"
                    className="cx-chip"
                    data-on={(!settings.rangeMode || settings.rangeMode === 'entire') ? 'true' : undefined}
                    onClick={() => set({ rangeMode: 'entire' })}
                  >
                    Entire timeline
                  </button>
                  <button
                    type="button"
                    className="cx-chip"
                    data-on={settings.rangeMode === 'custom' ? 'true' : undefined}
                    onClick={() => set({ rangeMode: 'custom' })}
                  >
                    Custom range
                  </button>
                </div>
                {settings.rangeMode === 'custom' ? (
                  <div className="cx-rows" style={{ marginTop: 8 }}>
                    <label>
                      <span>Start frame</span>
                      <input
                        type="number"
                        min={0}
                        value={settings.rangeStart ?? 0}
                        onChange={(e) => set({ rangeStart: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                      />
                    </label>
                    <label>
                      <span>Duration (frames)</span>
                      <input
                        type="number"
                        min={1}
                        value={settings.rangeDuration ?? 120}
                        onChange={(e) => set({ rangeDuration: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                      />
                    </label>
                  </div>
                ) : null}
              </fieldset>

              <fieldset className="cx-set" disabled={running}>
                <legend>Size</legend>
                <div className="cx-chips">
                  {SIZES.map((s, i) => (
                    <button
                      key={s.label}
                      type="button"
                      className="cx-chip"
                      data-on={size === i ? 'true' : undefined}
                      onClick={() => { setSize(i); set({ width: s.w, height: s.h }); }}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                <div className="cx-rows" style={{ marginTop: 8 }}>
                  <label>
                    <span>Width ({encoderLimits.minWidth}-{encoderLimits.maxWidth})</span>
                    <input
                      type="number"
                      min={encoderLimits.minWidth}
                      max={encoderLimits.maxWidth}
                      value={settings.width}
                      onChange={(e) => {
                        const val = Math.max(encoderLimits.minWidth, Math.min(encoderLimits.maxWidth, parseInt(e.target.value, 10) || 1920));
                        setSize(-1);
                        set({ width: val });
                      }}
                    />
                  </label>
                  <label>
                    <span>Height ({encoderLimits.minHeight}-{encoderLimits.maxHeight})</span>
                    <input
                      type="number"
                      min={encoderLimits.minHeight}
                      max={encoderLimits.maxHeight}
                      value={settings.height}
                      onChange={(e) => {
                        const val = Math.max(encoderLimits.minHeight, Math.min(encoderLimits.maxHeight, parseInt(e.target.value, 10) || 1080));
                        setSize(-1);
                        set({ height: val });
                      }}
                    />
                  </label>
                </div>
              </fieldset>

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
                <legend>Quality</legend>
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
                <label className="cx-check">
                  <input
                    type="checkbox"
                    checked={settings.burnSubtitles}
                    onChange={(e) => set({ burnSubtitles: e.target.checked })}
                  />
                  <span>
                    <b>Burn in subtitles</b>
                    <em>Only if the timeline carries a subtitle file.</em>
                  </span>
                </label>
              </fieldset>

              {progress ? <Progress event={progress} /> : null}
              {error ? <p className="cx-err" role="alert">{error}</p> : null}

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
            </div>
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

function Finished({ result, onClose }: { result: ExportResult; onClose: () => void }) {
  return (
    <div className="cx-body">
      <div className="cx-done">
        <span className="cx-tick" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
            strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 12.5l5.5 5.5L20 7" />
          </svg>
        </span>
        <div>
          <b>Rendered</b>
          <span>
            {typeof result.runMs === 'number'
              ? `in ${(result.runMs / 1000).toFixed(1)}s`
              : 'and ready'}
          </span>
        </div>
      </div>

      {result.warnings.length ? (
        <ul className="cx-warn">
          {result.warnings.map((w, i) => <li key={i}>{w.message}</li>)}
        </ul>
      ) : null}

      <dl className="cx-what">
        <div><dt>file</dt><dd>{result.key}</dd></div>
        <div><dt>run</dt><dd>{result.runId}</dd></div>
        <div><dt>pipeline</dt><dd>{result.pipelineId}</dd></div>
      </dl>

      <p className="cx-note">
        The link is signed and stops working in about an hour. Export again for a fresh one.
      </p>

      <footer className="cx-foot">
        <span className="cx-note" />
        <button type="button" className="cx-ghost" onClick={onClose}>Close</button>
        <a className="cx-go" href={result.url} target="_blank" rel="noreferrer">Open the file</a>
      </footer>
    </div>
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
.cx-body{padding:14px;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:14px}

.cx-what{margin:0;display:flex;flex-wrap:wrap;gap:6px 20px}
.cx-what>div{display:flex;gap:7px;align-items:baseline;min-width:0}
.cx-what dt{font-size:11px;color:var(--t3)}
.cx-what dd{
  margin:0;font-family:var(--mono);font-size:11px;color:var(--t1);
  min-width:0;overflow:hidden;text-overflow:ellipsis;
}

.cx-set{border:0;padding:0;margin:0;min-width:0}
.cx-set[disabled]{opacity:.5}
.cx-set legend{
  padding:0;font-size:10px;font-weight:700;letter-spacing:.08em;
  text-transform:uppercase;color:var(--t3);margin-bottom:7px;
}
.cx-chips{display:flex;flex-wrap:wrap;gap:5px}
.cx-chip{
  font-family:inherit;font-size:11.5px;font-weight:600;padding:5px 11px;border-radius:4px;
  border:1px solid var(--edge-soft);background:var(--app);color:var(--t2);cursor:pointer;
}
.cx-chip:hover{color:var(--t1);border-color:var(--t3)}
.cx-chip[data-on]{background:var(--orange);border-color:var(--orange);color:var(--on-accent)}
.cx-rows{display:flex;flex-wrap:wrap;gap:9px}
.cx-rows label{display:flex;flex-direction:column;gap:4px;flex:1 1 150px;min-width:0}
.cx-rows span{font-size:11px;color:var(--t2)}
.cx-rows select{
  background:var(--app);border:1px solid var(--edge-soft);border-radius:4px;color:var(--t1);
  font-family:inherit;font-size:11.5px;padding:5px 6px;min-width:0;
}
.cx-rows select:focus{outline:none;border-color:var(--orange)}

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

.cx-done{display:flex;align-items:center;gap:11px}
.cx-tick{
  width:32px;height:32px;border-radius:50%;flex:none;display:flex;align-items:center;
  justify-content:center;color:var(--green);border:1px solid var(--green);
}
.cx-done b{display:block;font-size:13px;color:var(--t1)}
.cx-done span{display:block;font-size:11.5px;color:var(--t3);margin-top:1px}

.cx-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cx-note{flex:1;min-width:120px;font-size:10.5px;color:var(--t3)}
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
