// ============================================
// Tooltip — lightweight hover/focus label
//
// CSS-positioned (no floating-ui dependency): shows a small themed bubble
// above the wrapped element on hover or keyboard focus, after a short
// delay. Honors prefers-reduced-motion (fade is a transition, and framer
// isn't involved). Intended for icon-only toolbar buttons — pair with
// <Button iconOnly aria-label>.
// ============================================

import { useId, useRef, useState } from 'react';
import { cn } from '@/utils/cn';

export interface TooltipProps {
  /** Tooltip text. Keep it short — this is a label, not documentation. */
  content: string;
  /** Delay before showing, ms. */
  delay?: number;
  /** Placement relative to the wrapped element. */
  side?: 'top' | 'bottom';
  /** Horizontal alignment. Use start/end for triggers near viewport edges. */
  align?: 'start' | 'center' | 'end';
  children: React.ReactNode;
}

export default function Tooltip({ content, delay = 400, side = 'top', align = 'center', children }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const show = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(true), delay);
  };

  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setVisible(false);
  };

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={visible ? id : undefined}
    >
      {children}
      {visible && (
        <span
          id={id}
          role="tooltip"
          style={
            align === 'start'
              ? { left: 0 }
              : align === 'end'
                ? { right: 0 }
                : { left: '50%', transform: 'translateX(-50%)' }
          }
          className={cn(
            'pointer-events-none absolute z-[70]',
            side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
            'whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-medium',
            'bg-ink text-canvas shadow-lg'
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
