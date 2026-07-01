/**
 * Cover resolution — single source of truth for a quest's `primary_comic` field.
 * Post-R2 the value is a fully-qualified `https://…/api/media/{hash}` URL; legacy
 * data may be a `/`-rooted path, a `data:` URI, or a non-URL token. The old
 * my-quests gate (`startsWith('/')`) dropped the production https URL → blank cover.
 */
import { describe, expect, it } from 'vitest';
import { coverSrc, coverCss, CARD_PLACEHOLDER } from '../cover';

describe('coverSrc', () => {
  it('keeps a fully-qualified https media URL (the post-R2 production shape)', () => {
    const url = 'https://api.quest.geohod.ru/api/media/abc123';
    expect(coverSrc(url)).toBe(url);
  });

  it('keeps a root-relative path and a data: URI', () => {
    expect(coverSrc('/assets/img/x.png')).toBe('/assets/img/x.png');
    expect(coverSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('rejects a non-URL token (legacy id-style value) and blanks', () => {
    expect(coverSrc('comic-fortress')).toBeNull();
  });

  it('treats empty / whitespace / nullish as no cover', () => {
    expect(coverSrc(null)).toBeNull();
    expect(coverSrc(undefined)).toBeNull();
    expect(coverSrc('')).toBeNull();
    expect(coverSrc('   ')).toBeNull();
  });

  it('trims surrounding whitespace before testing', () => {
    expect(coverSrc('  https://x/y  ')).toBe('https://x/y');
  });
});

describe('coverCss', () => {
  it('wraps a real ref in url() ', () => {
    expect(coverCss('https://x/y')).toBe("url('https://x/y')");
  });

  it('falls back to the card placeholder for a non-image token or null', () => {
    expect(coverCss('comic-fortress')).toBe(`url('${CARD_PLACEHOLDER}')`);
    expect(coverCss(null)).toBe(`url('${CARD_PLACEHOLDER}')`);
  });
});
