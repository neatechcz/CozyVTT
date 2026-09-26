// ============================================
// useFocusTrap — Accessibility hook for modals
// ============================================
//
// Traps keyboard focus inside a container when `isOpen` is true.
// Restores focus to the previously focused element on close.
// Handles Escape key to close the modal.

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTORS = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'audio[controls]',
  'video[controls]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

interface FocusTrapEntry {
  token: object;
  containerRef: RefObject<HTMLDivElement>;
}

// Only the topmost open dialog should handle keyboard events. This lets a
// ConfirmDialog safely open on top of a parent dialog without both traps
// closing or moving focus at once.
const activeTraps: FocusTrapEntry[] = [];

function focusFirst(container: HTMLElement | null) {
  if (!container) return;
  const first = container.querySelector<HTMLElement>(FOCUSABLE_SELECTORS);
  if (first) {
    first.focus();
  } else {
    container.setAttribute('tabindex', '-1');
    container.focus();
  }
}

/**
 * Traps keyboard focus inside a dialog container.
 *
 * @param isOpen  Whether the modal is currently open
 * @param onClose Called when the user presses Escape
 * @returns A ref to attach to the modal's root element
 */
export function useFocusTrap(
  isOpen: boolean,
  onClose?: () => void,
  returnFocusRef?: RefObject<HTMLElement>,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Keep a stable ref to the latest onClose callback.
  // This prevents the effect from re-running every time the parent re-renders
  // (which would steal focus from inputs on every keystroke).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;

    const entry: FocusTrapEntry = { token: {}, containerRef };
    activeTraps.push(entry);

    // Remember the element that had focus before the modal opened
    previousFocusRef.current = document.activeElement as HTMLElement;

    // Focus the first focusable element after the DOM has settled
    const frame = requestAnimationFrame(() => {
      if (activeTraps[activeTraps.length - 1] === entry) {
        focusFirst(containerRef.current);
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (activeTraps[activeTraps.length - 1] !== entry) return;

      // Escape closes the modal
      if (e.key === 'Escape') {
        if (onCloseRef.current) {
          e.preventDefault();
          onCloseRef.current();
        }
        return;
      }

      if (e.key !== 'Tab') return;

      const container = containerRef.current;
      if (!container) return;

      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)
      );

      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        // Shift+Tab: wrap from first → last
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab: wrap from last → first
        if (active === last || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      const index = activeTraps.indexOf(entry);
      const wasTopmost = index === activeTraps.length - 1;
      if (index !== -1) activeTraps.splice(index, 1);

      // Restore focus to the prior element, or back into the parent dialog
      // when a nested dialog closes.
      if (wasTopmost) {
        const parentContainer = activeTraps[activeTraps.length - 1]?.containerRef.current;
        const previousFocus = previousFocusRef.current;
        if (parentContainer && previousFocus && parentContainer.contains(previousFocus)) {
          previousFocus.focus();
        } else if (parentContainer) {
          focusFirst(parentContainer);
        } else {
          (returnFocusRef?.current ?? previousFocus)?.focus();
        }
      }
    };
  // onCloseRef is stable (created by useRef) — no need to include it.
   
  }, [isOpen, returnFocusRef]);

  return containerRef;
}
