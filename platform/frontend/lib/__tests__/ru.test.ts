import { describe, expect, it } from 'vitest';
import { dottedDay, formatNumber, plural, pluralCount } from '../ru';

describe('plural', () => {
  it('picks the three Russian forms', () => {
    expect(plural(1, 'квест', 'квеста', 'квестов')).toBe('квест');
    expect(plural(2, 'квест', 'квеста', 'квестов')).toBe('квеста');
    expect(plural(5, 'квест', 'квеста', 'квестов')).toBe('квестов');
    expect(plural(0, 'квест', 'квеста', 'квестов')).toBe('квестов');
  });

  it('handles the teens exception', () => {
    expect(plural(11, 'квест', 'квеста', 'квестов')).toBe('квестов');
    expect(plural(12, 'квест', 'квеста', 'квестов')).toBe('квестов');
    expect(plural(14, 'квест', 'квеста', 'квестов')).toBe('квестов');
    expect(plural(111, 'квест', 'квеста', 'квестов')).toBe('квестов');
  });

  it('applies units rule past the teens', () => {
    expect(plural(21, 'квест', 'квеста', 'квестов')).toBe('квест');
    expect(plural(22, 'квест', 'квеста', 'квестов')).toBe('квеста');
    expect(plural(25, 'квест', 'квеста', 'квестов')).toBe('квестов');
    expect(plural(101, 'квест', 'квеста', 'квестов')).toBe('квест');
  });
});

describe('pluralCount', () => {
  it('prefixes the number', () => {
    expect(pluralCount(1, 'купон', 'купона', 'купонов')).toBe('1 купон');
    expect(pluralCount(3, 'купон', 'купона', 'купонов')).toBe('3 купона');
    expect(pluralCount(11, 'купон', 'купона', 'купонов')).toBe('11 купонов');
  });
});

describe('dottedDay', () => {
  it('reorders a UTC day into the design shape', () => {
    expect(dottedDay('2026-07-16')).toBe('16.07.2026');
    expect(dottedDay('2026-07-16', 'yy')).toBe('16.07.26');
  });
});

describe('formatNumber', () => {
  it('groups thousands with U+202F regardless of ICU', () => {
    expect(formatNumber(1200)).toBe('1 200');
    expect(formatNumber(1234567)).toBe('1 234 567');
  });

  it('leaves small and zero values ungrouped', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
  });

  it('rounds to integers', () => {
    expect(formatNumber(1200.6)).toBe('1 201');
  });

  it('keeps the sign', () => {
    expect(formatNumber(-1200)).toBe('-1 200');
  });
});
