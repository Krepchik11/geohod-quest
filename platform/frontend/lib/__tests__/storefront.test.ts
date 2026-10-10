import { describe, it, expect } from 'vitest';
import {
  attrsLine,
  busiestCity,
  citiesByCount,
  catalogFacts,
  cityPlural,
  distanceLabel,
  factsLine,
  fmtRating,
  heroSlogan,
  heroStats,
  heroTitle,
  inviteText,
  pickNextQuest,
  priceLabel,
  questFacts,
  questPlural,
  questsInCity,
  questsInCityParts,
  ratingPlural,
  showPlayers,
} from '../storefront';
import type { PublishedQuestWire } from '../api';

/** §2.3 hero facts — computed from the LIVE catalog response, never fabricated. */
function q(over: Partial<PublishedQuestWire>): PublishedQuestWire {
  return {
    quest_id: 'q', name: 'n', primary_comic: null, template_summary: '', description: null, pages: null, tasks: null, paid_hints: null,
    snapshot_version: 1, snapshot_id: 's', city: null, duration: null, duration_min: 60, distance_km: 5,
    price: null, rating_avg: 0, rating_count: 0, players: 0,
    complexity: null, age_target: null, tags: [], ...over,
  };
}

describe('catalogFacts', () => {
  it('counts quests, distinct non-null cities and the weighted mean rating', () => {
    const facts = catalogFacts([
      q({ city: 'Белград', rating_avg: 5, rating_count: 1 }),
      q({ city: 'Белград, Дорчол' }),
      q({ city: 'Земун', rating_avg: 4, rating_count: 3 }),
      q({ city: null }),
    ]);
    expect(facts.quests).toBe(4);
    expect(facts.cities).toBe(3);
    // (5·1 + 4·3) / 4 = 4.25
    expect(facts.avg).toBeCloseTo(4.25);
    expect(facts.ratings).toBe(4);
  });

  it('hides the star segment while nothing is rated (avg null)', () => {
    const facts = catalogFacts([q({}), q({ city: 'Земун' })]);
    expect(facts.avg).toBeNull();
    expect(facts.ratings).toBe(0);
  });

  it('treats city labels as distinct case-insensitively and trimmed', () => {
    const facts = catalogFacts([q({ city: ' Земун ' }), q({ city: 'земун' })]);
    expect(facts.cities).toBe(1);
  });
});

describe('factsLine', () => {
  it('renders «N квестов · M городов · ★ avg»', () => {
    expect(factsLine({ quests: 12, cities: 4, avg: 4.75, ratings: 9 })).toEqual({
      quests: '12 квестов',
      cities: '4 города',
      rating: '4,75 — средняя оценка игроков',
    });
  });

  it('omits the rating segment with no ratings', () => {
    expect(factsLine({ quests: 1, cities: 1, avg: null, ratings: 0 }).rating).toBeNull();
  });
});

describe('plurals & labels', () => {
  it('quest plural', () => {
    expect(questPlural(1)).toBe('квест');
    expect(questPlural(2)).toBe('квеста');
    expect(questPlural(12)).toBe('квестов');
  });
  it('city plural', () => {
    expect(cityPlural(1)).toBe('город');
    expect(cityPlural(4)).toBe('города');
    expect(cityPlural(11)).toBe('городов');
  });
  it('rating plural', () => {
    expect(ratingPlural(1)).toBe('оценка');
    expect(ratingPlural(24)).toBe('оценки');
    expect(ratingPlural(5)).toBe('оценок');
  });
  it('price label', () => {
    expect(priceLabel(0)).toBe('Бесплатно');
    expect(priceLabel(890)).toBe('890 ₽');
    expect(priceLabel(null)).toBe('');
  });
  it('rating formatter drops the trailing .0', () => {
    // Hundredths and a decimal comma (ТЗ, задача 33): rounded to tenths every
    // quest read «5» and the store could not tell them apart.
    expect(fmtRating(5)).toBe('5,0');
    expect(fmtRating(4.75)).toBe('4,75');
    expect(fmtRating(4.966)).toBe('4,97');
    expect(fmtRating(4.9)).toBe('4,9');
  });
});

describe('ТЗ «Дизайн и юзабилити» helpers', () => {
  it('shows «сыграли» only when it cannot contradict the ratings (задача 3)', () => {
    expect(showPlayers(477, 59)).toBe(true);
    expect(showPlayers(1, 41)).toBe(false);
    expect(showPlayers(0, 0)).toBe(false);
  });

  it('labels time and distance from the numbers when quest_facts is on (задача 19)', () => {
    const row = { duration: '90 минут', duration_min: 60, distance_km: 3.5 };
    expect(questFacts(row, true)).toEqual({ time: '≈ 60 мин', distance: '3,5 км' });
    expect(questFacts(row, false)).toEqual({ time: '90 минут', distance: null });
    // A row cached offline before the numbers existed falls back to its label.
    expect(questFacts({ duration: '2 часа' }, true)).toEqual({ time: '2 часа', distance: null });
    expect(distanceLabel(5)).toBe('5 км');
  });

  it('declines only the cities it knows', () => {
    expect(heroTitle('Нови Сад')).toBe('Нови Сад, о котором не расскажет экскурсовод');
    expect(heroTitle('Москва')).toBe('Москва, о которой не расскажет экскурсовод');
    expect(questsInCity('Нови Сад')).toBe('Квесты в Нови Саде');
    expect(questsInCity('Ниш')).toBe('Квесты · Ниш');
    expect(questsInCity(null)).toBe('Квесты');
    // The title splits around the city so the city alone can be the switch.
    expect(questsInCityParts('Нови Сад')).toEqual({ lead: 'Квесты в ', place: 'Нови Саде' });
    expect(questsInCityParts('Ниш')).toEqual({ lead: 'Квесты · ', place: 'Ниш' });
    expect(questsInCityParts(null)).toEqual({ lead: 'Квесты', place: null });
  });

  it('lists the cities the busiest first, equal ones in ru order, cityless quests aside', () => {
    const qs = [
      { city: 'Стамбул' },
      { city: 'Нови Сад' },
      { city: 'Белград' },
      { city: 'Нови Сад' },
      { city: null },
      { city: 'Нови Сад' },
    ];
    expect(citiesByCount(qs)).toEqual([
      { city: 'Нови Сад', count: 3 },
      { city: 'Белград', count: 1 },
      { city: 'Стамбул', count: 1 },
    ]);
    expect(citiesByCount([])).toEqual([]);
  });

  it('writes the invitation a player sends friends (задача 28)', () => {
    expect(inviteText('Тайна крепости', 'Нови Сад', '≈ 60 мин', true)).toBe(
      'Пойдём в квест «Тайна крепости» в Нови Саде? ≈ 60 минут, бесплатно',
    );
    expect(inviteText('Шифры', 'Ниш', null, false)).toBe('Пойдём в квест «Шифры»?');
  });

  it('builds the card facts line from the attributes the catalog serves', () => {
    expect(attrsLine({ complexity: 'medium', age_target: 'everyone', tasks: 11 })).toBe(
      'Средняя сложность · 11 заданий · можно с детьми',
    );
    expect(attrsLine({ complexity: null, age_target: null, tasks: null })).toBe('');
  });

  it('opens on the city with the most quests and offers the next quest of the same city', () => {
    const qs = [
      { quest_id: 'a', city: 'Белград', rating_avg: 5, rating_count: 3 },
      { quest_id: 'b', city: 'Нови Сад', rating_avg: 4.9, rating_count: 9 },
      { quest_id: 'c', city: 'Нови Сад', rating_avg: 5, rating_count: 1 },
      { quest_id: 'd', city: 'Нови Сад', rating_avg: 4, rating_count: 2 },
    ];
    expect(busiestCity(qs)).toBe('Нови Сад');
    // Not the current one, not another city; untaken first, then by rating.
    expect(pickNextQuest(qs, 'b', 'Нови Сад', new Set())?.quest_id).toBe('c');
    expect(pickNextQuest(qs, 'b', 'Нови Сад', new Set(['c']))?.quest_id).toBe('d');
    expect(pickNextQuest(qs, 'a', 'Белград', new Set())).toBeNull();
  });
});

describe('main banner by city', () => {
  it('counts quests, completions, the average time and length', () => {
    const qs = [q({ players: 477 }), q({ players: 1 }), q({ players: 0, duration_min: 90, distance_km: 3 })];
    expect(heroStats(qs, true)).toEqual([
      { value: '3', label: 'квеста' },
      { value: '478', label: 'прохождений' },
      { value: '70 мин', label: 'в среднем' },
      { value: '4,5 км', label: 'пешком' },
    ]);
  });

  it('shows completions always, even none; time and length only with quest_facts', () => {
    expect(heroStats([q({ players: 0 })], true)).toEqual([
      { value: '1', label: 'квест' },
      { value: '0', label: 'прохождений' },
      { value: '60 мин', label: 'в среднем' },
      { value: '5 км', label: 'пешком' },
    ]);
    expect(heroStats([q({ players: 1201 })], false)).toEqual([
      { value: '1', label: 'квест' },
      { value: '1\u00a0201', label: 'прохождение' },
    ]);
    expect(heroStats([], true)).toEqual([]);
  });

  it('a slogan that continues the city follows its name; none falls back to the old title', () => {
    expect(heroSlogan('Стамбул', ', путешествие в прошлое')).toBe('Стамбул, путешествие в прошлое');
    expect(heroSlogan('Нови Сад', ' , город с которого всё началось! ')).toBe('Нови Сад, город с которого всё началось!');
    expect(heroSlogan('Кралево', '— город роз')).toBe('Кралево — город роз');
    expect(heroSlogan('Белград', 'Город на двух реках')).toBe('Город на двух реках');
    expect(heroSlogan('Белград', '  ')).toBe(heroTitle('Белград'));
    expect(heroSlogan(null, ', что-то')).toBe(heroTitle(null));
  });
});
