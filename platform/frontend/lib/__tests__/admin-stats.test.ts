import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  boundsFor,
  chartVm,
  completionRate,
  funnelVm,
  kpisFor,
  periodLabel,
  plural,
  questMetaLine,
  questRowVm,
  questsCountLabel,
} from '../admin-stats';

describe('date helpers', () => {
  it('addDaysIso shifts across month and leap boundaries', () => {
    expect(addDaysIso('2026-07-16', -6)).toBe('2026-07-10');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysIso('2024-03-01', -1)).toBe('2024-02-29');
  });

  it('boundsFor maps chips to inclusive ranges', () => {
    expect(boundsFor('7', { from: '', to: '' }, '2026-07-16')).toEqual({
      from: '2026-07-10',
      to: '2026-07-16',
    });
    expect(boundsFor('all', { from: '', to: '' }, '2026-07-16')).toEqual({ to: '2026-07-16' });
    // Custom swaps inverted inputs instead of sending an invalid request.
    expect(boundsFor('custom', { from: '2026-07-16', to: '2026-07-10' }, '2026-07-16')).toEqual({
      from: '2026-07-10',
      to: '2026-07-16',
    });
    // An empty/half-typed custom input must NOT silently become «Всё время».
    expect(boundsFor('custom', { from: '', to: '2026-07-16' }, '2026-07-16')).toBeNull();
    expect(boundsFor('custom', { from: '2026-07-1', to: '2026-07-16' }, '2026-07-16')).toBeNull();
  });

  it('periodLabel renders the design shape', () => {
    expect(periodLabel('2026-07-10', '2026-07-16')).toBe('10 июл — 16 июл 2026 · 7 дн.');
  });
});

describe('plurals', () => {
  it('picks russian forms', () => {
    expect(plural(1, 'квест', 'квеста', 'квестов')).toBe('квест');
    expect(plural(3, 'квест', 'квеста', 'квестов')).toBe('квеста');
    expect(plural(11, 'квест', 'квеста', 'квестов')).toBe('квестов');
    expect(plural(21, 'квест', 'квеста', 'квестов')).toBe('квест');
    expect(questsCountLabel(6)).toBe('6 квестов');
  });
});

describe('kpisFor', () => {
  const cur = { purchased: 120, started: 100, finished: 55 };

  it('computes deltas against the previous window', () => {
    const prev = { purchased: 100, started: 80, finished: 50 };
    const [bought, started, finished, ratio] = kpisFor(cur, prev);
    expect(bought.delta).toBe('+20%');
    expect(bought.tone).toBe('up');
    expect(started.delta).toBe('+25%');
    expect(finished.delta).toBe('+10%');
    // 55% vs 62.5% = −7.5 п.п.
    expect(ratio.value).toBe('55.0%');
    expect(ratio.delta).toBe('−7.5 п.п.');
    expect(ratio.tone).toBe('down');
  });

  it('omits deltas without a previous window (Всё время)', () => {
    for (const kpi of kpisFor(cur, null)) {
      expect(kpi.delta).toBe('');
      expect(kpi.tone).toBe('flat');
    }
  });

  it('never divides by zero', () => {
    expect(completionRate({ purchased: 0, started: 0, finished: 0 })).toBe(0);
    const kpis = kpisFor({ purchased: 0, started: 0, finished: 0 }, { purchased: 0, started: 0, finished: 0 });
    expect(kpis[3].value).toBe('0.0%');
    expect(kpis[0].delta).toBe('');
  });

  it('shows the п.п. delta when the previous rate was exactly 0%', () => {
    // prev started 40 / finished 0 → 0% is a valid comparison base.
    const kpis = kpisFor(cur, { purchased: 100, started: 40, finished: 0 });
    expect(kpis[3].delta).toBe('+55.0 п.п.');
    expect(kpis[3].tone).toBe('up');
  });
});

describe('chartVm', () => {
  const day = (date: string, started: number, finished: number) => ({ date, started, finished });

  it('is null for an empty series', () => {
    expect(chartVm([])).toBeNull();
  });

  it('builds paths, grid and x labels for a short series', () => {
    const vm = chartVm([day('2026-07-10', 4, 1), day('2026-07-11', 10, 3)]);
    expect(vm).not.toBeNull();
    expect(vm!.lineStarted.startsWith('M44.0 ')).toBe(true);
    expect(vm!.lineStarted).toContain('L712.0 ');
    expect(vm!.grid).toHaveLength(5);
    // rawMax 10 → nice 10 → top grid label «10».
    expect(vm!.grid[4].label).toBe('10');
    expect(vm!.xLabels[0].label).toBe('10 июл');
    expect(vm!.area.endsWith('Z')).toBe(true);
  });

  it('buckets weekly past 62 days, aligning full weeks to the newest edge', () => {
    // 90 days of a constant 1 start/day: 12 full weeks + a 6-day remainder.
    const daily = Array.from({ length: 90 }, (_, i) => day(addDaysIso('2026-01-01', i), 1, 0));
    const vm = chartVm(daily)!;
    expect(vm.grid[4].label).toBe('10'); // nice(7) = 10
    expect(vm.xLabels).toHaveLength(6);
    // The NEWEST point must be a full week (no fake decline at the right
    // edge); the partial bucket sits at the oldest edge instead.
    const lastY = Number(vm.lineStarted.split(' ').at(-1));
    const firstY = Number(vm.lineStarted.split(' ')[1]);
    expect(lastY).toBeLessThan(firstY); // 7/day week plots higher (smaller y) than 6-day remainder
  });

  it('scales the y axis to finished when it exceeds started', () => {
    const vm = chartVm([day('2026-07-10', 1, 9)])!;
    expect(vm.grid[4].label).toBe('10');
  });
});

describe('quest rows', () => {
  const row = {
    quest_id: 'q1',
    name: 'Тайны',
    city: 'Казань' as string | null,
    template_summary: '7 steps',
    pages: 7 as number | null,
    published: true,
    purchased: 100,
    started: 80,
    finished: 20,
  };

  it('derives percent, note and the warn flag', () => {
    const vm = questRowVm(row);
    expect(vm.pct).toBe(25);
    expect(vm.pctNote).toBe('20 из 80');
    expect(vm.low).toBe(true);
    expect(vm.meta).toBe('Казань · 7 шагов');
    expect(vm.published).toBe(true);
  });

  // `published: false` means the quest has no catalog entry at all — a publish
  // never happened. Moving a quest to draft/test keeps its published row, so it
  // still reports `published: true`; calling this row "снят с публикации" claimed
  // a delisting that never took place.
  it('says a quest is absent from the catalog, keeping the city it does know', () => {
    const vm = questRowVm({ ...row, published: false, pages: null, template_summary: '' });
    expect(vm.published).toBe(false);
    expect(vm.name).toBe('Тайны');
    expect(vm.meta).toBe('Казань · нет в каталоге');
  });

  it('omits the city separator when the quest has no city either', () => {
    const vm = questRowVm({ ...row, published: false, city: null, pages: null, template_summary: '' });
    expect(vm.meta).toBe('нет в каталоге');
  });

  it('handles zero starts and missing meta', () => {
    expect(questRowVm({ ...row, started: 0, finished: 0 }).pct).toBe(0);
    expect(questMetaLine({ city: null, pages: null, template_summary: '7 steps' })).toBe('7 steps');
    expect(questMetaLine({ city: 'Казань', pages: 1, template_summary: '' })).toBe('Казань · 1 шаг');
  });
});

describe('funnelVm', () => {
  const step = (title: string, template: string, reached: number, position: number) => ({
    position,
    title,
    template,
    reached,
  });

  it('marks the single worst drop (≥8%) and writes the summary', () => {
    const vm = funnelVm({
      funnel_started: 100,
      funnel: [
        step('Старт', 'start', 100, 0),
        step('Видео', 'video', 90, 1),
        step('Задание', 'task_answer', 50, 2),
        step('Финал', 'congrats', 47, 3),
      ],
    });
    expect(vm.steps[0].pct).toBe(100);
    expect(vm.steps[0].tone).toBe('start');
    expect(vm.steps[2].isWorst).toBe(true);
    expect(vm.steps[2].tone).toBe('worst');
    expect(vm.steps[2].drop?.label).toBe('−44% · ушли 40 чел.');
    expect(vm.steps[3].drop?.tone).toBe('quiet');
    expect(vm.summary).toContain('шаге 3');
    expect(vm.summary).toContain('47%');
  });

  it('reports an even funnel without a worst badge', () => {
    const vm = funnelVm({
      funnel_started: 100,
      funnel: [step('Старт', 'start', 100, 0), step('Финал', 'congrats', 97, 1)],
    });
    expect(vm.steps.every((s) => !s.isWorst)).toBe(true);
    expect(vm.summary).toContain('равномерная воронка');
  });

  it('survives zero attempts and an empty funnel', () => {
    const vm = funnelVm({ funnel_started: 0, funnel: [step('Старт', 'start', 0, 0)] });
    expect(vm.steps[0].pct).toBe(0);
    expect(vm.steps[0].drop).toBeNull();
    expect(funnelVm({ funnel_started: 0, funnel: [] }).summary).toContain('нет данных');
  });

  it('translates unknown templates as-is', () => {
    const vm = funnelVm({ funnel_started: 1, funnel: [step('X', 'mystery', 1, 0)] });
    expect(vm.steps[0].template).toBe('mystery');
  });
});
