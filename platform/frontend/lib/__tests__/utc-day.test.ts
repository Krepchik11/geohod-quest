/**
 * Shared calendar-day rules: the SAME goldens/utc-day/*.json fixtures run in
 * the Rust suite (admin_stats tests). Any one-sided drift breaks one of the
 * two suites (issue #69).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addDays, dayFromUnix, parseDay, spanDays, todayUtc } from '../utc-day';

interface UtcDayFixture {
  name: string;
  description: string;
  parse_day: Array<{ input: string; unix: number | null }>;
  day_from_unix: Array<{ unix: number; day: string }>;
  add_days: Array<{ day: string; delta: number; expected: string }>;
  span_days: Array<{ from: string; to: string; expected: number }>;
}

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../goldens/utc-day');
const fixtures: UtcDayFixture[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(fixturesDir, f), 'utf8')));

describe('utc-day goldens (shared with cargo test)', () => {
  it('found the shared fixture set', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(1);
  });

  it('covers every fixture section (a new section must be wired here AND in Rust)', () => {
    const known = ['name', 'description', 'parse_day', 'day_from_unix', 'add_days', 'span_days'];
    for (const fx of fixtures) expect(Object.keys(fx).sort()).toEqual([...known].sort());
  });

  for (const fx of fixtures) {
    describe(fx.name, () => {
      it('parse_day', () => {
        for (const c of fx.parse_day) expect(parseDay(c.input), c.input).toBe(c.unix);
      });
      it('day_from_unix', () => {
        for (const c of fx.day_from_unix) expect(dayFromUnix(c.unix), String(c.unix)).toBe(c.day);
      });
      it('add_days', () => {
        for (const c of fx.add_days) expect(addDays(c.day, c.delta), `${c.day}+${c.delta}`).toBe(c.expected);
      });
      it('span_days', () => {
        for (const c of fx.span_days) expect(spanDays(c.from, c.to), `${c.from}..${c.to}`).toBe(c.expected);
      });
    });
  }
});

describe('todayUtc', () => {
  it('returns a valid UTC day', () => {
    expect(parseDay(todayUtc())).not.toBeNull();
  });
});
