'use client';

/**
 * The "about to run" card a rail tool arms.
 *
 * A run card, not an instant launch. Anything dearer than a local document
 * patch shows what it is about to do and what it will do it to before it
 * spends the money, a rung-3 pipeline is GPU minutes, and the difference
 * between "run on the whole timeline" and "run on the selected clip" is the
 * difference between a coffee and a click.
 *
 * Rung-1 tools never get here: a 20ms patch that asks for confirmation is
 * just a slower patch. `runsLocally()` in tools.ts is what decides.
 */

import { useState } from 'react';
import { ToolIcon } from '../rail/ToolRail.tsx';
import type { Tool } from '../rail/tools.ts';
import { toolBlurb, toolCost, toolRung } from '../rail/tools.ts';

export interface ToolRunArgs {
  /** The chosen entry from `targets`, verbatim. */
  target: string;
  /** Parameter key → the chosen option, verbatim. */
  params: Record<string, string>;
}

export interface ToolRunCardProps {
  tool: Tool;
  /** What the tool can be pointed at, in the shell's own words. */
  targets: string[];
  /** Indices of `targets` that cannot be chosen, no selection, say. */
  disabledTargets?: number[];
  busy?: boolean;
  onRun: (tool: Tool, args: ToolRunArgs) => void;
  onCancel: () => void;
}

export function ToolRunCard({
  tool,
  targets,
  disabledTargets = [],
  busy = false,
  onRun,
  onCancel,
}: ToolRunCardProps) {
  const firstEnabled = targets.findIndex((_, i) => !disabledTargets.includes(i));
  const [target, setTarget] = useState(targets[Math.max(0, firstEnabled)] ?? '');
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (tool.params ?? []).map((p) => [p.key, p.options[p.defaultIndex] ?? p.options[0]]),
    ),
  );

  return (
    <>
      <style href="cutroom-toolruncard" precedence="medium">{CSS}</style>
      <div className="cr-tcard">
        <div className="cr-tch">
          <ToolIcon shapes={tool.icon} size={14} />
          <b>{tool.name}</b>
          <span className="cr-tcchip">{toolCost(tool) || 'local'}</span>
        </div>

        <div className="cr-tcb">
          <p className="cr-tcnote">{toolBlurb(tool)}</p>

          <div className="cr-tcrow">
            <label htmlFor={`${tool.id}-target`}>Run on</label>
            <select
              id={`${tool.id}-target`}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {targets.map((t, i) => (
                <option key={t} value={t} disabled={disabledTargets.includes(i)}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          {(tool.params ?? []).map((p) => (
            <div className="cr-tcrow" key={p.key}>
              <label htmlFor={`${tool.id}-${p.key}`}>{p.label}</label>
              <select
                id={`${tool.id}-${p.key}`}
                value={params[p.key]}
                onChange={(e) => setParams((prev) => ({ ...prev, [p.key]: e.target.value }))}
              >
                {p.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          ))}
        </div>

        <div className="cr-tcf">
          <span className="cr-tcmeta">rung {toolRung(tool)} · {tool.cardId}</span>
          <button type="button" className="cr-tcno" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="cr-tcgo"
            disabled={busy}
            onClick={() => onRun(tool, { target, params })}
          >
            {busy ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>
    </>
  );
}

const CSS = `
.cr-tcard{
  border:1px solid var(--orange);border-radius:8px;
  background:color-mix(in srgb, var(--orange) 7%, var(--panel));
  overflow:hidden;font-family:var(--ui);
}
.cr-tch{
  display:flex;align-items:center;gap:7px;padding:7px 9px;
  background:color-mix(in srgb, var(--orange) 10%, transparent);
  border-bottom:1px solid color-mix(in srgb, var(--orange) 22%, transparent);
  color:var(--orange);
}
.cr-tch b{font-size:11.5px;font-weight:600;flex:1;min-width:0;color:var(--t1)}
.cr-tcchip{
  font-family:var(--mono);font-size:9px;color:var(--t3);flex:none;
  border:1px solid var(--edge-soft);border-radius:4px;padding:1px 4px;
}
.cr-tcb{padding:9px;display:flex;flex-direction:column;gap:7px}
.cr-tcnote{font-size:10.5px;color:var(--t3);line-height:1.45;margin:0}
.cr-tcrow{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--t3)}
.cr-tcrow>label{width:62px;flex:none}
.cr-tcrow select{
  flex:1;min-width:0;background:var(--panel);border:1px solid var(--edge-soft);
  border-radius:4px;color:var(--t1);font-family:var(--ui);font-size:11px;padding:3px 5px;
}
.cr-tcrow select:focus{outline:none;border-color:var(--orange)}
.cr-tcf{
  display:flex;gap:6px;align-items:center;padding:7px 9px;
  border-top:1px solid var(--edge);background:color-mix(in srgb, var(--orange) 4%, var(--panel-2));
}
.cr-tcmeta{font-family:var(--mono);font-size:9.5px;color:var(--t3);flex:1;min-width:0}
.cr-tcno{
  color:var(--t3);font-size:11px;padding:4px 8px;border-radius:4px;
  background:none;border:0;cursor:pointer;font-family:inherit;
}
.cr-tcno:hover{color:var(--t1);background:var(--edge)}
.cr-tcgo{
  background:var(--orange);color:var(--t1);font-weight:600;font-size:11px;
  padding:4px 13px;border-radius:4px;border:0;cursor:pointer;font-family:inherit;
}
.cr-tcgo:disabled{background:var(--ctl-off);color:var(--t3);cursor:not-allowed}
`;
