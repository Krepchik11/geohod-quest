import { ImageResponse } from 'next/og';
import { API_BASE, type ProductPageWire } from '../../../../lib/api';
import { coverSrc } from '../../../../lib/cover';

/**
 * §share — the 1200×630 card a messenger shows for a shared quest link.
 *
 * The author's cover is an arbitrary photo, so it is never handed to the
 * crawler raw: it fills this fixed frame behind a darkening scrim, with the
 * quest's name over it. The backdrop is the brand navy the PWA icons use
 * (`backend/src/icons.rs`), so a quest with no cover still looks deliberate.
 */
export const alt = 'Городской квест в GEOHOD QUEST';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** Brand navy — the same value `icons.rs` composites its PWA icons on. */
const NAVY = '#122947';

/** A cover fetch must never hang the crawler: no image beats a timed-out card. */
const COVER_TIMEOUT_MS = 3000;

/** The cover URL, but only when it is one this renderer can actually fetch. */
async function coverUrl(primaryComic: string | null): Promise<string | null> {
  const src = coverSrc(primaryComic);
  if (!src || !src.startsWith('http')) return null;
  try {
    const res = await fetch(src, { signal: AbortSignal.timeout(COVER_TIMEOUT_MS) });
    return res.ok ? src : null;
  } catch {
    return null;
  }
}

export default async function Image({ params }: { params: Promise<{ questId: string }> }) {
  const { questId } = await params;
  const res = await fetch(`${API_BASE}/api/quests/${encodeURIComponent(questId)}`, {
    next: { revalidate: 300 },
  }).catch(() => null);
  const p = res?.ok ? ((await res.json()) as ProductPageWire) : null;

  const name = p?.name ?? 'GEOHOD QUEST';
  const meta = [p?.city, p?.duration].filter(Boolean).join(' · ');
  const cover = p ? await coverUrl(p.primary_comic) : null;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          background: NAVY,
          position: 'relative',
        }}
      >
        {cover && (
          <img
            src={cover}
            alt=""
            width={size.width}
            height={size.height}
            // Explicit edges, not the `inset` shorthand: Satori (what renders
            // this) does not expand every CSS shorthand, and a box that silently
            // collapses here is a card with no picture.
            style={{ position: 'absolute', top: 0, left: 0, width: size.width, height: size.height, objectFit: 'cover' }}
          />
        )}
        {/* Scrim over the WHOLE frame: the author's photo can be bright
            anywhere, so contrast has to be built, not hoped for. */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: size.width,
            height: size.height,
            background: 'linear-gradient(to bottom, rgba(18,41,71,0.20) 0%, rgba(18,41,71,0.55) 45%, rgba(18,41,71,0.95) 100%)',
          }}
        />
        {/* A second, SOLID plate behind the text. The gradient above carries the
            look; this carries the guarantee — if a gradient ever fails to render,
            white-on-photo is unreadable, and an OG card gets exactly one chance. */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: size.height - 300,
            width: size.width,
            height: 300,
            background: 'rgba(18,41,71,0.62)',
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', padding: '0 64px 56px', position: 'relative' }}>
          <div style={{ display: 'flex', fontSize: 26, letterSpacing: 4, color: '#C9D8FB' }}>
            GEOHOD QUEST
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 16,
              fontSize: 64,
              fontWeight: 700,
              lineHeight: 1.12,
              color: '#FFFFFF',
              // Three lines is the frame's budget; anything longer is clipped
              // rather than pushed off the card.
              maxHeight: 240,
              overflow: 'hidden',
            }}
          >
            {name}
          </div>
          {meta && (
            <div style={{ display: 'flex', marginTop: 20, fontSize: 30, color: '#D6DEEC' }}>{meta}</div>
          )}
        </div>
      </div>
    ),
    {
      ...size,
      headers: {
        // The card is addressed with `?v={snapshot_version}` (see the page's
        // generateMetadata), so a given URL's pixels never change — publishing
        // a new version mints a new URL. Without this every crawler hit paid
        // for a fresh ~4s render (`X-Vercel-Cache: MISS` on back-to-back
        // requests), which is how an OG fetch times out and a link goes bare.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    },
  );
}
