'use client';

/**
 * The tooltip layer.
 *
 * The tool rail is icon-only, and the only thing that makes an icon-only rail
 * honest is that hovering answers the question *immediately*. So this is a
 * single fixed-position element positioned on pointerenter with no delay and
 * no transition, a tooltip that fades in after 400ms is a tooltip nobody
 * waits for, and the icons would then be unlabelled buttons.
 *
 * One element for the whole app rather than one per trigger: a tooltip that
 * lives inside its trigger is clipped by every `overflow:hidden` ancestor,
 * and the rail is a scrolling column.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Build a `data-tip` payload.
 *
 * Three fields, pipe-separated: the name, the sentence, and the meta line
 * (a shortcut, a cost, or the reason the thing cannot run). Any literal pipe
 * in the text is swapped for a box-drawing bar so the split stays total.
 */
export function tip(name: string, description?: string, meta?: string): string {
  const clean = (s: string) => s.replace(/\|/g, '│');
  return [name, description ?? '', meta ?? ''].map(clean).join('|');
}

interface TipState {
  name: string;
  desc: string;
  meta: string;
  rect: DOMRect;
  /** Rail tooltips sit beside the icon; everything else hangs below it. */
  side: boolean;
}

// useLayoutEffect is the right hook, it must measure and place before paint,
// or the first frame shows the tip at the origin, but it does nothing during
// SSR, so fall back rather than warn.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const GAP = 8;
const EDGE = 6;

export function TooltipLayer() {
  const [state, setState] = useState<TipState | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const owner = useRef<Element | null>(null);

  const hide = useCallback(() => {
    owner.current = null;
    setState(null);
  }, []);

  const show = useCallback((el: Element) => {
    const raw = el.getAttribute('data-tip');
    if (!raw) return;
    const [name, desc = '', meta = ''] = raw.split('|');
    owner.current = el;
    setState({
      name,
      desc,
      meta,
      rect: el.getBoundingClientRect(),
      side: !!el.closest('[data-tip-side="right"]') && window.innerWidth > 860,
    });
  }, []);

  useEffect(() => {
    const find = (t: EventTarget | null): Element | null =>
      t instanceof Element ? t.closest('[data-tip]') : null;

    const over = (e: PointerEvent) => {
      const el = find(e.target);
      if (el === owner.current) return;
      if (el) show(el); else hide();
    };
    // Keyboard users get the same sentence: focus is a hover for the Tab key.
    const focus = (e: FocusEvent) => {
      const el = find(e.target);
      if (el) show(el); else hide();
    };

    document.addEventListener('pointerover', over);
    document.addEventListener('focusin', focus);
    document.addEventListener('pointerdown', hide);
    // a scrolled anchor invalidates the measurement the tip was placed from
    document.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('pointerover', over);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('pointerdown', hide);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, [show, hide]);

  /**
   * Measure, place, reveal, all before the browser paints, and all written
   * straight to the node. Routing the position through state would cost a
   * second render, and the point of this component is that there is no wait
   * between the pointer arriving and the sentence being readable.
   */
  useIsomorphicLayoutEffect(() => {
    const el = box.current;
    if (!state || !el) return;
    const r = state.rect;
    const t = el.getBoundingClientRect();
    let x = state.side ? r.right + GAP : r.left + r.width / 2 - t.width / 2;
    let y = state.side ? r.top + r.height / 2 - t.height / 2 : r.bottom + GAP - 1;
    // below the anchor unless that would run off the bottom, then above it
    if (!state.side && y + t.height > window.innerHeight - EDGE) y = r.top - t.height - GAP + 1;
    x = Math.max(EDGE, Math.min(x, window.innerWidth - t.width - EDGE));
    y = Math.max(EDGE, Math.min(y, window.innerHeight - t.height - EDGE));
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    el.style.visibility = 'visible';
  }, [state]);

  return (
    <>
      <style href="cutroom-tooltip" precedence="medium">{CSS}</style>
      {state ? (
        <div ref={box} className="cr-tip" role="tooltip">
          <b>{state.name}</b>
          {state.desc ? <span>{state.desc}</span> : null}
          {state.meta ? <i>{state.meta}</i> : null}
        </div>
      ) : null}
    </>
  );
}

const CSS = `
.cr-tip{
  /* hidden until the layout effect has measured and placed it */
  visibility:hidden;
  position:fixed;top:0;left:0;z-index:200;pointer-events:none;
  max-width:238px;background:var(--app);
  border:1px solid var(--edge-soft);border-left:2px solid var(--orange);
  border-radius:6px;padding:7px 9px;
  box-shadow:0 10px 28px color-mix(in srgb, var(--app) 62%, transparent);
  display:flex;flex-direction:column;gap:3px;
  font-family:var(--ui);
}
.cr-tip b{font-size:11.5px;font-weight:600;color:var(--t1);line-height:1.25}
.cr-tip span{font-size:10.5px;color:var(--t2);line-height:1.42;white-space:pre-line}
.cr-tip i{
  font-style:normal;font-family:var(--mono);font-size:9px;color:var(--t3);
  letter-spacing:.04em;line-height:1.4;
}
`;
