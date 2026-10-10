import { describe, expect, it } from 'vitest';
import {
  cityKey,
  cityUsageLabel,
  deleteBlockedText,
  mergeSuggestions,
  type AdminCityWire,
} from '../admin-cities';

const city = (name: string, over: Partial<AdminCityWire> = {}): AdminCityWire => ({
  name,
  image: null,
  slogan: null,
  quests: 0,
  in_store: 0,
  ...over,
});

describe('cityUsageLabel', () => {
  it('counts quests and the ones on sale', () => {
    expect(cityUsageLabel(city('Нови Сад', { quests: 5, in_store: 4 }))).toBe('5 квестов · 4 в магазине');
    expect(cityUsageLabel(city('Белград', { quests: 1, in_store: 0 }))).toBe('1 квест · не в магазине');
    expect(cityUsageLabel(city('Стамбул', { quests: 2, in_store: 2 }))).toBe('2 квеста · 2 в магазине');
    expect(cityUsageLabel(city('Москва'))).toBe('Нет квестов');
  });
});

describe('cityKey', () => {
  it('ignores case, ё and punctuation', () => {
    expect(cityKey('Нови-Сад')).toBe(cityKey('нови сад'));
    expect(cityKey('Нови Сад')).toBe(cityKey('НОВИ  САД.'));
    expect(cityKey('Орёл')).toBe(cityKey('Орел'));
    expect(cityKey('Нови Сад')).not.toBe(cityKey('Сад'));
  });
});

describe('mergeSuggestions', () => {
  it('points look-alikes at the busiest spelling and leaves distinct cities alone', () => {
    const list = [
      city('Нови Сад', { quests: 5 }),
      city('Белград', { quests: 1 }),
      city('Нови-Сад', { quests: 1 }),
      city('нови сад'),
    ];
    const s = mergeSuggestions(list);
    expect(s.get('Нови-Сад')).toBe('Нови Сад');
    expect(s.get('нови сад')).toBe('Нови Сад');
    expect(s.has('Нови Сад')).toBe(false);
    expect(s.has('Белград')).toBe(false);
  });
});

describe('deleteBlockedText', () => {
  it('names the count and the way out', () => {
    expect(deleteBlockedText(city('Нови Сад', { quests: 1 }))).toBe(
      'Удалить нельзя: в городе 1 квест. Переименуйте город в другой, чтобы перенести его.',
    );
    expect(deleteBlockedText(city('Нови Сад', { quests: 3 }))).toMatch(/3 квеста.*перенести их/);
  });
});
