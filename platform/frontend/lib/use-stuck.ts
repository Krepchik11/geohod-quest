'use client';

import { useEffect, useState, type RefObject } from 'react';

/** Far past the end of any page: the observed band runs down to here. */
const FAR_BELOW_PX = 1_000_000;

/**
 * Whether a sticky element is pinned, told by a zero-height sentinel placed right
 * before it: once the sentinel has scrolled above the line the element sticks at
 * (`topPx` from the top of the viewport), the element is pinned. One
 * IntersectionObserver, no scroll handlers — the browser reports the crossing.
 *
 * `false` on the server, without IntersectionObserver (tests) and until the
 * first report, so nothing pins its shadow by mistake.
 */
export function useStuck(sentinel: RefObject<Element | null>, topPx: number): boolean {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => setStuck(!entry.isIntersecting && entry.boundingClientRect.top < topPx),
      // Everything below the pin line, however far down: leaving it upwards =
      // pinned. Not just the viewport — a jump (an anchor, a restored scroll)
      // from below the screen to above the line would cross no edge of it and
      // never be reported.
      { rootMargin: `-${topPx}px 0px ${FAR_BELOW_PX}px 0px`, threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [sentinel, topPx]);

  return stuck;
}
