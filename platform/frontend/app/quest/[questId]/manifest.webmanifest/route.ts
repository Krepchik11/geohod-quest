import { NextResponse } from 'next/server';
import { API_BASE, type ProductPageWire } from '../../../../lib/api';
import { questManifest } from '../../../../lib/pwa';

/**
 * §5 — per-quest web app manifest: GET /quest/[id]/manifest.webmanifest.
 * Served for published quests; the product page and the player link it via
 * <link rel="manifest">, making each owned quest installable as its own app.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ questId: string }> },
) {
  const { questId } = await params;
  const res = await fetch(`${API_BASE}/api/quests/${encodeURIComponent(questId)}`, {
    // The card changes only on publish; a short TTL keeps the manifest fresh
    // without hammering the backend on every install check.
    next: { revalidate: 300 },
  }).catch(() => null);
  if (!res || !res.ok) {
    return NextResponse.json({ error: 'quest not found' }, { status: 404 });
  }
  const product = (await res.json()) as ProductPageWire;
  return NextResponse.json(questManifest(product, API_BASE), {
    headers: { 'Content-Type': 'application/manifest+json' },
  });
}
