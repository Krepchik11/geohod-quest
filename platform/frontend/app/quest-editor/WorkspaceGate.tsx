'use client';

import dynamic from 'next/dynamic';

/**
 * Client-only gate: the workspace state lives in localStorage, so it renders
 * exclusively on the client (no SSR markup to mismatch against).
 */
const Workspace = dynamic(() => import('./Workspace'), {
  ssr: false,
  loading: () => <div className="admin wsp" style={{ minHeight: '100vh' }} />,
});

export default function WorkspaceGate() {
  return <Workspace />;
}
