'use client';

/**
 * New project dialog.
 *
 * Lets the user name a project, pick a frame rate, choose where the video is going
 * (destination format and resolution), and select a track layout template.
 */
import { useState } from 'react';
import { RATES, type Rate } from '@/lib/time/frames.ts';
import { PROJECT_TEMPLATES, type ProjectTemplate } from '@/lib/timeline/templates.ts';
import { TARGETS, type ExportTarget } from '@/lib/export/targets.ts';

export interface TargetChoice {
  targetId: string;
  width: number;
  height: number;
}

export interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, rate: Rate, templateId: string, target: TargetChoice) => void;
}

const RATE_OPTIONS: { label: string; rate: Rate }[] = [
  { label: '24 fps (Film standard)', rate: RATES.film },
  { label: '23.976 fps (NTSC film)', rate: RATES.ntscFilm },
  { label: '25 fps (PAL)', rate: RATES.pal },
  { label: '29.97 fps (NTSC broadcast)', rate: RATES.ntsc },
  { label: '30 fps (Web video)', rate: RATES.web },
  { label: '60 fps (High frame rate)', rate: RATES.high },
];

function ShapeMark({ target }: { target: ExportTarget }) {
  const long = 16;
  const w = target.width >= target.height ? long : Math.round((target.width / target.height) * long);
  const h = target.height >= target.width ? long : Math.round((target.height / target.width) * long);
  return (
    <span
      style={{
        width: 18,
        height: 18,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
      aria-hidden="true"
    >
      <i
        style={{
          display: 'block',
          width: w,
          height: h,
          border: '1.5px solid currentColor',
          borderRadius: 1.5,
          opacity: 0.8,
        }}
      />
    </span>
  );
}

export function NewProjectDialog({ open, onClose, onCreate }: NewProjectDialogProps) {
  const [name, setName] = useState('Untitled');
  const [rateIdx, setRateIdx] = useState(0);
  const [templateId, setTemplateId] = useState('standard');
  const [targetId, setTargetId] = useState('youtube');

  if (!open) return null;

  const chosenTarget = TARGETS.find((t) => t.id === targetId) ?? TARGETS[0];

  return (
    <div className="cr-open" role="dialog" aria-modal="true" aria-labelledby="cr-new-proj-title">
      <div className="cr-open-box" style={{ maxWidth: 540, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <header className="cr-open-head">
          <h2 id="cr-new-proj-title" style={{ fontSize: 13, fontWeight: 600 }}>New project</h2>
          <button type="button" className="cr-open-x" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onCreate(name.trim() || 'Untitled', RATE_OPTIONS[rateIdx].rate, templateId, {
              targetId: chosenTarget.id,
              width: chosenTarget.width,
              height: chosenTarget.height,
            });
            onClose();
          }}
          style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}
        >
          <div>
            <label
              htmlFor="cr-new-name"
              style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--t3)', marginBottom: 4 }}
            >
              PROJECT NAME
            </label>
            <input
              id="cr-new-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{
                width: '100%',
                background: 'var(--app)',
                border: '1px solid var(--edge-soft)',
                borderRadius: 4,
                padding: '6px 8px',
                color: 'var(--t1)',
                fontSize: 12,
                fontFamily: 'var(--ui)',
              }}
              autoFocus
            />
          </div>

          <div>
            <span style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--t3)', marginBottom: 6 }}>
              WHERE IS IT GOING?
            </span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 6 }}>
              {TARGETS.map((t) => {
                const checked = targetId === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTargetId(t.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 10px',
                      borderRadius: 5,
                      border: `1px solid ${checked ? 'var(--orange)' : 'var(--edge-soft)'}`,
                      background: checked ? 'color-mix(in srgb, var(--orange) 10%, var(--panel))' : 'var(--app)',
                      color: checked ? 'var(--t1)' : 'var(--t2)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: 'inherit',
                    }}
                  >
                    <ShapeMark target={t} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--t1)' }}>{t.name}</span>
                      <span style={{ display: 'block', fontSize: 10, color: 'var(--t3)', marginTop: 1 }}>{t.note}</span>
                    </div>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--t3)', flexShrink: 0 }}>
                      {t.width}x{t.height}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label
              htmlFor="cr-new-rate"
              style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--t3)', marginBottom: 4 }}
            >
              FRAME RATE
            </label>
            <select
              id="cr-new-rate"
              value={rateIdx}
              onChange={(e) => setRateIdx(Number(e.target.value))}
              style={{
                width: '100%',
                background: 'var(--app)',
                border: '1px solid var(--edge-soft)',
                borderRadius: 4,
                padding: '6px 8px',
                color: 'var(--t1)',
                fontSize: 12,
                fontFamily: 'var(--mono)',
              }}
            >
              {RATE_OPTIONS.map((opt, i) => (
                <option key={opt.label} value={i}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--t3)', marginBottom: 6 }}>
              TRACK LAYOUT TEMPLATE
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {PROJECT_TEMPLATES.map((tpl: ProjectTemplate) => {
                const checked = templateId === tpl.id;
                return (
                  <label
                    key={tpl.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      padding: '8px 10px',
                      borderRadius: 4,
                      border: `1px solid ${checked ? 'var(--orange)' : 'var(--edge-soft)'}`,
                      background: checked ? 'color-mix(in srgb, var(--orange) 8%, var(--panel))' : 'var(--panel-2)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="project-template"
                      value={tpl.id}
                      checked={checked}
                      onChange={() => setTemplateId(tpl.id)}
                      style={{ marginTop: 2, accentColor: 'var(--orange)' }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t1)' }}>{tpl.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--t3)' }}>{tpl.description}</span>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <button type="button" className="cr-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="cr-btn pri" style={{ background: 'var(--orange)', color: 'var(--on-accent)' }}>
              Create project
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
