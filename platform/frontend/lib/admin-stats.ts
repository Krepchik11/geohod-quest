/**
 * Pure view-model for the admin statistics page (Admin Stats.dc.html).
 * The backend returns raw counters (`/api/admin/stats*`); everything the page
 * shows — deltas, chart geometry, funnel drop-offs, labels — is derived here,
 * with no React, so it is unit-testable like admin-features/admin-users.
 *
 * All days are UTC `YYYY-MM-DD` strings, matching the backend convention.
 */
import type {
  AdminStatsDailyWire,
  AdminStatsOverviewWire,
  AdminStatsQuestRowWire,
  AdminStatsQuestWire,
  AdminStatsTotalsWire,
} from './api';
import type { GameStep } from './shared-model';
import { plural, questPlural } from './storefront';

export { plural };

export type StatsRangeKey = '7' | '30' | '90' | 'all' | 'custom';

export const RANGE_CHIPS: Array<{ key: StatsRangeKey; label: string }> = [
  { key: '7', label: '7 дней' },
  { key: '30', label: '30 дней' },
  { key: '90', label: '90 дней' },
  { key: 'all', label: 'Всё время' },
  { key: 'custom', label: 'Период…' },
];

/** Today as a UTC calendar day — the backend buckets by UTC days. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `iso` shifted by `days` (UTC, no DST surprises). */
export function addDaysIso(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The query bounds a range chip resolves to. `all` sends no `from` (the
 * backend anchors at the earliest event); `custom` passes the user's inputs
 * through, swapping them when inverted so the request is always valid.
 * Returns `null` while a custom input is empty or half-typed (native date
 * inputs emit `''` mid-edit) — the page must then keep the current data
 * instead of silently requesting «Всё время».
 */
export function boundsFor(
  key: StatsRangeKey,
  custom: { from: string; to: string },
  today: string = todayUtc(),
): { from?: string; to: string } | null {
  if (key === 'all') return { to: today };
  if (key === 'custom') {
    const { from, to } = custom;
    if (!DAY_RE.test(from) || !DAY_RE.test(to)) return null;
    return from <= to ? { from, to } : { from: to, to: from };
  }
  const n = Number(key);
  return { from: addDaysIso(today, -(n - 1)), to: today };
}

// ── formatting ───────────────────────────────────────────────────────────────

export function fmtInt(n: number): string {
  return n.toLocaleString('ru-RU');
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** `2026-07-16` → `16 июл` (the chart/period axis shorthand). */
export function fmtDayShort(iso: string): string {
  const m = Number(iso.slice(5, 7));
  return `${Number(iso.slice(8, 10))} ${MONTHS_SHORT[m - 1] ?? ''}`;
}

/** «10 июл — 16 июл 2026 · 7 дн.» */
export function periodLabel(from: string, to: string): string {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  return `${fmtDayShort(from)} — ${fmtDayShort(to)} ${to.slice(0, 4)} · ${days} дн.`;
}

// ── KPI deltas ───────────────────────────────────────────────────────────────

export type DeltaTone = 'up' | 'down' | 'flat';

export interface KpiVm {
  label: string;
  value: string;
  delta: string;
  deltaNote: string;
  tone: DeltaTone;
}

type DeltaParts = Pick<KpiVm, 'delta' | 'deltaNote' | 'tone'>;

const NO_DELTA: DeltaParts = { delta: '', deltaNote: '', tone: 'flat' };

/** Shared delta shape: sign glyph, tone, «к пред. периоду» note. `zeroLabel`
 *  renders when |diff| is below `epsilon`; `fmt` renders the magnitude. */
function deltaVm(diff: number, epsilon: number, zeroLabel: string, fmt: (abs: number) => string): DeltaParts {
  if (Math.abs(diff) < epsilon) return { delta: zeroLabel, deltaNote: 'к пред. периоду', tone: 'flat' };
  return {
    delta: `${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff))}`,
    deltaNote: 'к пред. периоду',
    tone: diff > 0 ? 'up' : 'down',
  };
}

function deltaOf(cur: number, prev: number | null): DeltaParts {
  // Percent change is undefined against an empty previous window.
  if (prev === null || prev === 0) return NO_DELTA;
  const pct = Math.round(((cur - prev) / prev) * 100);
  return deltaVm(pct, 1, '0%', (abs) => `${abs}%`);
}

/** Completion rate (%) of a period; 0 when nothing started. */
export function completionRate(t: AdminStatsTotalsWire): number {
  return t.started ? (t.finished / t.started) * 100 : 0;
}

/** The four overview/detail KPI cards, deltas against the previous window. */
export function kpisFor(cur: AdminStatsTotalsWire, prev: AdminStatsTotalsWire | null): KpiVm[] {
  const ratio = completionRate(cur);
  // The п.п. delta is a plain subtraction: it only needs the previous RATE to
  // be defined (started > 0) — a previous rate of exactly 0% is a valid base.
  const ratioDelta =
    prev && prev.started > 0
      ? deltaVm(ratio - completionRate(prev), 0.05, '0 п.п.', (abs) => `${abs.toFixed(1)} п.п.`)
      : NO_DELTA;
  return [
    { label: 'Куплено квестов', value: fmtInt(cur.purchased), ...deltaOf(cur.purchased, prev && prev.purchased) },
    { label: 'Начато прохождений', value: fmtInt(cur.started), ...deltaOf(cur.started, prev && prev.started) },
    { label: 'Завершено', value: fmtInt(cur.finished), ...deltaOf(cur.finished, prev && prev.finished) },
    { label: 'Завершаемость', value: `${ratio.toFixed(1)}%`, ...ratioDelta },
  ];
}

// ── trend chart geometry ─────────────────────────────────────────────────────

export interface ChartVm {
  /** SVG path of the «начато» line and its area fill. */
  lineStarted: string;
  lineFinished: string;
  area: string;
  grid: Array<{ y: number; label: string }>;
  xLabels: Array<{ x: number; label: string }>;
}

/** SVG frame of the trend chart — shared with the component that renders the
 *  grid/axis so paths and chrome can never drift apart. */
export const CHART = { left: 44, right: 712, top: 16, bottom: 196, width: 720, height: 230 };

/**
 * Chart geometry over the daily series: weekly buckets past 62 days (the
 * design rule), a «nice» y-max, polyline paths, 5 grid lines, ≤6 x labels.
 * `null` when the series is empty (the page then hides the card).
 *
 * Buckets are aligned to the END of the range: with a length that is not a
 * multiple of 7 the PARTIAL bucket lands at the oldest edge, so the newest
 * data point is always a full week — a short final bucket would draw a fake
 * decline exactly where the admin looks for the trend.
 */
export function chartVm(daily: AdminStatsDailyWire[]): ChartVm | null {
  if (daily.length === 0) return null;
  const bucketSize = daily.length > 62 ? 7 : 1;
  const buckets: Array<{ date: string; started: number; finished: number }> = [];
  for (let end = daily.length; end > 0; end -= bucketSize) {
    const slice = daily.slice(Math.max(0, end - bucketSize), end);
    buckets.unshift({
      date: slice[0].date,
      started: slice.reduce((a, d) => a + d.started, 0),
      finished: slice.reduce((a, d) => a + d.finished, 0),
    });
  }
  const { left: L, right: R, top: T, bottom: B } = CHART;
  const rawMax = Math.max(1, ...buckets.map((b) => b.started), ...buckets.map((b) => b.finished));
  const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= rawMax) ?? rawMax;
  const x = (i: number) => (buckets.length > 1 ? L + (i / (buckets.length - 1)) * (R - L) : (L + R) / 2);
  const y = (v: number) => B - (v / nice) * (B - T);
  const line = (key: 'started' | 'finished') =>
    buckets.map((b, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(b[key]).toFixed(1)}`).join(' ');
  const lineStarted = line('started');
  const nx = Math.min(6, buckets.length);
  return {
    lineStarted,
    lineFinished: line('finished'),
    area: `${lineStarted} L${R} ${B} L${L} ${B} Z`,
    grid: [0, 0.25, 0.5, 0.75, 1].map((f) => ({
      y: Number(y(nice * f).toFixed(1)),
      label: fmtInt(Math.round(nice * f)),
    })),
    xLabels: Array.from({ length: nx }, (_, i) => {
      const bi = Math.round((i / Math.max(1, nx - 1)) * (buckets.length - 1));
      return { x: Number(x(bi).toFixed(1)), label: fmtDayShort(buckets[bi].date) };
    }),
  };
}

// ── per-quest table ──────────────────────────────────────────────────────────

/** Completion below this many percent renders the row's bar in the warn color. */
export const COMPLETION_WARN_BELOW = 40;

export interface QuestRowVm {
  questId: string;
  name: string;
  meta: string;
  purchased: string;
  started: string;
  finished: string;
  pct: number;
  pctNote: string;
  low: boolean;
  /**
   * The quest has a catalog entry. `false` means a publish never happened (a
   * quest moved back to draft/test KEEPS its published row, so it stays `true`):
   * the numbers are real, but there is no frozen snapshot and so no funnel to open.
   */
  published: boolean;
}

/** «Казань · 7 шагов» (city optional, steps fall back to the template summary). */
export function questMetaLine(row: { city: string | null; pages: number | null; template_summary: string }): string {
  const steps = row.pages !== null ? `${row.pages} ${plural(row.pages, 'шаг', 'шага', 'шагов')}` : row.template_summary;
  return row.city ? `${row.city} · ${steps}` : steps;
}

export function questRowVm(row: AdminStatsQuestRowWire): QuestRowVm {
  const pct = row.started ? Math.round((row.finished / row.started) * 100) : 0;
  return {
    questId: row.quest_id,
    name: row.name,
    // Without a catalog entry the step chips genuinely do not exist, but the
    // quest is still named and placed by the authoring registry — keep what is
    // known instead of replacing the whole line.
    meta: row.published
      ? questMetaLine(row)
      : [row.city, 'нет в каталоге'].filter(Boolean).join(' · '),
    purchased: fmtInt(row.purchased),
    started: fmtInt(row.started),
    finished: fmtInt(row.finished),
    pct,
    pctNote: `${fmtInt(row.finished)} из ${fmtInt(row.started)}`,
    low: pct < COMPLETION_WARN_BELOW,
    published: row.published,
  };
}

/** «6 квестов · по убыванию стартов · …» count part. */
export function questsCountLabel(n: number): string {
  return `${n} ${questPlural(n)}`;
}

// ── step funnel (detail view) ────────────────────────────────────────────────

export interface FunnelStepVm {
  idx: number;
  name: string;
  template: string;
  count: string;
  /** % of started that reached this step. */
  pct: number;
  barW: number;
  tone: 'start' | 'ok' | 'worst';
  drop: { label: string; tone: 'worst' | 'warn' | 'quiet' } | null;
  isWorst: boolean;
}

/** Short funnel chips per step template. Keyed by the SHARED template union
 *  (lib/shared-model.ts), so adding a template fails compilation here instead
 *  of silently rendering the raw key. */
const TEMPLATE_RU: Record<GameStep['template'], string> = {
  start: 'старт',
  video: 'видео',
  task_answer: 'вопрос',
  task_no: 'задание',
  continue: 'переход',
  route_video: 'маршрут',
  congrats: 'финал',
};

export interface FunnelVm {
  steps: FunnelStepVm[];
  summary: string;
}

/**
 * The funnel view: per-step reach bars (% of `funnel_started`), inter-step
 * drop rows, the single worst drop highlighted (only when it loses ≥8%), and
 * the design's summary sentence.
 */
export function funnelVm(detail: Pick<AdminStatsQuestWire, 'funnel' | 'funnel_started'>): FunnelVm {
  const started = detail.funnel_started;
  const reach = detail.funnel.map((s) => s.reached);
  const drops = reach.map((c, i) => (i === 0 ? 0 : reach[i - 1] ? (reach[i - 1] - c) / reach[i - 1] : 0));
  const worst = drops.length > 1 ? drops.reduce((w, d, i) => (d > drops[w] ? i : w), 1) : 0;
  const worstIsReal = drops.length > 1 && drops[worst] >= 0.08;
  const steps = detail.funnel.map((s, i) => {
    const pctOf = started ? (s.reached / started) * 100 : 0;
    const dropPct = Math.round(drops[i] * 100);
    const lost = i ? reach[i - 1] - reach[i] : 0;
    const isWorst = worstIsReal && i === worst;
    return {
      idx: i + 1,
      name: s.title,
      template: (TEMPLATE_RU as Record<string, string>)[s.template] ?? s.template,
      count: fmtInt(s.reached),
      pct: Math.round(pctOf),
      barW: Math.max(1.5, pctOf),
      tone: (isWorst ? 'worst' : i === 0 ? 'start' : 'ok') as FunnelStepVm['tone'],
      drop:
        i > 0 && dropPct > 0
          ? {
              label: `−${dropPct}% · ушли ${fmtInt(lost)} чел.`,
              tone: (isWorst ? 'worst' : dropPct >= 10 ? 'warn' : 'quiet') as 'worst' | 'warn' | 'quiet',
            }
          : null,
      isWorst,
    };
  });
  const last = reach.length ? reach[reach.length - 1] : 0;
  const finalPct = started ? Math.round((last / started) * 100) : 0;
  const summary =
    steps.length === 0
      ? 'Для этой версии квеста ещё нет данных по шагам.'
      : worstIsReal
        ? `До финала доходит ${finalPct}% начавших. Основной отток — на шаге ${worst + 1} «${detail.funnel[worst].title}»: стоит проверить сложность задания и подсказки.`
        : `До финала доходит ${finalPct}% начавших — равномерная воронка без выраженных провалов.`;
  return { steps, summary };
}

// ── overview convenience ─────────────────────────────────────────────────────

export interface OverviewVm {
  kpis: KpiVm[];
  period: string;
  chart: ChartVm | null;
  rows: QuestRowVm[];
  questsCount: string;
}

export function overviewVm(wire: AdminStatsOverviewWire): OverviewVm {
  return {
    kpis: kpisFor(wire.totals, wire.prev),
    period: periodLabel(wire.from, wire.to),
    chart: chartVm(wire.daily),
    rows: wire.quests.map(questRowVm),
    questsCount: questsCountLabel(wire.quests.length),
  };
}
