'use client';

/**
 * A panel divider.
 *
 * Pointer-driven, but arrow-key operable once focused and double-clickable
 * back to its default, a divider you can only drag is a divider a keyboard
 * user cannot move at all, and "I made the inspector 3px wide" needs a way
 * back that is not a page reload.
 *
 * Controlled: the owner holds the size, because the panel it resizes is laid
 * out by the owner and two sources of truth for one number drift.
 */

import { useCallback, useEffect, useRef } from 'react';

export interface ResizerProps {
  /** 'vertical' is a vertical bar between two columns; it resizes a width. */
  orientation: 'vertical' | 'horizontal';
  size: number;
  min: number;
  max: number;
  /** Restored on double-click. */
  defaultSize: number;
  /**
   * True when the panel being sized is *after* the divider, so dragging right
   * must shrink it rather than grow it.
   */
  invert?: boolean;
  label: string;
  onResize: (size: number) => void;
  /** Fired on the double-click reset, for a toast. */
  onReset?: (size: number) => void;
}

const STEP = 12;
const STEP_COARSE = 48;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function Resizer({
  orientation,
  size,
  min,
  max,
  defaultSize,
  invert = false,
  label,
  onResize,
  onReset,
}: ResizerProps) {
  const axisX = orientation === 'vertical';
  const drag = useRef<{ from: number; size: number } | null>(null);
  const el = useRef<HTMLDivElement | null>(null);

  const apply = useCallback(
    (next: number) => onResize(Math.round(clamp(next, min, max))),
    [onResize, min, max],
  );

  // The cursor must survive leaving the 1px handle mid-drag, and a pointer
  // capture alone does not change what the rest of the page shows.
  useEffect(() => () => { document.body.style.cursor = ''; }, []);

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { from: axisX ? e.clientX : e.clientY, size };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.dataset.dragging = 'true';
    document.body.style.cursor = axisX ? 'col-resize' : 'row-resize';
    e.preventDefault();
  };

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const delta = (axisX ? e.clientX : e.clientY) - d.from;
    apply(d.size + (invert ? -delta : delta));
  };

  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    delete e.currentTarget.dataset.dragging;
    document.body.style.cursor = '';
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  };

  const key = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dec = axisX ? 'ArrowLeft' : 'ArrowUp';
    const inc = axisX ? 'ArrowRight' : 'ArrowDown';
    if (e.key === 'Home') {
      e.preventDefault();
      apply(defaultSize);
      onReset?.(defaultSize);
      return;
    }
    if (e.key !== dec && e.key !== inc) return;
    e.preventDefault();
    const step = (e.shiftKey ? STEP_COARSE : STEP) * (e.key === inc ? 1 : -1) * (invert ? -1 : 1);
    apply(size + step);
  };

  return (
    <>
      <style href="cutroom-resizer" precedence="medium">{CSS}</style>
      <div
        ref={el}
        className={`cr-rz cr-rz-${orientation === 'vertical' ? 'v' : 'h'}`}
        role="separator"
        tabIndex={0}
        aria-orientation={orientation}
        aria-label={label}
        aria-valuenow={Math.round(size)}
        aria-valuemin={min}
        aria-valuemax={max}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
        onDoubleClick={() => { apply(defaultSize); onReset?.(defaultSize); }}
      />
    </>
  );
}

/* The hit area is 7px of invisible padding around a 1px rule: a 1px target is
   unhittable, and a 7px rule is a gutter. */
const CSS = `
.cr-rz{flex:none;background:var(--edge);position:relative;z-index:12;touch-action:none}
.cr-rz::after{content:"";position:absolute;background:transparent}
.cr-rz-v{width:1px;cursor:col-resize}
.cr-rz-v::after{top:0;bottom:0;left:-3px;right:-3px}
.cr-rz-h{height:1px;cursor:row-resize}
.cr-rz-h::after{left:0;right:0;top:-3px;bottom:-3px}
.cr-rz:hover::after,.cr-rz[data-dragging]::after,.cr-rz:focus-visible::after{background:var(--orange)}
.cr-rz[data-dragging]{background:var(--orange)}
.cr-rz:focus-visible{outline:none;background:var(--orange)}
@media (max-width:860px){
  .cr-rz-v{display:none}
  .cr-rz-h{cursor:default}
}
`;
