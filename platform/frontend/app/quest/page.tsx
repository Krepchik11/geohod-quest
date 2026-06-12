import Link from 'next/link';
import { GOLDENS, getSnapshot } from '../../lib/goldens';
import BundleGate from './BundleGate';

// RSC shell per design/react: static load (hoisted), searchParams for ?golden=, pass snapshot + id to client tree only.
// No 'use client', no logic here. BundleGate (client) swaps in a downloaded bundle snapshot when one exists.
export default async function QuestPage({
  searchParams,
}: {
  searchParams: Promise<{ golden?: string }>;
}) {
  const params = await searchParams;
  const goldenId = params.golden || 'ironia'; // default to full designed “Ирония судьбы” 7-tpl paper demo from design/player/quest-data.js
  // Golden fallback snapshot (display-demo ids like 'ironia' have no golden — the
  // client renders their designed steps by id; the mystery snapshot backs the data model).
  const snapshot = GOLDENS.snapshots[goldenId] ?? getSnapshot('mystery-fortress-v1');

  return (
    <div style={{ background: 'var(--p-bg, #FBF1E5)', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {/* Pure designed player experience (paper frame, no site chrome, matching design/player/ exactly) */}
      <div style={{ maxWidth: 380 }}>
        <div className="mb-2 text-center text-xs opacity-60">
          Designed player (paper) • default ironia demo (full 7 templates from design) • real sync needs NEXT_PUBLIC_API_URL=http://localhost:8087 (your backend port)
        </div>
        <BundleGate questId={goldenId} fallback={snapshot} />
        <div className="mt-3 text-center">
          <Link href="/constructor" className="text-xs underline">← Конструктор (live previews)</Link>
          {' '}|{' '}
          <Link href="/quest-detail" className="text-xs underline">Квест в магазине</Link>
          {' '}|{' '}
          <a href="/quest?golden=ironia" className="text-xs underline">Полный дизайн-демо (Ирония судьбы)</a>
        </div>
      </div>
    </div>
  );
}
