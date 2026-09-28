import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REVIEWS_QUERY,
  formatAverage,
  identityBadge,
  identityContact,
  identityName,
  markWho,
  moderationDate,
  parseReviewsQuery,
  questAverage,
  questFilterOptions,
  questSummary,
  relativeTime,
  reviewFacets,
  reviewQuestOptions,
  reviewSearch,
  reviewStatus,
  serializeReviewsQuery,
  sortReviews,
  templateLabel,
} from '../admin-moderation';
import type { AdminIdentityWire, AdminReviewWire } from '../api';

const id = (over: Partial<AdminIdentityWire>): AdminIdentityWire => ({
  user_id: 'dev:1',
  display_name: null,
  kind: 'anon',
  email: null,
  telegram_username: null,
  ...over,
});

describe('identityContact', () => {
  it('email and Google resolve to a mailto link', () => {
    expect(identityContact(id({ kind: 'google', email: 'a@gmail.com' })).href).toBe('mailto:a@gmail.com');
    expect(identityContact(id({ kind: 'email', email: 'b@mail.ru' }))).toMatchObject({
      href: 'mailto:b@mail.ru',
      label: 'b@mail.ru',
    });
  });
  it('Telegram resolves to t.me with a handle, disabled without one', () => {
    expect(identityContact(id({ kind: 'telegram', telegram_username: 'milan_bg' }))).toMatchObject({
      href: 'https://t.me/milan_bg',
      label: '@milan_bg',
    });
    const none = identityContact(id({ kind: 'telegram' }));
    expect(none.href).toBeNull();
    expect(none.label).toBe('Telegram · нет @username');
  });
  it('anonymous has no reachable contact', () => {
    expect(identityContact(id({ kind: 'anon' })).href).toBeNull();
  });
});

describe('identityBadge', () => {
  it('labels each provider kind', () => {
    expect(identityBadge('google').label).toBe('Google');
    expect(identityBadge('telegram').label).toBe('Telegram');
    expect(identityBadge('email').label).toBe('Почта');
    expect(identityBadge('anon').label).toBe('Аноним');
  });
});

describe('identityName', () => {
  it('prefers the display name, else the id, else «Гость» for anon', () => {
    expect(identityName(id({ display_name: 'Анна' }))).toBe('Анна');
    expect(identityName(id({ kind: 'email', user_id: 'dev:5' }))).toBe('dev:5');
    expect(identityName(id({ kind: 'anon' }))).toBe('Гость');
  });
});

describe('questAverage', () => {
  const rev = (player: string, quest: string, rating: number, hidden = false): AdminReviewWire => ({
    quest_id: quest,
    quest_name: quest,
    quest_city: null,
    rating,
    text: null,
    created_at: 0,
    changed_at: 0,
    hidden,
    hide: null,
    check: null,
    identity: id({ user_id: player }),
  });
  it('means the non-hidden ratings for the quest', () => {
    const rs = [rev('p1', 'q1', 5), rev('p2', 'q1', 1), rev('p3', 'q2', 3)];
    expect(questAverage(rs, 'q1')).toEqual({ avg: 3, count: 2 });
  });
  it('excludes a player for the hide before→after preview', () => {
    const rs = [rev('p1', 'q1', 5), rev('p2', 'q1', 1)];
    expect(questAverage(rs, 'q1', 'p2')).toEqual({ avg: 5, count: 1 });
  });
  it('skips already-hidden rows and returns null when nothing remains', () => {
    expect(questAverage([rev('p1', 'q1', 5, true)], 'q1')).toEqual({ avg: null, count: 0 });
  });
});

describe('relativeTime', () => {
  const now = 1_000_000_000 * 1000;
  it('formats recent and older instants', () => {
    expect(relativeTime(1_000_000_000, now)).toBe('только что');
    expect(relativeTime(1_000_000_000 - 2 * 86_400, now)).toBe('2 дня назад');
    expect(relativeTime(1_000_000_000 - 8 * 86_400, now)).toBe('1 неделю назад');
  });
});

describe('questFilterOptions', () => {
  it('prepends «Все квесты» and dedups quests in first-seen order', () => {
    const items = [
      { quest_id: 'q1', quest_name: 'A' },
      { quest_id: 'q2', quest_name: 'B' },
      { quest_id: 'q1', quest_name: 'A' },
    ];
    expect(questFilterOptions(items)).toEqual([
      { value: 'all', label: 'Все квесты' },
      { value: 'q1', label: 'A' },
      { value: 'q2', label: 'B' },
    ]);
    expect(questFilterOptions([])).toEqual([{ value: 'all', label: 'Все квесты' }]);
  });
});

describe('formatAverage / templateLabel', () => {
  it('formats one-decimal averages', () => {
    expect(formatAverage(4)).toBe('4');
    expect(formatAverage(14 / 3)).toBe('4.7');
  });
  it('labels step templates', () => {
    expect(templateLabel('task_answer')).toBe('вопрос');
    expect(templateLabel('congrats')).toBe('финал');
    expect(templateLabel(null)).toBe('');
  });
});

describe('moderationDate', () => {
  const now = Date.UTC(2026, 8, 28, 12);
  it('stays relative inside a week, a calendar date beyond it', () => {
    expect(moderationDate(now / 1000 - 2 * 86_400, now)).toBe('2 дня назад');
    // Noon UTC — the same calendar day in any runner time zone.
    expect(moderationDate(Date.UTC(2024, 4, 12, 12) / 1000, now)).toBe('12.05.2024');
  });
});

describe('reviews query', () => {
  const rev = (
    quest: string,
    rating: number,
    created_at: number,
    hidden = false,
  ): AdminReviewWire => ({
    quest_id: quest,
    quest_name: quest === 'q1' ? 'Тайна крепости' : 'Ирония судьбы',
    quest_city: null,
    rating,
    text: null,
    created_at,
    changed_at: created_at,
    hidden,
    hide: null,
    // Checked at the current version unless a test says otherwise.
    check: { through: created_at, at: 0, by_id: 'baseline', by_name: null },
    identity: id({ user_id: `${quest}-${rating}-${created_at}` }),
  });
  const at = (list: AdminReviewWire[]) => list.map((r) => r.created_at);

  it('round-trips through the URL, leaving the defaults out', () => {
    expect(serializeReviewsQuery(DEFAULT_REVIEWS_QUERY)).toBe('');
    expect(serializeReviewsQuery({ ...DEFAULT_REVIEWS_QUERY, q: '   ' })).toBe('');
    const q = {
      quest: 'q-1',
      rating: 4,
      view: 'hidden',
      text: 'with',
      q: '@anna',
      sort: 'worst',
    } as const;
    expect(serializeReviewsQuery(q)).toBe(
      '?view=hidden&quest=q-1&rating=4&text=with&q=%40anna&sort=worst',
    );
    expect(parseReviewsQuery(serializeReviewsQuery(q))).toEqual(q);
  });

  it('drops unknown or malformed values key by key', () => {
    expect(parseReviewsQuery('?sort=random&view=x&rating=9&quest=&text=maybe')).toEqual(
      DEFAULT_REVIEWS_QUERY,
    );
    expect(parseReviewsQuery('?rating=2.5&sort=best')).toEqual({ ...DEFAULT_REVIEWS_QUERY, sort: 'best' });
  });

  it('sorts newest / worst / best, ties newest-first, without mutating', () => {
    const rs = [rev('q1', 5, 10), rev('q1', 2, 20), rev('q1', 5, 30), rev('q1', 2, 5)];
    expect(at(sortReviews(rs, 'new'))).toEqual([30, 20, 10, 5]);
    expect(at(sortReviews(rs, 'worst'))).toEqual([20, 5, 30, 10]);
    expect(at(sortReviews(rs, 'best'))).toEqual([30, 10, 20, 5]);
    expect(at(rs)).toEqual([10, 20, 30, 5]);
  });

  it('counts each filter under all the others', () => {
    const rs = [rev('q1', 5, 1), rev('q1', 4, 2, true), rev('q2', 5, 3), rev('q2', 1, 4, true)];
    const f = reviewFacets(rs, { ...DEFAULT_REVIEWS_QUERY, quest: 'q1' });
    expect(at(f.list)).toEqual([1]);
    expect(f.views).toEqual({ new: 0, visible: 1, hidden: 1, all: 2 });
    // Ratings under quest q1 + the visible view; quests under the visible view alone.
    expect(f.ratings).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 });
    expect([...f.quests]).toEqual([['q1', 1], ['q2', 1]]);
    const hidden5 = reviewFacets(rs, { ...DEFAULT_REVIEWS_QUERY, view: 'hidden', rating: 5 });
    expect(hidden5.list).toEqual([]);
    expect(hidden5.views).toEqual({ new: 0, visible: 2, hidden: 0, all: 2 });
  });

  it('counts written vs star-only, and the search narrows every count', () => {
    const rs = [
      { ...rev('q1', 5, 1), text: 'Спасибо, всё понравилось' },
      { ...rev('q1', 4, 2), text: 'Нормально' },
      rev('q1', 5, 3),
      { ...rev('q2', 5, 4), text: 'СПАСИБО' },
    ];
    const f = reviewFacets(rs, { ...DEFAULT_REVIEWS_QUERY, text: 'with' });
    expect(at(f.list)).toEqual([4, 2, 1]);
    // The text counts ignore the text filter itself.
    expect(f.texts).toEqual({ with: 3, without: 1 });
    expect(f.ratings).toEqual({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 2 });
    const found = reviewFacets(rs, { ...DEFAULT_REVIEWS_QUERY, q: 'спасибо' });
    expect(at(found.list)).toEqual([4, 1]);
    expect(found.texts).toEqual({ with: 2, without: 0 });
    expect(found.views).toEqual({ new: 0, visible: 2, hidden: 0, all: 2 });
    expect([...found.quests]).toEqual([['q1', 1], ['q2', 1]]);
  });

  it('searches the text and every name of the author, case- and ё-insensitive', () => {
    const r: AdminReviewWire = {
      ...rev('q1', 5, 1),
      text: 'Ёлка у фонтана',
      identity: id({
        user_id: 'bubble-user-42',
        display_name: 'Анна',
        kind: 'telegram',
        email: 'anna@mail.ru',
        telegram_username: 'anna_tg',
      }),
    };
    for (const q of ['елка', 'ФОНТАН', 'анна', 'ANNA@MAIL', '@anna_tg', 'user-42', '  ']) {
      expect(reviewSearch(q)(r)).toBe(true);
    }
    expect(reviewSearch('борис')(r)).toBe(false);
  });

  it('tells new, changed and checked reviews apart and lists the unchecked as «Новые»', () => {
    const mark = { at: 1, by_id: 'acct:admin', by_name: 'Анна' };
    expect(reviewStatus({ changed_at: 10, check: null })).toBe('new');
    expect(reviewStatus({ changed_at: 10, check: { through: 9, ...mark } })).toBe('changed');
    expect(reviewStatus({ changed_at: 10, check: { through: 10, ...mark } })).toBe('checked');

    const rs = [
      { ...rev('q1', 5, 1), check: null }, // new
      { ...rev('q1', 2, 2, true), check: { through: 1, ...mark } }, // hidden, changed since
      rev('q1', 4, 3), // checked
    ];
    const f = reviewFacets(rs, { ...DEFAULT_REVIEWS_QUERY, view: 'new' });
    // «Новые» takes the unchecked whether hidden or not, and counts them like any view.
    expect(at(f.list)).toEqual([2, 1]);
    expect(f.views).toEqual({ new: 2, visible: 2, hidden: 1, all: 3 });
    expect(f.ratings).toEqual({ 1: 0, 2: 1, 3: 0, 4: 0, 5: 1 });
  });

  it('names who made a mark — nobody for the history that went live checked', () => {
    expect(markWho({ by_id: 'acct:admin', by_name: 'Анна' })).toBe('Анна');
    expect(markWho({ by_id: 'ops-token', by_name: null })).toBe('служебный токен');
    expect(markWho({ by_id: 'baseline', by_name: null })).toBeNull();
    expect(markWho({ by_id: 'bubble-admin-7', by_name: null })).toBe('bubble-admin-7');
  });

  it('summarizes a quest over its visible ratings', () => {
    const rs = [rev('q1', 5, 1), rev('q1', 4, 2), rev('q1', 1, 3, true), rev('q2', 2, 4)];
    expect(questSummary(rs, 'q1')).toEqual({
      avg: 4.5,
      count: 2,
      hidden: 1,
      stars: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 },
    });
    expect(questSummary([rev('q1', 3, 1, true)], 'q1')).toMatchObject({ avg: null, count: 0, hidden: 1 });
  });

  it('lists quests А–Я with their counts', () => {
    const rs = [rev('q1', 5, 1), rev('q2', 5, 2), rev('q1', 4, 3)];
    expect(reviewQuestOptions(rs, new Map([['q1', 2]]))).toEqual([
      { value: 'all', label: 'Все квесты' },
      { value: 'q2', label: 'Ирония судьбы · 0' },
      { value: 'q1', label: 'Тайна крепости · 2' },
    ]);
  });
});
