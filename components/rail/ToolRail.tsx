'use client';

/**
 * The tool rail.
 *
 * Pipelines are tools, and tools live where you can always see them, never
 * behind a tab. Icon-only by intent: the sentence lives in the tooltip and is
 * read out of the same intel card the router reads, so a tool cannot describe
 * itself one way to a person and another way to the model.
 *
 * The corner dot is the cost tier, so you can see *before* you click whether
 * this is 20ms of local patching or GPU minutes.
 */

import type { IconShape, Tool, ToolContext } from './tools.ts';
import { toolCost, toolTier, toolTipParts, toolWhy } from './tools.ts';
import { tip } from '../ui/Tooltip.tsx';

export interface ToolRailProps {
  tools: Tool[];
  context: ToolContext;
  /** The tool whose run card is currently open in the assistant, if any. */
  armedToolId?: string | null;
  /**
   * Picked. `reason` is non-null when the tool's preconditions are unmet,
   * the rail still reports the click so the shell can say why out loud
   * rather than letting the button do nothing.
   */
  onPick: (tool: Tool, reason: string | null) => void;
  onOpenPalette: () => void;
}

/**
 * One glyph. The single renderer for tool icons, so the rail, the palette and
 * the run card cannot draw the same tool differently.
 */
export function ToolIcon({ shapes, size = 17 }: { shapes: readonly IconShape[]; size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.35}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shapes.map((s, i) => {
        if (s.k === 'rect') {
          return <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} rx={s.r ?? 0} />;
        }
        if (s.k === 'circle') {
          return (
            <circle
              key={i}
              cx={s.cx}
              cy={s.cy}
              r={s.r}
              fill={s.solid ? 'currentColor' : 'none'}
              stroke={s.solid ? 'none' : 'currentColor'}
            />
          );
        }
        return (
          <path
            key={i}
            d={s.d}
            strokeDasharray={s.dash}
            fill={s.solid ? 'currentColor' : 'none'}
            stroke={s.solid ? 'none' : 'currentColor'}
          />
        );
      })}
    </svg>
  );
}

export function ToolRail({
  tools,
  context,
  armedToolId = null,
  onPick,
  onOpenPalette,
}: ToolRailProps) {
  // the group heading belongs to the first tool of each run, decided up front
  // rather than by a variable that walks the list as it renders
  const rows = tools.map((tool, i) => ({
    tool,
    head: i === 0 || tools[i - 1].group !== tool.group ? tool.group : null,
  }));

  return (
    <>
      <style href="cutroom-rail" precedence="medium">{CSS}</style>
      <nav className="cr-rail" aria-label="Tools" data-tip-side="right">
        {rows.map(({ tool, head }) => {
          const why = toolWhy(tool, context);
          const tier = toolTier(tool);
          const [name, desc, meta] = toolTipParts(tool, context);
          return (
            <div key={tool.id} className="cr-rgrp-wrap">
              {head ? <div className="cr-rgrp">{head}</div> : null}
              <button
                type="button"
                className="cr-rtool"
                data-off={why ? 'true' : undefined}
                data-armed={armedToolId === tool.id ? 'true' : undefined}
                data-tip={tip(name, desc, meta)}
                aria-label={`${tool.name}, ${toolCost(tool) || 'local'}`}
                // still focusable and still clickable: a disabled button cannot
                // tell you why it is disabled, and that is the only thing you
                // want from it
                aria-disabled={why ? true : undefined}
                onClick={() => onPick(tool, why)}
              >
                <ToolIcon shapes={tool.icon} />
                {tier > 0 ? <i className="cr-dot" data-tier={tier} aria-hidden="true" /> : null}
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="cr-rmore"
          aria-label="All tools"
          data-tip={tip(
            'All tools',
            'Search every tool by what you want to do, not by its name. New pipelines land here automatically.',
            'Cmd / Ctrl + K',
          )}
          onClick={onOpenPalette}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
            <circle cx="3.6" cy="8" r="1.25" />
            <circle cx="8" cy="8" r="1.25" />
            <circle cx="12.4" cy="8" r="1.25" />
          </svg>
        </button>
      </nav>
    </>
  );
}

const CSS = `
.cr-rail{
  width:50px;flex:none;background:var(--panel-2);
  border-right:1px solid var(--edge);box-shadow:var(--lift);
  display:flex;flex-direction:column;align-items:center;
  padding:7px 0;gap:2px;overflow-y:auto;overflow-x:hidden;min-height:0;
  scrollbar-width:none;
}
.cr-rail::-webkit-scrollbar{width:0;height:0}
.cr-rgrp-wrap{display:contents}
.cr-rgrp{
  font-size:7.5px;font-weight:700;letter-spacing:.11em;color:var(--t3);
  flex:none;margin:6px 0 2px;
}
.cr-rail .cr-rgrp-wrap:first-child .cr-rgrp{margin-top:0}
.cr-rtool{
  width:36px;height:31px;border-radius:3px;flex:none;position:relative;
  display:flex;align-items:center;justify-content:center;color:var(--t2);
  background:none;border:0;padding:0;cursor:pointer;font:inherit;
}
.cr-rtool:hover{background:var(--edge);color:var(--t1)}
.cr-rtool[data-armed]{
  background:color-mix(in srgb, var(--orange) 15%, transparent);
  color:var(--orange);box-shadow:inset 0 0 0 1px var(--orange);
}
/* a tool whose preconditions are unmet stays visible and still explains
   itself on hover, hiding it would only be confusing */
.cr-rtool[data-off]{opacity:.3}
.cr-rtool[data-off]:hover{background:none;color:var(--t2)}
.cr-rtool[data-off] .cr-dot{opacity:.5}
.cr-dot{position:absolute;top:4px;right:5px;width:4px;height:4px;border-radius:50%}
.cr-dot[data-tier="1"]{background:var(--yellow)}
.cr-dot[data-tier="2"]{background:var(--orange)}
.cr-rmore{
  width:36px;height:26px;border-radius:3px;flex:none;color:var(--t3);
  display:flex;align-items:center;justify-content:center;margin-top:4px;
  border:1px dashed var(--edge-soft);background:none;cursor:pointer;padding:0;
}
.cr-rmore:hover{color:var(--orange);border-color:var(--orange)}

@media (max-width:860px){
  /* the rail lies down rather than disappearing, the tools stay one tap
     away at every width, which is the whole point of it */
  .cr-rail{
    width:auto;height:46px;flex-direction:row;align-items:center;
    padding:0 8px;gap:3px;overflow-x:auto;overflow-y:hidden;
    border-right:0;border-bottom:1px solid var(--edge);
  }
  .cr-rgrp{margin:0 3px 0 7px}
  .cr-rail .cr-rgrp-wrap:first-child .cr-rgrp{margin-left:0}
  .cr-rmore{margin:0 0 0 4px}
}
`;
