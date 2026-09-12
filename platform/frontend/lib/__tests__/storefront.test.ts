import { describe, it, expect } from 'vitest';
import { shareCard, catalogFacts, factsLine, fmtRating, priceLabel, ratingPlural, questPlural, cityPlural } from '../storefront';
import type { PublishedQuestWire } from '../api';

/** §2.3 hero facts — computed from the LIVE catalog response, never fabricated. */
function q(over: Partial<PublishedQuestWire>): PublishedQuestWire {
  return {
    quest_id: 'q', name: 'n', primary_comic: null, template_summary: '', description: null, pages: null, tasks: null, paid_hints: null,
    snapshot_version: 1, snapshot_id: 's', city: null, duration: null,
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
      rating: '4.8 — средняя оценка игроков',
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
    expect(fmtRating(5)).toBe('5');
    expect(fmtRating(4.75)).toBe('4.8');
  });
});

describe('shareCard — what a quest link looks like when it is pasted somewhere', () => {
  const quest = {
    quest_id: 'q1',
    name: 'Тайна старой крепости',
    city: 'Нови Сад',
    duration: '1.5 часа',
    description: '  Прогулка по Петроварадину: шифры на стенах, вид на Дунай и один очень упрямый замок.  ',
    primary_comic: 'https://media.test/cover.png',
  };

  it('names the quest and its city', () => {
    const card = shareCard(quest);
    expect(card.title).toBe('Тайна старой крепости — городской квест, Нови Сад');
    expect(card.image).toBe('https://media.test/cover.png');
  });

  it("uses the author's own description, trimmed to what a preview shows", () => {
    expect(shareCard(quest).description).toBe(
      'Прогулка по Петроварадину: шифры на стенах, вид на Дунай и один очень упрямый замок.',
    );
    const long = shareCard({ ...quest, description: 'Слово '.repeat(60) });
    expect(long.description.length).toBeLessThanOrEqual(200);
    expect(long.description.endsWith('…')).toBe(true);
  });

  it('falls back to the facts it has when the author wrote no description', () => {
    expect(shareCard({ ...quest, description: null }).description).toBe(
      'Городской квест. Нови Сад, 1.5 часа. Играйте офлайн — маршрут остаётся с вами.',
    );
    expect(shareCard({ ...quest, description: null, city: null, duration: null }).description).toBe(
      'Городской квест. Играйте офлайн — маршрут остаётся с вами.',
    );
  });

  it('never invents a city it does not have', () => {
    expect(shareCard({ ...quest, city: null }).title).toBe('Тайна старой крепости');
    expect(shareCard({ ...quest, city: '   ' }).title).toBe('Тайна старой крепости');
  });
});
