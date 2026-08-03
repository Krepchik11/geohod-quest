import { describe, it, expect } from 'vitest';
import {
  formatAverage,
  identityBadge,
  identityContact,
  identityName,
  plural,
  questAverage,
  questFilterOptions,
  relativeTime,
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
    hidden,
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

describe('plural / formatAverage / templateLabel', () => {
  it('pluralizes Russian counts', () => {
    expect(plural(1, 'запись', 'записи', 'записей')).toBe('запись');
    expect(plural(3, 'запись', 'записи', 'записей')).toBe('записи');
    expect(plural(5, 'запись', 'записи', 'записей')).toBe('записей');
    expect(plural(11, 'запись', 'записи', 'записей')).toBe('записей');
  });
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
