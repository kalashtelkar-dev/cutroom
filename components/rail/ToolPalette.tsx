'use client';

/**
 * The all-tools palette: the answer to "what happens when there are sixty".
 *
 * It searches the card's match phrases and quoted examples, not just names,
 * so typing what you want ("cutaway", "louder", "shorter") finds the tool the
 * assistant would have chosen for the same words. When a phrase is what
 * caught the row, the row shows that phrase: you learn the vocabulary the
 * router actually understands instead of guessing at it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ToolIcon } from './ToolRail.tsx';
import type { Tool, ToolContext } from './tools.ts';
import { searchTools, toolBlurb, toolCost, toolWhy } from './tools.ts';

export interface ToolPaletteProps {
  open: boolean;
  tools: Tool[];
  context: ToolContext;
  onPick: (tool: Tool, reason: string | null) => void;
  onClose: () => void;
}

export function ToolPalette({ open, tools, context, onPick, onClose }: ToolPaletteProps) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const search = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const hits = useMemo(() => searchTools(tools, query), [tools, query]);

  // Opening starts from a blank query. Adjusting during render rather than in
  // an effect means the first frame of the palette is already empty, a
  // palette that shows the last search for one frame reads as broken.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) { setQuery(''); setCursor(0); }
  }

  useEffect(() => { if (open) search.current?.focus(); }, [open]);

  // keep the highlighted row in view when the arrow keys walk past the fold
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-cursor="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor, query]);

  if (!open) return null;

  const pick = (i: number) => {
    const hit = hits[i];
    if (!hit) return;
    onPick(hit.tool, toolWhy(hit.tool, context));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); return; }
    if (e.key === 'Enter') { e.preventDefault(); pick(cursor); }
  };

  const rows = hits.map((hit, i) => ({
    hit,
    head: i === 0 || hits[i - 1].tool.group !== hit.tool.group ? hit.tool.group : null,
  }));

  return (
    <>
      <style href="cutroom-palette" precedence="medium">{CSS}</style>
      <div
        className="cr-modal"
        onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
        onKeyDown={onKeyDown}
      >
        <div className="cr-mbox" role="dialog" aria-modal="true" aria-label="All tools">
          <div className="cr-mhead">
            <h3>Tools</h3>
            <span className="cr-mcount">{hits.length} of {tools.length}</span>
            <button type="button" className="cr-mclose" aria-label="Close" onClick={onClose}>
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>

          <div className="cr-msearch">
            <input
              ref={search}
              className="cr-palsearch"
              value={query}
              spellCheck={false}
              placeholder="What do you want to do? Try “cutaway”, “louder”, “shorter”"
              aria-label="Search tools"
              onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
            />
          </div>

          <div className="cr-mbody" ref={listRef}>
            {hits.length === 0 ? (
              <p className="cr-palnone">
                Nothing matches that. Try what you want to do, “cutaway”, “louder”, “shorter”.
              </p>
            ) : (
              rows.map(({ hit, head }, i) => {
                const why = toolWhy(hit.tool, context);
                return (
                  <div key={hit.tool.id}>
                    {head ? <div className="cr-palgrp">{head}</div> : null}
                    <button
                      type="button"
                      className="cr-palrow"
                      data-off={why ? 'true' : undefined}
                      data-cursor={i === cursor ? 'true' : undefined}
                      aria-disabled={why ? true : undefined}
                      onPointerEnter={() => setCursor(i)}
                      onFocus={() => setCursor(i)}
                      onClick={() => pick(i)}
                    >
                      <span className="cr-palic"><ToolIcon shapes={hit.tool.icon} size={16} /></span>
                      <span className="cr-paltx">
                        <b>
                          {hit.tool.name}
                          {hit.phrase ? (
                            <em title={`the tool’s own ${hit.from} phrase`}>{hit.phrase}</em>
                          ) : null}
                        </b>
                        <span>{why ? `can’t run yet, ${why}` : toolBlurb(hit.tool)}</span>
                      </span>
                      <span className="cr-palcost">{toolCost(hit.tool)}</span>
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="cr-mfoot">
            <div className="cr-pallegend">
              <span><i /> local · instant</span>
              <span><i data-tier="1" /> one operation</span>
              <span><i data-tier="2" /> pipeline · GPU</span>
            </div>
            <span className="cr-mkbd">Cmd / Ctrl + K</span>
          </div>
        </div>
      </div>
    </>
  );
}

const CSS = `
.cr-modal{
  position:fixed;inset:0;z-index:130;
  background:color-mix(in srgb, var(--app) 62%, transparent);
  display:flex;align-items:center;justify-content:center;padding:20px;
}
.cr-mbox{
  width:min(560px,100%);max-height:86vh;background:var(--panel);
  border:1px solid var(--edge-soft);border-radius:8px;
  display:flex;flex-direction:column;overflow:hidden;
  box-shadow:0 20px 60px color-mix(in srgb, var(--app) 60%, transparent);
  font-family:var(--ui);
}
.cr-mhead{
  display:flex;align-items:center;gap:10px;padding:12px 15px;
  border-bottom:1px solid var(--edge);background:var(--panel-2);
}
.cr-mhead h3{margin:0;font-size:14px;font-weight:700;flex:1;color:var(--t1)}
.cr-mcount{font-family:var(--mono);font-size:10px;color:var(--t3)}
.cr-mclose{
  width:26px;height:24px;border-radius:4px;color:var(--t2);border:0;background:none;
  display:flex;align-items:center;justify-content:center;cursor:pointer;
}
.cr-mclose:hover{background:var(--edge);color:var(--t1)}
.cr-msearch{padding:12px 15px 0}
.cr-palsearch{
  width:100%;background:var(--app);border:1px solid var(--edge-soft);border-radius:4px;
  color:var(--t1);font-family:var(--ui);font-size:13px;padding:7px 9px;
}
.cr-palsearch:focus{outline:none;border-color:var(--orange)}
.cr-mbody{flex:1;overflow-y:auto;min-height:0;padding:8px 15px 14px}
.cr-palgrp{
  font-size:8.5px;font-weight:700;letter-spacing:.11em;color:var(--t3);margin:14px 0 6px;
}
.cr-mbody>div:first-child .cr-palgrp{margin-top:2px}
.cr-palrow{
  display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:4px;
  width:100%;text-align:left;background:none;border:0;cursor:pointer;font:inherit;color:inherit;
}
.cr-palrow[data-cursor],.cr-palrow:hover{background:var(--panel-2)}
.cr-palrow[data-off] .cr-palic,
.cr-palrow[data-off] .cr-paltx b,
.cr-palrow[data-off] .cr-palcost{opacity:.42}
.cr-palrow[data-off] .cr-paltx>span{color:var(--orange);opacity:.85}
.cr-palic{
  width:28px;height:28px;border-radius:3px;flex:none;background:var(--panel-2);
  display:flex;align-items:center;justify-content:center;color:var(--t2);
}
.cr-palrow[data-cursor] .cr-palic{background:var(--edge);color:var(--t1)}
.cr-paltx{flex:1;min-width:0}
.cr-paltx b{display:block;font-size:12px;font-weight:600;color:var(--t1)}
/* the phrase from the tool's own card that matched what you typed */
.cr-paltx b em{
  font-style:normal;font-family:var(--mono);font-size:9px;font-weight:500;
  color:var(--orange);background:color-mix(in srgb, var(--orange) 12%, transparent);
  padding:1px 4px;border-radius:4px;margin-left:6px;vertical-align:1px;
}
.cr-paltx>span{
  display:block;font-size:11px;color:var(--t3);line-height:1.35;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.cr-palcost{font-family:var(--mono);font-size:9.5px;color:var(--t3);flex:none}
.cr-palnone{padding:22px 8px;font-size:12px;color:var(--t3);text-align:center;margin:0}
.cr-mfoot{
  display:flex;gap:8px;align-items:center;padding:11px 15px;
  border-top:1px solid var(--edge);background:var(--app);
}
.cr-pallegend{display:flex;gap:14px;align-items:center;font-size:10px;color:var(--t3);flex-wrap:wrap;flex:1}
.cr-pallegend i{
  width:5px;height:5px;border-radius:50%;display:inline-block;
  margin-right:5px;vertical-align:middle;background:var(--t3);
}
.cr-pallegend i[data-tier="1"]{background:var(--yellow)}
.cr-pallegend i[data-tier="2"]{background:var(--orange)}
.cr-mkbd{font-family:var(--mono);font-size:10px;color:var(--t3)}
`;
