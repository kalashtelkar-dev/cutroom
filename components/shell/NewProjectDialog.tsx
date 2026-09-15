'use client';

/**
 * New project dialog.
 *
 * Lets the user name a project, pick a frame rate, and choose a track layout
 * template before creating the empty timeline document.
 */
import { useState } from 'react';
import { RATES, type Rate } from '@/lib/time/frames.ts';
import { PROJECT_TEMPLATES, type ProjectTemplate } from '@/lib/timeline/templates.ts';

export interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, rate: Rate, templateId: string) => void;
}

const RATE_OPTIONS: { label: string; rate: Rate }[] = [
  { label: '24 fps (Film standard)', rate: RATES.film },
  { label: '23.976 fps (NTSC film)', rate: RATES.ntscFilm },
  { label: '25 fps (PAL)', rate: RATES.pal },
  { label: '29.97 fps (NTSC broadcast)', rate: RATES.ntsc },
  { label: '30 fps (Web video)', rate: RATES.web },
  { label: '60 fps (High frame rate)', rate: RATES.high },
];

export function NewProjectDialog({ open, onClose, onCreate }: NewProjectDialogProps) {
  const [name, setName] = useState('Untitled');
  const [rateIdx, setRateIdx] = useState(0);
  const [templateId, setTemplateId] = useState('standard');

  if (!open) return null;

  return (
    <div className="cr-open" role="dialog" aria-modal="true" aria-labelledby="cr-new-proj-title">
      <div className="cr-open-box" style={{ maxWidth: 460 }}>
        <header className="cr-open-head">
          <h2 id="cr-new-proj-title" style={{ fontSize: 13, fontWeight: 600 }}>New project</h2>
          <button type="button" className="cr-open-x" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onCreate(name.trim() || 'Untitled', RATE_OPTIONS[rateIdx].rate, templateId);
            onClose();
          }}
          style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}
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
                      style={{ marginTop: 2 }}
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
