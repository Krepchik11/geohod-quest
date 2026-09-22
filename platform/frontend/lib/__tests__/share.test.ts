/**
 * «Поделиться квестом»: the link, the message, and the share/clipboard
 * branching. Everything here is pure or injectable, so the platform decisions
 * are asserted without a browser (the install.ts pattern).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { questShareUrl, shareQuest, shareText, siteUrl } from '../share';

const SITE = 'https://quest.geohod.ru';

/** Install a fake `navigator` for the duration of one test. */
function stubNavigator(nav: unknown): void {
  vi.stubGlobal('navigator', nav);
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', SITE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('siteUrl', () => {
  it('uses NEXT_PUBLIC_SITE_URL when set', () => {
    expect(siteUrl()).toBe(SITE);
  });

  it('strips a trailing slash so paths never double up', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://quest.geohod.ru/');
    expect(siteUrl()).toBe(SITE);
  });

  it('falls back to the dev origin when unset and there is no window', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(siteUrl()).toBe('http://localhost:3000');
  });
});

describe('questShareUrl', () => {
  it('points at the product page, with no tracking parameters', () => {
    expect(questShareUrl('mystery-fortress-v1')).toBe(
      `${SITE}/quest/mystery-fortress-v1/about`,
    );
  });

  it('escapes a quest id that carries URL-significant characters', () => {
    expect(questShareUrl('a/b?c=1')).toBe(`${SITE}/quest/a%2Fb%3Fc%3D1/about`);
  });
});

describe('shareText', () => {
  it('names the city when the quest has one', () => {
    expect(shareText('Месть Великого Магистра. Часть 1', 'Нови Сад')).toBe(
      'Городской квест «Месть Великого Магистра. Часть 1» в городе Нови Сад',
    );
  });

  it('omits the city clause when it is missing or blank', () => {
    expect(shareText('Ирония судьбы')).toBe('Городской квест «Ирония судьбы»');
    expect(shareText('Ирония судьбы', null)).toBe('Городской квест «Ирония судьбы»');
    expect(shareText('Ирония судьбы', '   ')).toBe('Городской квест «Ирония судьбы»');
  });
});

describe('shareQuest', () => {
  const quest = { questId: 'mystery-fortress-v1', name: 'Загадка крепости', city: 'Нови Сад' };
  const url = `${SITE}/quest/mystery-fortress-v1/about`;

  it('hands title, text and url to the OS sheet and leaves the clipboard alone', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ share, clipboard: { writeText } });

    await expect(shareQuest(quest)).resolves.toBe('shared');
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({
      title: 'Загадка крепости',
      text: 'Городской квест «Загадка крепости» в городе Нови Сад',
      url,
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('copies ONLY the url when there is no share sheet', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ clipboard: { writeText } });

    await expect(shareQuest(quest)).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith(url);
  });

  it('treats a dismissed sheet as a decision: no copy, no error', async () => {
    const abort = new Error('user aborted');
    abort.name = 'AbortError';
    const share = vi.fn().mockRejectedValue(abort);
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ share, clipboard: { writeText } });

    await expect(shareQuest(quest)).resolves.toBe('dismissed');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to the clipboard when the sheet fails for any other reason', async () => {
    const share = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ share, clipboard: { writeText } });

    await expect(shareQuest(quest)).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith(url);
  });

  it('reports failure when neither path is available', async () => {
    stubNavigator({});
    await expect(shareQuest(quest)).resolves.toBe('failed');
  });

  it('reports failure when the clipboard is denied', async () => {
    stubNavigator({ clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    await expect(shareQuest(quest)).resolves.toBe('failed');
  });
});
