import { describe, it, expect } from 'vitest';
import type { ConstructorQuestWire } from '../api';
import {
  editedAgo,
  factsLine,
  priceLabel,
  ratingLabel,
  tabCounts,
  tileAction,
  tileCities,
  visibleTiles,
} from '../quest-tiles';
import {
  draftFingerprint,
  migrateQuest,
  newQuest,
  questDash,
  questUpsert,
  duplicateQuest,
} from '../constructor-model';
import { formatNumber } from '../ru';

function q(over: Partial<ConstructorQuestWire>): ConstructorQuestWire {
  return {
    quest_id: 'q', name: 'Квест', author: 'A', author_id: 'a', status: 'draft', steps: 10,
    completed: 0, buyers: 0, published_version: null, complexity: 'medium', age_target: 'everyone',
    tags: [], cover: null, created_at: 1, updated_at: 1, city: null, price: null, duration_min: 60,
    distance_km: 5, tasks: null, gate_errors: null, gate_warnings: null, unpublished_changes: null,
    rating_avg: 0, rating_count: 0, players: 0, revenue: null,
    ...over,
  };
}

describe('tileAction — что ждёт автора', () => {
  it('правки опубликованного квеста зовут опубликовать следующую версию', () => {
    expect(tileAction(q({ status: 'published', published_version: 3, unpublished_changes: true }))).toEqual({
      kind: 'changes',
      next: 4,
    });
    expect(tileAction(q({ status: 'test', published_version: 1, unpublished_changes: true }))).toEqual({
      kind: 'changes',
      next: 2,
    });
  });
  it('неизвестно или без правок — молчим', () => {
    expect(tileAction(q({ status: 'published', published_version: 3, unpublished_changes: null }))).toBeNull();
    expect(tileAction(q({ status: 'published', published_version: 3, unpublished_changes: false }))).toBeNull();
  });
  it('черновик готов только при нуле ошибок; с ошибками или без сводки — обычная работа', () => {
    expect(tileAction(q({ gate_errors: 0 }))).toEqual({ kind: 'ready' });
    expect(tileAction(q({ gate_errors: 2 }))).toBeNull();
    expect(tileAction(q({ gate_errors: null }))).toBeNull();
  });
});

describe('вкладки, город, поиск, сортировка', () => {
  const list = [
    q({ quest_id: 'a', name: 'Тайна крепости', status: 'published', published_version: 1, unpublished_changes: true, city: 'Нови Сад', players: 477, rating_avg: 4.97, rating_count: 58, updated_at: 50 }),
    q({ quest_id: 'b', name: 'Петрович', status: 'published', published_version: 2, city: 'Белград', players: 117, rating_avg: 5, rating_count: 11, updated_at: 10, tags: ['исторический'] }),
    q({ quest_id: 'c', name: 'Калемегдан', status: 'draft', gate_errors: 3, city: 'Белград', updated_at: 90 }),
    q({ quest_id: 'd', name: 'Гранд-базар', status: 'draft', gate_errors: 0, city: 'Стамбул', updated_at: 70 }),
    q({ quest_id: 'e', name: 'Ночной Петроварадин', status: 'test', published_version: 1, city: 'Нови Сад', updated_at: 20 }),
  ];
  const base = { tab: 'all' as const, search: '', city: '', sort: 'updated' as const };
  const ids = (xs: ConstructorQuestWire[]) => xs.map((x) => x.quest_id);

  it('счётчики вкладок', () => {
    expect(tabCounts(list)).toEqual({ all: 5, published: 2, test: 1, draft: 2, attention: 2 });
  });
  it('по умолчанию — недавно изменённые сверху', () => {
    expect(ids(visibleTiles(list, base))).toEqual(['c', 'd', 'a', 'e', 'b']);
  });
  it('«Требуют внимания» — правки и готовый черновик', () => {
    expect(ids(visibleTiles(list, { ...base, tab: 'attention' }))).toEqual(['d', 'a']);
  });
  it('город и поиск по названию, городу, тегу', () => {
    expect(ids(visibleTiles(list, { ...base, city: 'Белград' }))).toEqual(['c', 'b']);
    expect(ids(visibleTiles(list, { ...base, search: 'истор' }))).toEqual(['b']);
    expect(ids(visibleTiles(list, { ...base, search: 'стамбул' }))).toEqual(['d']);
  });
  it('игроки, рейтинг (без оценок — ниже), название', () => {
    expect(ids(visibleTiles(list, { ...base, sort: 'players' })).slice(0, 2)).toEqual(['a', 'b']);
    expect(ids(visibleTiles(list, { ...base, sort: 'rating' })).slice(0, 2)).toEqual(['b', 'a']);
    expect(ids(visibleTiles(list, { ...base, sort: 'name' }))[0]).toBe('d');
  });
  it('города для фильтра — частые сверху', () => {
    expect(tileCities(list)).toEqual([
      { name: 'Белград', count: 2 },
      { name: 'Нови Сад', count: 2 },
      { name: 'Стамбул', count: 1 },
    ]);
  });
});

describe('подписи', () => {
  it('цена, рейтинг, состав', () => {
    expect(priceLabel(0)).toBe('Бесплатно');
    expect(priceLabel(1000)).toBe(formatNumber(1000) + '\u00a0₽');
    expect(priceLabel(null)).toBe('');
    expect(ratingLabel(4.9655)).toBe('4,97');
    expect(factsLine(q({ duration_min: 90, distance_km: 4.5, steps: 31, tasks: 11 }))).toBe(
      '90 мин · 4,5 км · 31 стр. · 11 заданий',
    );
    expect(factsLine(q({ tasks: null, steps: 3 }))).toBe('60 мин · 5 км · 3 стр.');
  });
  it('когда меняли — по календарным дням', () => {
    const now = new Date(2026, 9, 29, 15, 0).getTime();
    const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime() / 1000;
    expect(editedAgo(at(2026, 9, 29, 1), now)).toBe('сегодня');
    expect(editedAgo(at(2026, 9, 28, 23), now)).toBe('вчера');
    expect(editedAgo(at(2026, 9, 26), now)).toBe('3 дня назад');
    expect(editedAgo(at(2026, 9, 15), now)).toBe('2 недели назад');
    expect(editedAgo(at(2026, 4, 1), now)).toBe('6 месяцев назад');
  });
});

describe('сводка черновика для плитки', () => {
  it('сохранение несёт отпечаток, ошибки и число заданий', () => {
    const quest = newQuest({ title: 'Новый' });
    const body = questUpsert(quest).body;
    expect(body.dash).toEqual(questDash(quest));
    expect(body.dash.fp).toBe(draftFingerprint(quest));
    expect(body.dash.tasks).toBe(0);
  });
  it('отпечаток меняют то, что уходит в магазин, но не сложность, возраст и теги', () => {
    const quest = newQuest({ title: 'Новый', price: 500 });
    const fp = draftFingerprint(quest);
    expect(draftFingerprint({ ...quest, meta: { ...quest.meta, price: 700 } })).not.toBe(fp);
    expect(draftFingerprint({ ...quest, meta: { ...quest.meta, startCoords: '45.25, 19.86' } })).not.toBe(fp);
    expect(draftFingerprint({ ...quest, meta: { ...quest.meta, complexity: 'high', tags: ['юмор'] } })).toBe(fp);
    // Публикация сама меняет черновик (список версий, номер следующей версии,
    // отпечаток публикации) — это не правки.
    const published = {
      ...quest,
      versions: [{ n: 1, date: '29.10.2026', pages: 2, size: '0,1 МБ', live: true, attempts: 0 }],
      publishedFp: fp,
      lastSaved: 123,
    };
    expect(draftFingerprint(published)).toBe(fp);
  });
  it('загрузка оставляет отпечаток публикации строкой и не тащит старую сводку', () => {
    const quest = newQuest({ title: 'Новый' });
    const stored = { ...questUpsert({ ...quest, publishedFp: 'abc' }).body };
    const loaded = migrateQuest(stored, quest.id);
    expect(loaded?.publishedFp).toBe('abc');
    expect(loaded && 'dash' in loaded).toBe(false);
    expect(migrateQuest({ ...stored, publishedFp: 7 }, quest.id)?.publishedFp).toBeNull();
  });
  it('копия квеста не считается опубликованной', () => {
    const quest = { ...newQuest({ title: 'Новый' }), publishedFp: 'abc' };
    expect(duplicateQuest(quest, 'q-copy').publishedFp).toBeNull();
  });
});
