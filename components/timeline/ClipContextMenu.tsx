'use client';
/**
 * A right-click menu on a clip.
 *
 * The same commands that live in the menu bar, but reachable from the thing
 * they apply to. The menu closes on click, on Escape, and on any pointer
 * event outside it, which is the same behaviour as the menu bar.
 */
import { useEffect, useRef } from 'react';
import type { ClipId } from '../../lib/timeline/types.ts';

export interface ContextAction {
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
}

export interface ClipContextMenuProps {
  x: number;
  y: number;
  clipId: ClipId;
  actions: ContextAction[];
  onClose: () => void;
}

export function ClipContextMenu({ x, y, actions, onClose }: ClipContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // keep the menu on screen
  const style: React.CSSProperties = {
    left: x,
    top: y,
  };

  return (
    <div ref={ref} className="cr-ctx" style={style} role="menu" aria-label="Clip actions">
      {actions.map((a, i) => {
        if (a.label === '---') return <div key={i} className="cr-ctx-sep" />;
        return (
          <button
            key={a.label}
            type="button"
            role="menuitem"
            className={`cr-ctx-item${a.disabled ? ' off' : ''}`}
            aria-disabled={a.disabled}
            onClick={() => { if (!a.disabled) { a.run(); onClose(); } }}
          >
            <span>{a.label}</span>
            {a.hint ? <span className="hint">{a.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

