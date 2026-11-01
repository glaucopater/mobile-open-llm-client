/**
 * Scrolls a focused `TextInput` above the keyboard inside a `ScrollView`.
 *
 * Android resizes the window (`windowSoftInputMode="adjustResize"`), but React
 * Native never scrolls to the focused field, so fields near the bottom of a
 * long form end up hidden behind the keyboard. Measuring in window
 * coordinates avoids tracking layout offsets through nested containers: the
 * field and the scroll viewport are compared where they are actually drawn.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { ScrollViewInstance } from 'react-native';

/** Anything React Native can measure on screen: `View` and `TextInput` both do. */
type Measurable = {
  measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void;
};

/** Scroll events differ between renderers, so only the offset is read. */
type ScrollOffsetEvent = {
  nativeEvent?: { contentOffset?: { y: number } };
  contentOffset?: { y: number };
};

/** Room left between the field and the keyboard, and above a scrolled-to field. */
const REVEAL_MARGIN = 24;

/** The keyboard animation plus the window resize need to settle before measuring. */
const REVEAL_DELAY_MS = 220;

export function useKeyboardAwareScroll() {
  const scrollRef = useRef<ScrollViewInstance | null>(null);
  const scrollOffset = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const pending = timers.current;

    return () => {
      pending.forEach(clearTimeout);
    };
  }, []);

  const onScroll = useCallback((event: ScrollOffsetEvent) => {
    scrollOffset.current = event.nativeEvent?.contentOffset?.y ?? event.contentOffset?.y ?? 0;
  }, []);

  /** Scrolls just enough to put `target` fully inside the visible viewport. */
  const reveal = useCallback((target: Measurable | null) => {
    if (target === null) {
      return;
    }

    timers.current.push(
      setTimeout(() => {
        target.measureInWindow((_x, fieldTop, _width, fieldHeight) => {
          scrollRef.current?.measureInWindow((_x2, viewTop, _width2, viewHeight) => {
            if (viewHeight === 0) {
              return;
            }

            const viewBottom = viewTop + viewHeight;
            const fieldBottom = fieldTop + fieldHeight;

            if (fieldBottom > viewBottom) {
              scrollRef.current?.scrollTo({
                y: scrollOffset.current + (fieldBottom - viewBottom + REVEAL_MARGIN),
                animated: true,
              });
            } else if (fieldTop < viewTop) {
              scrollRef.current?.scrollTo({
                y: Math.max(0, scrollOffset.current - (viewTop - fieldTop) + REVEAL_MARGIN),
                animated: true,
              });
            }
          });
        });
      }, REVEAL_DELAY_MS),
    );
  }, []);

  return { scrollRef, onScroll, reveal };
}
