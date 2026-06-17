/**
 * Pure core of the admin Users screen: role coercion, search-term detection,
 * present-only contacts, role+search filtering, and RU formatting (admin-users spec).
 */
import { describe, expect, it } from 'vitest';
import {
  asRole,
  contactsOf,
  detectHint,
  filterUsers,
  formatJoined,
  matchesUser,
  pluralizeUsers,
  titleOf,
  toAdminUser,
  type AdminUser,
} from '../admin-users';
import type { AdminUserWire } from '../api';

const user = (over: Partial<AdminUser> = {}): AdminUser => ({
  id: 'dev:1',
  email: 'a@mail.ru',
  displayName: 'Анна Котова',
  role: 'player',
  createdAt: Math.floor(Date.UTC(2024, 2, 12) / 1000), // 12.03.24
  ...over,
});

describe('asRole', () => {
  it('passes through known roles and defaults unknown/empty to player', () => {
    expect(asRole('admin')).toBe('admin');
    expect(asRole('editor')).toBe('editor');
    expect(asRole('player')).toBe('player');
    expect(asRole('superuser')).toBe('player');
    expect(asRole('')).toBe('player');
    expect(asRole(null)).toBe('player');
  });
});

describe('toAdminUser', () => {
  it('maps the wire row to the view-model and coerces the role', () => {
    const wire: AdminUserWire = {
      player_id: 'dev:9',
      email: 'x@y.io',
      display_name: null,
      role: 'weird',
      created_at: 1710201600,
    };
    expect(toAdminUser(wire)).toEqual({
      id: 'dev:9',
      email: 'x@y.io',
      displayName: null,
      role: 'player',
      createdAt: 1710201600,
    });
  });
});

describe('detectHint', () => {
  it('recognizes email, telegram, phone, handle — and nothing for blank', () => {
    expect(detectHint('anna@mail.ru')).toBe('почта');
    expect(detectHint('@anna_k')).toBe('telegram');
    expect(detectHint('+7 905 112-04-77')).toBe('телефон');
    expect(detectHint('anna_k')).toBe('telegram / логин');
    expect(detectHint('   ')).toBeNull();
    expect(detectHint('')).toBeNull();
  });
});

describe('titleOf', () => {
  it('prefers display name, falls back to email, then a placeholder', () => {
    expect(titleOf(user())).toBe('Анна Котова');
    expect(titleOf(user({ displayName: null }))).toBe('a@mail.ru');
    expect(titleOf(user({ displayName: '   ' }))).toBe('a@mail.ru');
    expect(titleOf(user({ displayName: null, email: '' }))).toBe('Без имени');
  });
});

describe('contactsOf', () => {
  it('returns the email row only when present (present-only)', () => {
    expect(contactsOf(user())).toEqual([{ glyph: '✉', value: 'a@mail.ru' }]);
    expect(contactsOf(user({ email: '' }))).toEqual([]);
  });
});

describe('matchesUser', () => {
  it('matches name/email case-insensitively, ignores a leading @, empty matches all', () => {
    const u = user({ displayName: 'Мария Соколова', email: 'maria@geohod.app' });
    expect(matchesUser(u, '')).toBe(true);
    expect(matchesUser(u, 'мария')).toBe(true);
    expect(matchesUser(u, 'GEOHOD')).toBe(true);
    expect(matchesUser(u, '@maria')).toBe(true);
    expect(matchesUser(u, 'нет')).toBe(false);
  });
});

describe('filterUsers', () => {
  const users = [
    user({ id: '1', displayName: 'Анна', role: 'player', email: 'anna@mail.ru' }),
    user({ id: '2', displayName: 'Борис', role: 'editor', email: 'boris@geohod.app' }),
    user({ id: '3', displayName: 'Павел', role: 'admin', email: 'pavel@quest.io' }),
  ];

  it('filters by role (OR), preserving order', () => {
    expect(filterUsers(users, ['admin', 'editor'], '').map((u) => u.id)).toEqual(['2', '3']);
  });

  it('combines role filter AND search', () => {
    expect(filterUsers(users, ['player', 'editor'], 'geohod').map((u) => u.id)).toEqual(['2']);
  });

  it('no roles selected = all roles', () => {
    expect(filterUsers(users, [], '').length).toBe(3);
  });
});

describe('pluralizeUsers', () => {
  it('agrees with Russian plural rules', () => {
    expect(pluralizeUsers(0)).toBe('0 пользователей');
    expect(pluralizeUsers(1)).toBe('1 пользователь');
    expect(pluralizeUsers(2)).toBe('2 пользователя');
    expect(pluralizeUsers(5)).toBe('5 пользователей');
    expect(pluralizeUsers(11)).toBe('11 пользователей');
    expect(pluralizeUsers(21)).toBe('21 пользователь');
    expect(pluralizeUsers(22)).toBe('22 пользователя');
    expect(pluralizeUsers(112)).toBe('112 пользователей');
  });
});

describe('formatJoined', () => {
  it('formats unix seconds as DD.MM.YY in UTC', () => {
    expect(formatJoined(Math.floor(Date.UTC(2024, 2, 12) / 1000))).toBe('12.03.24');
    expect(formatJoined(Math.floor(Date.UTC(2025, 11, 8) / 1000))).toBe('08.12.25');
  });

  it('renders an em dash for missing/non-positive timestamps', () => {
    expect(formatJoined(0)).toBe('—');
    expect(formatJoined(-5)).toBe('—');
  });
});
