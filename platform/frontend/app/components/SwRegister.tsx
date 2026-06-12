'use client';

import { useEffect } from 'react';

/**
 * Registers the app-shell service worker — production builds only
 * (next dev + SW caching is a development hazard, per the P4 design).
 */
export default function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('service worker registration failed', err);
    });
  }, []);
  return null;
}
