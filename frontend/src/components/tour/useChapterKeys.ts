'use client';

/**
 * Arrow-key navigation for the chapter column.
 *
 * The column behaves like a vertical tab list: one chapter is open, and the
 * arrows move between chapters rather than between focusable controls. Moving
 * also opens, so a keyboard walk down the column tells the same story a click
 * walk does -- the camera flies, the ring moves, the copy changes.
 *
 *   ArrowUp / ArrowDown   previous / next chapter, focused and opened
 *   Home / End            first / last chapter, focused and opened
 *   Escape                close, which also clears the scene selection
 *
 * Enter and Space are deliberately absent: the chapter headers are real
 * `<button>`s, so the browser already turns both into a click, and handling
 * them here would fire the toggle twice.
 *
 * Focus is roving by DOM rather than by state: the handler asks which of the
 * registered headers owns `document.activeElement`, so a click and a keypress
 * cannot disagree about where the caret is.
 */

import { useCallback, useRef } from 'react';
import type { KeyboardEvent } from 'react';

export interface ChapterKeys {
  /** Ref callback for chapter `index`'s header button. */
  register: (index: number) => (el: HTMLButtonElement | null) => void;
  /** Attach to the column, not to each pill: the keys bubble up from the headers. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** Focus one chapter's header without opening it (used after a scene pick). */
  focus: (index: number) => void;
}

export interface UseChapterKeysOptions {
  count: number;
  /** Move to, and open, the chapter at `index`. */
  onOpen: (index: number) => void;
  /** Escape: close whatever is open. */
  onClose: () => void;
}

export function useChapterKeys({ count, onOpen, onClose }: UseChapterKeysOptions): ChapterKeys {
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  const register = useCallback(
    (index: number) => (el: HTMLButtonElement | null) => {
      items.current[index] = el;
    },
    [],
  );

  const focus = useCallback((index: number) => {
    items.current[index]?.focus();
  }, []);

  /** Where the caret is now. -1 when focus is inside an open panel instead. */
  const currentIndex = useCallback(() => {
    const active = document.activeElement;
    return items.current.findIndex((el) => el !== null && el === active);
  }, []);

  const go = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(count - 1, index));
      focus(clamped);
      onOpen(clamped);
    },
    [count, focus, onOpen],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') {
        /* Escape works from anywhere in the column, including from inside an
           open panel -- it is the way out of a chapter you arrowed into. */
        event.stopPropagation();
        onClose();
        const index = currentIndex();
        if (index >= 0) focus(index);
        return;
      }

      /* Everything else only means something on a chapter header; inside the
         panel the arrows belong to the mini chart and the buttons. */
      const index = currentIndex();
      if (index < 0) return;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          go(index + 1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          go(index - 1);
          break;
        case 'Home':
          event.preventDefault();
          go(0);
          break;
        case 'End':
          event.preventDefault();
          go(count - 1);
          break;
        default:
          break;
      }
    },
    [count, currentIndex, focus, go, onClose],
  );

  return { register, onKeyDown, focus };
}

export default useChapterKeys;
