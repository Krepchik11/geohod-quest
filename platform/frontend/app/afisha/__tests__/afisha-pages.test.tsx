// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { WALK } from '../../../lib/__tests__/afisha-fixtures';

/**
 * The «Афиша» pages render on the server from the API. Pinned: an
 * announcement shows its facts, the counted «Записаться» link and its
 * schema.org Event; a past one offers no registration; an outdated slug
 * redirects to the current one; a city page gathers the city's announcements;
 * an unknown city or a switched-off «Афиша» is a 404.
 */
const { eventMock, listMock } = vi.hoisted(() => ({ eventMock: vi.fn(), listMock: vi.fn() }));
vi.mock('../../../lib/afisha', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchAfishaEvent: eventMock,
  fetchAfisha: listMock,
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  permanentRedirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock('../../components/SiteShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import AfishaSlugPage, { generateMetadata } from '../[slug]/page';
import AfishaPage from '../page';

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

/** The JSON-LD the page carries for crawlers. */
const jsonLd = (container: HTMLElement) =>
  [...container.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent ?? ''));

beforeEach(() => {
  eventMock.mockReset();
  listMock.mockReset();
  listMock.mockImplementation(async (when: string) => (when === 'upcoming' ? [WALK] : []));
});

describe('announcement page', () => {
  it('shows the facts, the counted register link and the Event data', async () => {
    eventMock.mockResolvedValue(WALK);
    const { container } = render(await AfishaSlugPage(params(WALK.slug)));
    expect(screen.getByRole('heading', { level: 1, name: WALK.title })).toBeTruthy();
    expect(screen.getByText('Марьяна Постриган')).toBeTruthy();
    expect(screen.getByText('Лиманский парк, на площади с флагами')).toBeTruthy();
    const register = screen.getByRole('link', { name: 'Записаться' });
    expect(register.getAttribute('href')).toMatch(/\/api\/afisha\/1110\/go$/);
    expect(screen.getByRole('link', { name: 'Анонс в Telegram-канале' }).getAttribute('href')).toBe(WALK.post_url);
    const [event] = jsonLd(container);
    expect(event).toMatchObject({ '@type': 'Event', name: WALK.title, startDate: WALK.starts_at });
    expect(eventMock).toHaveBeenCalledWith(1110);
  });

  it('says a past walk is over and offers no registration', async () => {
    eventMock.mockResolvedValue({ ...WALK, past: true });
    render(await AfishaSlugPage(params(WALK.slug)));
    expect(screen.getByText(/Прогулка уже прошла/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Записаться' })).toBeNull();
  });

  it('redirects an outdated slug to the current one and 404s a missing post', async () => {
    eventMock.mockResolvedValue(WALK);
    await expect(AfishaSlugPage(params('2026-10-11-old-title-1110'))).rejects.toThrow(`REDIRECT /afisha/${WALK.slug}`);
    eventMock.mockResolvedValue(null);
    await expect(AfishaSlugPage(params('2026-10-11-old-title-1110'))).rejects.toThrow('NOT_FOUND');
  });

  it('titles the page with the date and the city', async () => {
    eventMock.mockResolvedValue(WALK);
    const meta = await generateMetadata(params(WALK.slug));
    expect(meta.title).toBe('Прогуляемся к римской башне Врдничка кула — 11 октября 2026, Нови Сад | Афиша GEOHOD');
    expect(meta.alternates?.canonical).toBe(`/afisha/${WALK.slug}`);
  });
});

describe('city page', () => {
  it('gathers the city announcements', async () => {
    render(await AfishaSlugPage(params('novi-sad')));
    expect(screen.getByRole('heading', { level: 1, name: 'Нови Сад: групповые прогулки и квесты' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: WALK.title })).toBeTruthy();
    expect(eventMock).not.toHaveBeenCalled();
  });

  it('is a 404 for a city the «Афиша» never had', async () => {
    await expect(AfishaSlugPage(params('moskva'))).rejects.toThrow('NOT_FOUND');
  });
});

describe('hub', () => {
  it('lists upcoming announcements and links their cities', async () => {
    render(await AfishaPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Афиша' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Нови Сад' }).getAttribute('href')).toBe('/afisha/novi-sad');
    expect(screen.getByRole('heading', { level: 3, name: WALK.title })).toBeTruthy();
  });

  it('is a 404 while the «Афиша» is off', async () => {
    listMock.mockResolvedValue(null);
    await expect(AfishaPage()).rejects.toThrow('NOT_FOUND');
  });
});
