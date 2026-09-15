'use client';

/**
 * The inspector.
 *
 * Parameter groups for the selected clip, each with an enable toggle, a
 * collapse, and a reset. The reset is not decoration: a slider you have
 * dragged has no other way back to its default, and "roughly 1.00" is not
 * 1.00 when the next tool measures against it.
 *
 * Nothing here renders: these are the clip's intended transform, and the
 * viewer paints from the same numbers. Whoever owns the document decides what
 * becomes of them, through the shell's `onClipParamsChange`: given that, they
 * land as a `patch_clip` and join the undo stack, and without it they are a
 * preview that the viewer paints and nothing else reads. Either way changing
 * a value costs nothing at the time you change it.
 */

import { useRef, useState } from 'react';
import type { PlacedItem, MediaRef } from '@/lib/timeline/types.ts';
import { isClip } from '@/lib/timeline/document.ts';
import {
  rangeEnd, toTimecode, type Rate,
} from '@/lib/time/frames.ts';
import { clampTo, fieldText, nextField, type FieldState } from './numberField.ts';
import { BLEND_MODES, DEFAULT_CLIP_PARAMS, type ClipParams } from './types.ts';

// ── the values ──────────────────────────────────────────────────────────

export type { ClipParams } from './types.ts';
export { BLEND_MODES, DEFAULT_CLIP_PARAMS } from './types.ts';

type NumericKey = {
  [K in keyof ClipParams]: ClipParams[K] extends number ? K : never;
}[keyof ClipParams];

type ToggleKey = {
  [K in keyof ClipParams]: ClipParams[K] extends boolean ? K : never;
}[keyof ClipParams];

/**
 * `preview` marks a value the renderer cannot honour.
 *
 * There is no stereo-placement node in the editor API, so Pan moves the
 * viewer and nothing else. Saying so on the row is the alternative to a
 * control that silently does not survive the export, which is the worse of
 * the two.
 *
 * Opacity, Blend, Zoom and Position all carried this mark for a while and
 * none of them should have. They render: `ffmpeg/custom` takes two wired
 * inputs, and ffmpeg's own filters do the modes (`blend`) and the placement
 * (`scale` and `overlay`). The mark came from reading the operation list,
 * finding no one operation that did it, and stopping there.
 */
interface SliderRow {
  kind: 'slider';
  key: NumericKey;
  name: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  preview?: true;
}

interface SelectRow {
  kind: 'select';
  key: NumericKey;
  name: string;
  options: readonly string[];
  preview?: true;
}

type Row = SliderRow | SelectRow;

interface Group {
  key: string;
  name: string;
  toggle: ToggleKey;
  openByDefault: boolean;
  rows: Row[];
}

const f = (digits: number) => (v: number) => v.toFixed(digits);

const GROUPS: Group[] = [
  {
    key: 'transform', name: 'Transform', toggle: 'transformOn', openByDefault: true,
    rows: [
      { kind: 'slider', key: 'zoom', name: 'Zoom', min: 0.25, max: 4, step: 0.01, format: f(3) },
      { kind: 'slider', key: 'posX', name: 'Position X', min: -200, max: 200, step: 1, format: f(0) },
      { kind: 'slider', key: 'posY', name: 'Position Y', min: -200, max: 200, step: 1, format: f(0) },
      { kind: 'slider', key: 'rotation', name: 'Rotation', min: -180, max: 180, step: 0.5, format: f(1) },
    ],
  },
  {
    key: 'composite', name: 'Composite', toggle: 'compositeOn', openByDefault: true,
    rows: [
      { kind: 'select', key: 'blend', name: 'Mode', options: BLEND_MODES },
      { kind: 'slider', key: 'opacity', name: 'Opacity', min: 0, max: 100, step: 1, format: f(1) },
    ],
  },
  {
    key: 'audio', name: 'Volume', toggle: 'audioOn', openByDefault: true,
    rows: [
      { kind: 'slider', key: 'gainDb', name: 'Gain dB', min: -24, max: 12, step: 0.1, format: f(1) },
      { kind: 'slider', key: 'pan', name: 'Pan', min: -1, max: 1, step: 0.01, format: f(2), preview: true },
    ],
  },
];

// ── the panel ───────────────────────────────────────────────────────────

export interface InspectorProps {
  clip: PlacedItem | null;
  rate: Rate;
  media?: MediaRef | null;
  params: ClipParams;
  onChange: (next: ClipParams) => void;
}

export function Inspector({ clip, rate, media, params, onChange }: InspectorProps) {
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(GROUPS.map((g) => [g.key, g.openByDefault])),
  );

  const item = clip && isClip(clip.item) ? clip.item : null;
  const set = (patch: Partial<ClipParams>) => onChange({ ...params, ...patch });

  const resetGroup = (g: Group) => {
    const patch: Partial<ClipParams> = {};
    for (const row of g.rows) patch[row.key] = DEFAULT_CLIP_PARAMS[row.key];
    set(patch);
  };

  const [keyframes, setKeyframes] = useState<Record<string, boolean>>({});

  return (
    <>
      <style href="cutroom-inspector" precedence="medium">{CSS}</style>
      <aside className="cr-insp" aria-label="Inspector">
        <div className="cr-ibody">
          {!item || !clip ? (
            <div className="cr-inone">
              <ClipboardIcon />
              <span>
                <strong>No clip selected</strong>
                Click a clip in the timeline to see and change what it does.
              </span>
            </div>
          ) : (
            <>
              <div className="cr-ihead">
                <div className="cr-ihname">{item.name}</div>
                <div className="cr-ihmeta">
                  {clip.trackId} · {toTimecode(clip.range.start, rate)} →{' '}
                  {toTimecode(rangeEnd(clip.range), rate)} · {clip.range.duration} frames
                </div>
              </div>

              {GROUPS.map((g) => (
                <section className="cr-grp" key={g.key} data-open={open[g.key] ? 'true' : undefined}>
                  <div className="cr-grphd">
                    <button
                      type="button"
                      className="cr-tg"
                      role="switch"
                      aria-checked={params[g.toggle]}
                      aria-label={`${g.name} enabled`}
                      data-on={params[g.toggle] ? 'true' : undefined}
                      onClick={() => set({ [g.toggle]: !params[g.toggle] } as Partial<ClipParams>)}
                    />
                    <button
                      type="button"
                      className="cr-grpname"
                      aria-expanded={!!open[g.key]}
                      onClick={() => setOpen((p) => ({ ...p, [g.key]: !p[g.key] }))}
                    >
                      <span className="cr-ch" aria-hidden="true">▶</span>
                      {g.name}
                    </button>
                    <button
                      type="button"
                      className="cr-rs"
                      aria-label={`Reset ${g.name}`}
                      title={`Reset ${g.name}`}
                      onClick={() => resetGroup(g)}
                    >
                      <ResetIcon />
                    </button>
                  </div>

                  {open[g.key] ? (
                    <div className="cr-grpbody" data-bypassed={params[g.toggle] ? undefined : 'true'}>
                      {g.rows.map((row) => (
                        <ParamRow
                          key={row.key}
                          row={row}
                          value={params[row.key]}
                          keyframed={Boolean(keyframes[row.key])}
                          onToggleKeyframe={() => setKeyframes((k) => ({ ...k, [row.key]: !k[row.key] }))}
                          onValue={(v) => set({ [row.key]: v } as Partial<ClipParams>)}
                          onReset={() => {
                            setKeyframes((k) => ({ ...k, [row.key]: false }));
                            set({ [row.key]: DEFAULT_CLIP_PARAMS[row.key] } as Partial<ClipParams>);
                          }}
                        />
                      ))}
                    </div>
                  ) : null}
                </section>
              ))}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function ParamRow({
  row, value, keyframed, onValue, onReset, onToggleKeyframe,
}: {
  row: Row;
  value: number;
  keyframed?: boolean;
  onValue: (v: number) => void;
  onReset: () => void;
  onToggleKeyframe?: () => void;
}) {
  const id = `cr-p-${row.key}`;

  const mark = row.preview ? (
    <abbr className="cr-pv" title="Moves the viewer. No operation renders this yet, so it does not reach the exported file.">
      preview
    </abbr>
  ) : null;

  const diamond = onToggleKeyframe && row.kind === 'slider' ? (
    <button
      type="button"
      className={`cr-kf-diamond${keyframed ? ' on' : ''}`}
      onClick={onToggleKeyframe}
      title={keyframed ? `Remove keyframe on ${row.name}` : `Add keyframe on ${row.name}`}
      aria-label={keyframed ? `Remove keyframe on ${row.name}` : `Add keyframe on ${row.name}`}
      aria-pressed={keyframed}
    >
      {keyframed ? '◆' : '◇'}
    </button>
  ) : null;

  if (row.kind === 'select') {
    return (
      <div className="cr-prow" data-preview={row.preview ? 'true' : undefined}>
        <label className="cr-lb" htmlFor={id}>{row.name}{mark}</label>
        <select id={id} value={value} onChange={(e) => onValue(Number(e.target.value))}>
          {row.options.map((o, i) => <option key={o} value={i}>{o}</option>)}
        </select>
        <button type="button" className="cr-rs1" aria-label={`Reset ${row.name}`} onClick={onReset}>
          <ResetIcon />
        </button>
      </div>
    );
  }

  return (
    <div className="cr-prow" data-preview={row.preview ? 'true' : undefined}>
      <label className="cr-lb" htmlFor={id}>{row.name}{mark}</label>
      <span className="cr-sl">
        <input
          id={id}
          type="range"
          min={row.min}
          max={row.max}
          step={row.step}
          value={value}
          onChange={(e) => onValue(clampTo(Number(e.target.value), row))}
        />
      </span>
      <NumberField row={row} value={value} onValue={onValue} />
      {diamond}
      <button type="button" className="cr-rs1" aria-label={`Reset ${row.name}`} onClick={onReset}>
        <ResetIcon />
      </button>
    </div>
  );
}

/**
 * The typed-in half of a slider row.
 *
 * The draft is the text you are typing and it is shown verbatim: no clamp, no
 * re-format, no argument. It becomes a value on Enter or on blur, and Escape
 * throws it away. A value that arrives from somewhere else, the slider beside
 * it or a group reset, ends the draft, because that number is now the truth.
 */
function NumberField({
  row, value, onValue,
}: {
  row: SliderRow;
  value: number;
  onValue: (v: number) => void;
}) {
  const [state, setState] = useState<FieldState>({ draft: null, value });
  const el = useRef<HTMLInputElement | null>(null);

  // a value that arrived from the slider or a reset while a draft was open
  if (state.value !== value) setState(nextField(state, { t: 'value', value }, row));

  const commit = () => {
    const next = nextField(state, { t: 'commit' }, row);
    setState(next);
    if (next.value !== value) onValue(next.value);
  };

  return (
    <input
      ref={el}
      className="cr-nv"
      inputMode="decimal"
      aria-label={`${row.name} value`}
      value={fieldText(state, row.format)}
      onChange={(e) => setState((s) => nextField(s, { t: 'type', text: e.target.value }, row))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); el.current?.blur(); return; }
        if (e.key === 'Escape') { e.preventDefault(); setState((s) => nextField(s, { t: 'cancel' }, row)); }
      }}
    />
  );
}

const ClipboardIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
    strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M8 5v14M16 5v14M3 9.7h5M3 14.3h5M16 9.7h5M16 14.3h5" />
  </svg>
);

const ResetIcon = () => (
  <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
    <path d="M13 8a5 5 0 11-1.6-3.7M13 2v3h-3" />
  </svg>
);

const CSS = `
/* fills its column. flex:none here sized the panel to its own content and
   left the rest of the column as dead black beside it */
.cr-insp{
  flex:1 1 auto;background:var(--panel);display:flex;flex-direction:column;
  min-height:0;min-width:0;font-family:var(--ui);height:100%;
}
.cr-ibody{flex:1;overflow:auto;min-height:0}
.cr-inone{
  min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:9px;padding:24px 18px;margin:0;color:var(--t3);font-size:11.5px;
  text-align:center;line-height:1.55;min-height:0;
}
.cr-inone strong{display:block;color:var(--t2);font-size:12px;font-weight:600}
.cr-inone svg{color:var(--edge-soft)}
.cr-ihead{padding:8px 10px;border-bottom:1px solid var(--edge);background:var(--panel-2)}
.cr-ihname{
  font-size:12px;font-weight:600;color:var(--t1);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.cr-ihmeta{font-family:var(--mono);font-size:10px;color:var(--t3);margin-top:3px}

.cr-grp{border-bottom:1px solid var(--edge)}
.cr-grphd{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--panel-2)}
.cr-tg{
  width:9px;height:9px;border-radius:50%;flex:none;background:var(--ctl-off);
  border:0;padding:0;cursor:pointer;
}
.cr-tg[data-on]{background:var(--ctl-on)}
.cr-grp[data-open] .cr-tg[data-on]{background:var(--orange)}
.cr-grpname{
  flex:1;font-size:11.5px;font-weight:600;color:var(--t1);letter-spacing:.01em;
  background:none;border:0;cursor:pointer;font-family:inherit;text-align:left;
  display:flex;align-items:center;gap:7px;padding:0;
}
.cr-ch{color:var(--t3);font-size:9px;transition:transform .15s;display:inline-block}
.cr-grp[data-open] .cr-ch{transform:rotate(90deg)}
.cr-rs,.cr-rs1{
  color:var(--t3);display:flex;align-items:center;justify-content:center;
  background:none;border:0;cursor:pointer;padding:0;flex:none;
}
.cr-rs{width:16px;height:16px}
.cr-rs1{width:14px;height:14px}
.cr-rs:hover,.cr-rs1:hover{color:var(--t1)}
.cr-grpbody{padding:6px 10px 10px}
/* a bypassed group still shows its numbers, they are what it will do when
   it is switched back on, but reads as not currently applied */
.cr-grpbody[data-bypassed]{opacity:.45}

.cr-prow{display:flex;align-items:center;gap:7px;padding:3px 0;min-height:24px}
.cr-lb{width:74px;flex:none;font-size:11px;color:var(--t2);text-align:right}
/* a value the renderer cannot honour. Marked rather than hidden: it still
   drives the viewer, and hiding it would leave no way to preview an intent */
.cr-pv{
  display:block;font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--yellow);text-decoration:none;border:0;cursor:help;line-height:1.3;
}
.cr-prow[data-preview] .cr-sl input::-webkit-slider-thumb{background:var(--yellow)}
.cr-prow[data-preview] .cr-sl input::-moz-range-thumb{background:var(--yellow)}
.cr-sl{flex:1;position:relative;height:14px;display:flex;align-items:center;min-width:0}
.cr-sl input{
  -webkit-appearance:none;appearance:none;width:100%;height:3px;border-radius:4px;
  background:var(--app);outline:none;cursor:pointer;margin:0;
}
.cr-sl input:focus-visible{outline:1px solid var(--orange);outline-offset:3px}
.cr-sl input::-webkit-slider-thumb{
  -webkit-appearance:none;width:9px;height:13px;border-radius:1px;
  background:var(--ctl-on);cursor:grab;border:0;
}
.cr-sl input::-moz-range-thumb{
  width:9px;height:13px;border-radius:1px;background:var(--ctl-on);cursor:grab;border:0;
}
.cr-nv{
  width:52px;flex:none;font-family:var(--mono);font-size:10.5px;text-align:right;
  color:var(--t1);font-variant-numeric:tabular-nums;
  background:var(--app);border:1px solid var(--edge-soft);border-radius:4px;padding:2px 4px;
}
.cr-nv:focus{outline:none;border-color:var(--orange)}
.cr-prow select{
  flex:1;background:var(--app);border:1px solid var(--edge-soft);border-radius:4px;
  color:var(--t1);font-size:11px;padding:3px 5px;font-family:var(--ui);min-width:0;
}
.cr-prow select:focus{outline:none;border-color:var(--orange)}
.cr-kf-diamond{
  display:inline-flex;align-items:center;justify-content:center;
  width:16px;height:16px;padding:0;background:none;border:none;
  color:var(--t3);font-size:11px;cursor:pointer;flex:none;
  transition:color .12s,transform .12s;
}
.cr-kf-diamond:hover{color:var(--orange);transform:scale(1.2)}
.cr-kf-diamond.on{color:var(--orange)}
`;
