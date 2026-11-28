'use client';

import { useEffect } from 'react';

/**
 * Öppnar en flik som pekas ut i adressen, till exempel /fakturor?tab=overdue.
 * Används av länkarna på startsidan.
 */
export function useUrlTab<T extends string>(setTab: (t: T) => void, allowed: readonly T[]) {
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && (allowed as readonly string[]).includes(t)) setTab(t as T);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
