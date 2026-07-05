/**
 * Конструктор v2 (workspace) model tests — template presets, publish gates,
 * draft → GameStep serialization (the production render path), structural
 * edits (insert/reorder/duplicate/remove), and workspace persistence.
 * Mirrors design/ctor2/store.jsx semantics, hardened per repo constraints.
 */
import { describe, expect, it } from 'vitest';
import {
  CTOR_TEMPLATES,
  computeGates,
  duplicateStep,
  insertionIndex,
  newQuest,
  newStep,
  nextVersionNumber,
  plural,
  removeStep,
  reorderSteps,
  serializeDraft,
  stepToGameStep,
  type CtorQuest,
} from '../constructor-model';
import { toDesignStep } from '../design-step';
import { isAnswerCorrect } from '../shared-model';

const quest = (patch?: Partial<CtorQuest>): CtorQuest => ({ ...newQuest({ title: 'Тест' }), ...patch });

describe('templates and presets', () => {
  it('exposes exactly the 7 SPEC templates', () => {
    expect(CTOR_TEMPLATES.map((t) => t.key)).toEqual([
      'start', 'video', 'task_no', 'task_answer', 'continue', 'route_video', 'congrats',
    ]);
  });

  it('prefills task_answer with gift, hint and answer prompt (SPEC presets)', () => {
    const s = newStep('task_answer');
    expect(s.prompt).toBe('Введите ответ');
    expect(s.gift).toEqual({ on: true, coins: 5, narrative: '' });
    expect(s.hint).toEqual({ on: true, cost: 5, text: '' });
  });

  it('prefills task_no with navigator on and note allowed', () => {
    const s = newStep('task_no');
    expect(s.nav.on).toBe(true);
    expect(s.allowNote).toBe(true);
  });

  it('prefills route_video with navigator and a video block', () => {
    const s = newStep('route_video');
    expect(s.nav.on).toBe(true);
    expect(s.video).not.toBeNull();
  });

  it('gives every new step a unique id', () => {
    const ids = Array.from({ length: 50 }, () => newStep('continue').id);
    expect(new Set(ids).size).toBe(50);
  });
});

describe('newQuest', () => {
  it('starts with the two gate-mandated pages: start + congrats', () => {
    const q = newQuest({ title: 'X' });
    expect(q.steps.map((s) => s.template)).toEqual(['start', 'congrats']);
    expect(q.versions).toEqual([]);
  });

  it('defaults blank meta safely', () => {
    const q = newQuest({});
    expect(q.meta.title).toBe('Без названия');
    expect(q.meta.price).toBe(0);
  });
});

describe('computeGates', () => {
  it('passes a fresh quest except cover warning', () => {
    const g = computeGates(quest());
    expect(g.errors).toEqual([]);
    expect(g.warnings.map((w) => w.text)).toContain(
      'Нет обложки — карточка в магазине и «Первый экран» будут пустыми',
    );
  });

  it('errors when the first page is not «Первый экран»', () => {
    const q = quest();
    q.steps = [...q.steps].reverse();
    const texts = computeGates(q).errors.map((e) => e.text);
    expect(texts).toContain('Первая страница должна быть «Первый экран»');
  });

  it('tags page errors with the field to focus (§9.2 «Исправить →»)', () => {
    const q = quest();
    const task = newStep('task_answer');
    task.acceptable = [''];
    task.images.task = null;
    task.nav = { ...task.nav, on: true, lat: '', lng: '' };
    q.steps = [q.steps[0], task, q.steps[1]];
    const errs = computeGates(q).errors;
    const fieldOf = (frag: string) => errs.find((e) => e.text.includes(frag))?.field;
    expect(fieldOf('нет комикса')).toBe('comic');
    expect(fieldOf('список ответов пуст')).toBe('answers');
    expect(fieldOf('координаты не заданы')).toBe('nav');
  });

  it('errors when there is no terminal «Поздравление»', () => {
    const q = quest();
    q.steps = q.steps.filter((s) => s.template !== 'congrats');
    expect(computeGates(q).errors.map((e) => e.text)).toContain(
      'Нет терминальной страницы «Поздравление»',
    );
  });

  it('flags an extra «Первый экран» beyond position 0 per page', () => {
    const q = quest();
    q.steps = [q.steps[0], newStep('start'), q.steps[1]];
    const g = computeGates(q);
    const err = g.errors.find((e) => e.pageId === q.steps[1].id);
    expect(err?.text).toContain('может быть только первой страницей');
  });

  it('requires task comic and answers; ties errors to the page id', () => {
    const q = quest();
    const task = newStep('task_answer');
    q.steps = [q.steps[0], task, q.steps[1]];
    const g = computeGates(q);
    expect(g.perPage[task.id]?.some((m) => m.text.includes('нет комикса'))).toBe(true);
    expect(g.perPage[task.id]?.some((m) => m.text.includes('список ответов пуст'))).toBe(true);
  });

  it('accepts whitespace-only answers as empty', () => {
    const q = quest();
    const task = newStep('task_answer');
    task.images.task = '/img.jpg';
    task.acceptable = ['  ', ''];
    q.steps = [q.steps[0], task, q.steps[1]];
    expect(computeGates(q).errors.some((e) => e.text.includes('список ответов пуст'))).toBe(true);
  });

  it('errors on navigator without numeric coordinates', () => {
    const q = quest();
    const s = newStep('task_no');
    s.images.task = '/img.jpg';
    s.nav = { on: true, lat: 'abc', lng: '19.84', label: '' };
    q.steps = [q.steps[0], s, q.steps[1]];
    expect(computeGates(q).errors.some((e) => e.text.includes('координаты'))).toBe(true);
  });

  it('warns (not errors) on a paid hint without text', () => {
    const q = quest();
    const s = newStep('task_answer');
    s.images.task = '/img.jpg';
    s.acceptable = ['1730'];
    s.hint = { on: true, cost: 5, text: '' };
    q.steps = [q.steps[0], s, q.steps[1]];
    const g = computeGates(q);
    expect(g.errors).toEqual([]);
    expect(g.warnings.some((w) => w.text.includes('подсказка'))).toBe(true);
  });

  it('estimates data-URL images by their real base64 size', () => {
    const q = quest();
    // ~3 MB of base64 → ~2.25 MB of bytes
    q.meta.cover = 'data:image/jpeg;base64,' + 'A'.repeat(3 * 1024 * 1024);
    const g = computeGates(q);
    expect(g.sizeMb).toBeGreaterThan(2);
    expect(g.warnings.some((w) => w.text.includes('выше цели 5 МБ'))).toBe(false);
  });

  it('warns when the estimated bundle exceeds 5 MB', () => {
    const q = quest();
    q.meta.cover = 'data:image/jpeg;base64,' + 'A'.repeat(8 * 1024 * 1024);
    expect(computeGates(q).warnings.some((w) => w.text.includes('выше цели 5 МБ'))).toBe(true);
  });
});

describe('stepToGameStep → toDesignStep (production render path)', () => {
  it('start: quest meta is the single source for title/cover (design: «единый источник меты»)', () => {
    const q = quest();
    q.meta.cover = '/assets/img/quest-card.png';
    const s = q.steps[0];
    s.kicker = 'Городской квест';
    s.text = 'подзаголовок';
    const d = toDesignStep(stepToGameStep(s, q.meta));
    expect(d.title).toBe('Тест');
    expect(d.kicker).toBe('Городской квест');
    expect(d.text).toBe('подзаголовок');
    expect(d.image).toBe('/assets/img/quest-card.png');
  });

  it('task_answer: trims and drops blank answers; hint/gift only when enabled', () => {
    const s = newStep('task_answer');
    s.acceptable = [' 1730 ', '', 'в 1730'];
    s.hint = { on: true, cost: 7, text: 'смотрите выше' };
    s.gift = { on: false, coins: 5, narrative: '' };
    const g = stepToGameStep(s, newQuest({}).meta);
    expect(g.completion.acceptable).toEqual(['1730', 'в 1730']);
    expect(g.supporting?.hint).toEqual({ cost_coins: 7, reveal_text: 'смотрите выше' });
    expect(g.supporting?.gift).toBeUndefined();
    // the serialized list satisfies the shared matcher exactly
    expect(isAnswerCorrect('  В 1730 ', g.completion.acceptable || [])).toBe(true);
  });

  it('task_no: physical action, place, note and navigator survive the mapping', () => {
    const s = newStep('task_no');
    s.text = 'Дойдите до церкви';
    s.place = 'ул. Николаевска порта 2';
    s.action = { desc: 'Прикоснитесь к ограде', confirmLabel: 'Я на месте, нашёл' };
    s.nav = { on: true, lat: '45.2551', lng: '19.8451', label: 'Церковь' };
    const d = toDesignStep(stepToGameStep(s, newQuest({}).meta));
    expect(d.place).toBe('ул. Николаевска порта 2');
    expect(d.action?.confirmLabel).toBe('Я на месте, нашёл');
    expect(d.allowNote).toBe(true);
    expect(d.nav).toEqual({ lat: 45.2551, lng: 19.8451, label: 'Церковь' });
  });

  it('video: duration and caption flow into the design video block', () => {
    const s = newStep('video');
    s.video = { dur: '0:48', label: 'видео-приветствие' };
    const d = toDesignStep(stepToGameStep(s, newQuest({}).meta));
    expect(d.video).toEqual({ dur: '0:48', label: 'видео-приветствие' });
  });

  it('gift requires positive coins (zero-coin gift is dropped)', () => {
    const s = newStep('task_no');
    s.gift = { on: true, coins: 0, narrative: 'x' };
    expect(stepToGameStep(s, newQuest({}).meta).supporting?.gift).toBeUndefined();
  });

  it('navigator with unparsable coords is dropped from the snapshot (gates block publish anyway)', () => {
    const s = newStep('task_no');
    s.nav = { on: true, lat: '', lng: '', label: '' };
    expect(stepToGameStep(s, newQuest({}).meta).supporting?.navigator).toBeUndefined();
  });

  it('congrats: terminal flag and title fallback', () => {
    const s = newStep('congrats');
    s.title = '';
    const g = stepToGameStep(s, newQuest({}).meta);
    expect(g.supporting?.terminal).toBe(true);
    expect(g.rich_content.title).toBe('Квест пройден!');
  });
});

describe('serializeDraft', () => {
  it('produces a frozen snapshot with sequential positions and bumped version', () => {
    const q = quest({ id: 'q-x' });
    q.versions = [{ n: 2, date: '01.01.2026', pages: 2, size: '1 МБ', live: true, attempts: 0 }];
    const snap = serializeDraft(q);
    expect(snap.golden_id).toBe('q-x');
    expect(snap.snapshot_version).toBe(3);
    expect(snap.steps.map((s) => s.position)).toEqual([0, 1]);
  });

  it('deep-freezes: mutating the draft after serialize does not affect the snapshot', () => {
    const q = quest();
    const snap = serializeDraft(q);
    q.steps[0].text = 'mutated';
    expect(snap.steps[0].rich_content.main_text).not.toBe('mutated');
  });

  it('freezes the real store-card city/duration in (and omits blanks)', () => {
    // A fresh quest has blank city/duration → the snapshot carries neither, so the
    // player shows no fabricated place rather than a hardcoded default.
    const blank = serializeDraft(quest());
    expect(blank.city).toBeUndefined();
    expect(blank.duration).toBeUndefined();

    const q = quest();
    q.meta.city = 'Нови Сад';
    q.meta.duration = '1.5 часа';
    const snap = serializeDraft(q);
    expect(snap.city).toBe('Нови Сад');
    expect(snap.duration).toBe('1.5 часа');
  });
});

describe('structural edits', () => {
  it('insertionIndex places after the selected page', () => {
    const q = quest();
    expect(insertionIndex(q.steps, q.steps[0].id, 'continue')).toBe(1);
  });

  it('insertionIndex never inserts after the final congrats', () => {
    const q = quest();
    expect(insertionIndex(q.steps, q.steps[1].id, 'continue')).toBe(1);
    expect(insertionIndex(q.steps, null, 'continue')).toBe(1);
  });

  it('reorderSteps moves and is a no-op for invalid indices', () => {
    const q = quest();
    const moved = reorderSteps(q.steps, 0, 1);
    expect(moved.map((s) => s.template)).toEqual(['congrats', 'start']);
    expect(reorderSteps(q.steps, 0, 0)).toBe(q.steps);
    expect(reorderSteps(q.steps, -1, 1)).toBe(q.steps);
    expect(reorderSteps(q.steps, 0, 99)).toBe(q.steps);
  });

  it('duplicateStep deep-copies right after the source with a fresh id and «(копия)»', () => {
    const q = quest();
    const src = q.steps[0];
    src.images.task = '/img.jpg';
    const { steps, newId } = duplicateStep(q.steps, src.id);
    expect(steps).toHaveLength(3);
    expect(steps[1].id).toBe(newId);
    expect(steps[1].name).toBe(src.name + ' (копия)');
    steps[1].images.task = '/other.jpg';
    expect(src.images.task).toBe('/img.jpg');
  });

  it('removeStep selects the next page, then the previous, then null', () => {
    const q = quest();
    const [a, b] = q.steps;
    const r1 = removeStep(q.steps, a.id);
    expect(r1.steps).toHaveLength(1);
    expect(r1.nextSelectedId).toBe(b.id);
    const r2 = removeStep(r1.steps, b.id);
    expect(r2.steps).toHaveLength(0);
    expect(r2.nextSelectedId).toBeNull();
  });
});

describe('versions', () => {
  it('nextVersionNumber is max+1, starting from 1', () => {
    const q = quest();
    expect(nextVersionNumber(q)).toBe(1);
    q.versions = [
      { n: 3, date: '', pages: 2, size: '', live: false, attempts: 0 },
      { n: 1, date: '', pages: 2, size: '', live: true, attempts: 0 },
    ];
    expect(nextVersionNumber(q)).toBe(4);
  });
});

describe('plural', () => {
  it('declines RU forms', () => {
    expect(plural(1, 'страница', 'страницы', 'страниц')).toBe('страница');
    expect(plural(3, 'страница', 'страницы', 'страниц')).toBe('страницы');
    expect(plural(11, 'страница', 'страницы', 'страниц')).toBe('страниц');
    expect(plural(22, 'страница', 'страницы', 'страниц')).toBe('страницы');
  });
});
