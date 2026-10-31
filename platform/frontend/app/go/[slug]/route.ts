import { API_BASE, type PromoLinkWire } from '../../../lib/api';
import { PROMO_PARAM } from '../../../lib/promo';

/**
 * /go/<slug> — the address a printed QR invitation holds (flag `promo_qr`).
 * The API resolves the slug to the coupon's one quest and its current code
 * and counts the scan — the visitor's User-Agent goes along, so link previews
 * and crawlers are not counted. The guest lands on the quest page with the
 * code applied. Anything else — the flag off, an unknown or retired address,
 * the API unreachable — opens the shop instead of an error page.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const link = await resolveLink(slug, request.headers.get('user-agent'));
  const target = link
    ? `/quest/${encodeURIComponent(link.quest_id)}/about?${PROMO_PARAM}=${encodeURIComponent(link.code)}`
    : '/';
  return new Response(null, {
    status: 302,
    // Every scan must reach this handler to be counted — never a cached hop.
    headers: { Location: new URL(target, request.url).toString(), 'Cache-Control': 'no-store' },
  });
}

/** Where the slug leads, or null when it leads nowhere (or the API is away). */
async function resolveLink(slug: string, userAgent: string | null): Promise<PromoLinkWire | null> {
  const res = await fetch(`${API_BASE}/api/go/${encodeURIComponent(slug)}`, {
    method: 'POST',
    headers: userAgent ? { 'User-Agent': userAgent } : {},
    cache: 'no-store',
  }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as PromoLinkWire | null;
}
