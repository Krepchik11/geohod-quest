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
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cover}
            alt=""
            width={size.width}
            height={size.height}
            style={{ position: 'absolute', inset: 0, objectFit: 'cover' }}
          />
        )}
        {/* Scrim: the author's photo may be bright anywhere, so the text needs
            its own guaranteed contrast rather than luck. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(to bottom, rgba(18,41,71,0.15), rgba(18,41,71,0.92))',
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', padding: '0 64px 56px', position: 'relative' }}>
          <div style={{ display: 'flex', fontSize: 26, letterSpacing: 4, color: '#9DB6F8' }}>
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
    size,
  );
}
