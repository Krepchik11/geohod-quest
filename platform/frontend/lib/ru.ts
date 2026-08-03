/**
 * Russian language helpers — the ONE implementation of plural agreement and
 * number formatting. Every screen and view-model imports from here; no local
 * copies (issue #69).
 *
 * Manual plural rule on purpose: Intl.PluralRules on a node without full-icu
 * silently falls back to English rules, which would break tests and prod alike.
 */

/** Russian plural picker: forms = [1, 2–4, 5–0], with the 11–14 exception. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m = n % 10;
  const h = n % 100;
  if (m === 1 && h !== 11) return one;
  if (m >= 2 && m <= 4 && (h < 12 || h > 14)) return few;
  return many;
}

/** «3 купона» — the number plus its agreed noun. */
export function pluralCount(n: number, one: string, few: string, many: string): string {
  return `${n} ${plural(n, one, few, many)}`;
}

/** `YYYY-MM-DD` → «DD.MM.YYYY» (the design's date shape); `'yy'` for «DD.MM.YY». */
export function dottedDay(day: string, year: 'yyyy' | 'yy' = 'yyyy'): string {
  const [y, m, d] = day.split('-');
  return `${d}.${m}.${year === 'yy' ? y.slice(2) : y}`;
}

const RU_INT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

/**
 * Integer with narrow no-break thousands gaps: 1200 → «1 200» (U+202F).
 * ICU versions disagree on the ru-RU separator (U+00A0 vs U+202F) and the
 * minus sign, so both are normalized — output never depends on the runtime.
 */
export function formatNumber(n: number): string {
  return RU_INT.format(n).replace(/\s/g, ' ').replace(/−/g, '-');
}
