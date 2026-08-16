/**
 * UTC calendar days (`YYYY-MM-DD`) — the platform-wide date convention.
 * Mirrors backend `admin_stats.rs` (parse_day / day_from_unix); the shared
 * fixtures in goldens/utc-day/ pin both sides to identical rules (issue #69).
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strict `YYYY-MM-DD` → Unix seconds at 00:00:00 UTC, `null` on junk.
 * Rejects non-existent dates (`2026-02-30`): Date.UTC silently normalizes
 * them, so the round-trip compare is the validator — same trick as Rust.
 * Pre-epoch days reject too (Rust's clamp fails their round-trip).
 */
export function parseDay(iso: string): number | null {
  if (!DAY_RE.test(iso)) return null;
  const ms = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  if (ms < 0) return null;
  return new Date(ms).toISOString().slice(0, 10) === iso ? ms / 1000 : null;
}

/** UTC calendar day of a Unix-seconds instant; negatives clamp to epoch. */
export function dayFromUnix(secs: number): string {
  return new Date(Math.max(secs, 0) * 1000).toISOString().slice(0, 10);
}

/** Today as a UTC calendar day — the backend buckets by UTC days. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `day` shifted by `delta` days (UTC, no DST surprises). Throws on junk. */
export function addDays(day: string, delta: number): string {
  const secs = parseDay(day);
  if (secs == null) throw new Error(`addDays: invalid UTC day «${day}»`);
  return dayFromUnix(secs + delta * 86_400);
}

/** Inclusive day count of `from..to` («10–16 июля» → 7). Throws on junk. */
export function spanDays(from: string, to: string): number {
  const a = parseDay(from);
  const b = parseDay(to);
  if (a == null || b == null) throw new Error(`spanDays: invalid UTC day «${from}»..«${to}»`);
  return (b - a) / 86_400 + 1;
}
