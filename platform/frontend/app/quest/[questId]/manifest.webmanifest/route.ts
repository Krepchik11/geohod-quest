import { NextResponse } from 'next/server';
import { API_BASE } from '../../../../lib/api';
import { questManifest } from '../../../../lib/pwa';
import { fetchQuest } from '../../share-metadata';

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
  const product = await fetchQuest(questId);
  if (!product) {
    return NextResponse.json({ error: 'quest not found' }, { status: 404 });
  }
  return NextResponse.json(questManifest(product, API_BASE), {
    headers: { 'Content-Type': 'application/manifest+json' },
  });
}
