import { describe, expect, it } from 'vitest';
import {
  citiesOf,
  dayLabel,
  eventFacts,
  eventJsonLd,
  eventSummary,
  isDonation,
  isFree,
  listJsonLd,
  longWhen,
  monthLabel,
  postIdOfSlug,
  shortWhen,
} from '../afisha';
import { WALK } from './afisha-fixtures';

describe('slugs and dates', () => {
  it('reads the post number at the end of an announcement slug, none from a city slug', () => {
    expect(postIdOfSlug(WALK.slug)).toBe(1110);
    expect(postIdOfSlug('1087')).toBe(1087);
    expect(postIdOfSlug('novi-sad')).toBeNull();
  });

  it('writes local dates in Russian without any time zone shift', () => {
    expect(shortWhen(WALK)).toBe('Вс, 11 октября · 12:45');
    expect(longWhen(WALK)).toBe('Воскресенье, 11 октября 2026, 12:45');
    expect(dayLabel('2026-03-01')).toBe('1 марта 2026');
    expect(monthLabel('2026-09-05')).toBe('Сентябрь 2026');
  });
});

describe('lists', () => {
  it('ranks cities busiest first, then by name', () => {
    const at = (city: string, slug: string, post_id: number) => ({ ...WALK, city, city_slug: slug, post_id });
    const cities = citiesOf([
      at('Белград', 'belgrad', 1),
      at('Нови Сад', 'novi-sad', 2),
      at('Нови Сад', 'novi-sad', 3),
      at('Авала', 'avala', 4),
    ]);
    expect(cities.map((c) => [c.name, c.count])).toEqual([
      ['Нови Сад', 2],
      ['Авала', 1],
      ['Белград', 1],
    ]);
  });

  it('lists only the facts the post has, in the post order', () => {
    expect(eventFacts(WALK).map((f) => f.label)).toEqual([
      'Место встречи',
      'Протяжённость',
      'Длительность',
      'Сложность',
      'Ведущий',
      'Стоимость',
    ]);
  });

  it('knows a donation or a free event when the price line says so', () => {
    expect(isFree('донат по желанию')).toBe(true);
    expect(isFree('Бесплатно')).toBe(true);
    expect(isFree('1500 динаров')).toBe(false);
    expect(isFree(null)).toBe(false);
  });

  it('tells a donation from a set price', () => {
    expect(isDonation('донат по желанию')).toBe(true);
    expect(isDonation('Донат')).toBe(true);
    expect(isDonation('Бесплатно')).toBe(false);
    expect(isDonation('1500 динаров')).toBe(false);
    expect(isDonation(null)).toBe(false);
  });
});

describe('structured data', () => {
  it('describes an upcoming walk as a schema.org Event with a free offer', () => {
    const ld = eventJsonLd(WALK);
    expect(ld['@type']).toBe('Event');
    expect(ld.startDate).toBe('2026-10-11T12:45:00+02:00');
    expect(ld.endDate).toBe('2026-10-11T17:45:00+02:00');
    expect(ld.eventAttendanceMode).toBe('https://schema.org/OfflineEventAttendanceMode');
    expect(ld.location).toMatchObject({
      name: 'Лиманский парк, на площади с флагами',
      address: { addressLocality: 'Нови Сад', addressCountry: 'RS' },
    });
    expect(ld.performer).toEqual({ '@type': 'Person', name: 'Марьяна Постриган' });
    expect(ld.offers).toMatchObject({ url: WALK.register_url, price: 0, priceCurrency: 'RSD' });
    expect(ld.isAccessibleForFree).toBe(true);
    expect(String(ld.url)).toMatch(/\/afisha\/2026-10-11-.*-1110$/);
  });

  it('offers nothing to register for once the event is over', () => {
    expect(eventJsonLd({ ...WALK, past: true }).offers).toBeUndefined();
    expect(eventJsonLd({ ...WALK, city: 'Стамбул' }).location).toMatchObject({ address: { addressCountry: 'TR' } });
  });

  it('summarizes from the description, or says what and where without one', () => {
    expect(eventSummary(WALK)).toBe('Маршрут начинается у смотровой площадки Zmajevac. Обратно — на автобусе №86.');
    expect(eventSummary({ ...WALK, description: null })).toBe(
      'Прогулка с организатором: Воскресенье, 11 октября 2026, 12:45. Место встречи: Нови Сад, Лиманский парк, на площади с флагами.',
    );
    expect(eventSummary({ ...WALK, description: 'а'.repeat(300) })).toHaveLength(198);
  });

  it('lists announcement pages in order', () => {
    const ld = listJsonLd('Ближайшие', [WALK]);
    expect(ld.itemListElement).toEqual([
      expect.objectContaining({ position: 1, name: WALK.title, url: expect.stringContaining(WALK.slug) }),
    ]);
  });
});
