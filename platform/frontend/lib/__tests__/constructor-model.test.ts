/**
 * Конструктор v2 (workspace) model tests — template presets, publish gates,
 * draft → GameStep serialization (the production render path), structural
 * edits (insert/reorder/duplicate/remove), and workspace persistence.
 * Mirrors design/ctor2/store.jsx semantics, hardened per repo constraints.
 */
import { describe, expect, it } from 'vitest';
import {
  CTOR_TEMPLATES,
  GIFT_COINS,
  computeGates,
  duplicateStep,
  insertionIndex,
  migrateQuest,
  newQuest,
  newStep,
  nextVersionNumber,
  parseCoords,
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

  it('prefills task_answer with an always-on hint slot and answer prompt (SPEC presets)', () => {
    const s = newStep('task_answer');
    expect(s.prompt).toBe('Введите ответ');
    expect(s.gift).toEqual({ narrative: '' });
    // The hint has no toggle: it exists as soon as the author adds text or an image.
    expect(s.hint).toEqual({ cost: 5, text: '', image: null });
  });

  it('every new step has a single empty image slot', () => {
    expect(newStep('task_no').image).toBeNull();
    expect(newStep('continue').image).toBeNull();
  });

  it('prefills task_no with navigator on', () => {
    const s = newStep('task_no');
    expect(s.nav.on).toBe(true);
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
    task.image = null;
    task.nav = { on: true, coords: '' };
    q.steps = [q.steps[0], task, q.steps[1]];
    const errs = computeGates(q).errors;
    const fieldOf = (frag: string) => errs.find((e) => e.text.includes(frag))?.field;
    expect(fieldOf('нет изображения')).toBe('image');
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

  it('requires task image and answers; ties errors to the page id', () => {
    const q = quest();
    const task = newStep('task_answer');
    q.steps = [q.steps[0], task, q.steps[1]];
    const g = computeGates(q);
    expect(g.perPage[task.id]?.some((m) => m.text.includes('нет изображения'))).toBe(true);
    expect(g.perPage[task.id]?.some((m) => m.text.includes('список ответов пуст'))).toBe(true);
  });

  it('accepts whitespace-only answers as empty', () => {
    const q = quest();
    const task = newStep('task_answer');
    task.image = '/img.jpg';
    task.acceptable = ['  ', ''];
    q.steps = [q.steps[0], task, q.steps[1]];
    expect(computeGates(q).errors.some((e) => e.text.includes('список ответов пуст'))).toBe(true);
  });

  it('errors on navigator without parseable coordinates', () => {
    const q = quest();
    const s = newStep('task_no');
    s.image = '/img.jpg';
    s.nav = { on: true, coords: 'abc, 19.84' };
    q.steps = [q.steps[0], s, q.steps[1]];
    expect(computeGates(q).errors.some((e) => e.text.includes('координаты'))).toBe(true);
  });

  it('warns (not errors) on an answer task without any hint content', () => {
    const q = quest();
    const s = newStep('task_answer');
    s.image = '/img.jpg';
    s.acceptable = ['1730'];
    s.hint = { cost: 5, text: '', image: null };
    q.steps = [q.steps[0], s, q.steps[1]];
    const g = computeGates(q);
    expect(g.errors).toEqual([]);
    expect(g.warnings.some((w) => w.text.includes('подсказк'))).toBe(true);
  });

  it('an image-only hint satisfies the hint gate', () => {
    const q = quest();
    const s = newStep('task_answer');
    s.image = '/img.jpg';
    s.acceptable = ['1730'];
    s.hint = { cost: 5, text: '', image: '/hint.jpg' };
    q.steps = [q.steps[0], s, q.steps[1]];
    expect(computeGates(q).warnings.some((w) => w.text.includes('подсказк'))).toBe(false);
  });

  it('counts the hint image into the bundle size estimate', () => {
    const q = quest();
    const s = newStep('task_answer');
    s.image = '/img.jpg';
    s.acceptable = ['1730'];
    s.hint = { cost: 5, text: '', image: '/hint.jpg' };
    q.steps = [q.steps[0], s, q.steps[1]];
    const withHintImage = computeGates(q).imgs;
    s.hint = { cost: 5, text: 'текст', image: null };
    expect(withHintImage).toBe(computeGates(q).imgs + 1);
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

  it('task_answer: trims and drops blank answers; hint emitted when it has text', () => {
    const s = newStep('task_answer');
    s.acceptable = [' 1730 ', '', 'в 1730'];
    s.hint = { cost: 7, text: 'смотрите выше', image: null };
    const g = stepToGameStep(s, newQuest({}).meta);
    expect(g.completion.acceptable).toEqual(['1730', 'в 1730']);
    expect(g.supporting?.hint).toEqual({ cost_coins: 7, reveal_text: 'смотрите выше' });
    // the serialized list satisfies the shared matcher exactly
    expect(isAnswerCorrect('  В 1730 ', g.completion.acceptable || [])).toBe(true);
  });

  it('task_answer: a content-less hint is not emitted (no empty paid hints)', () => {
    const s = newStep('task_answer');
    s.acceptable = ['1730'];
    const g = stepToGameStep(s, newQuest({}).meta);
    expect(g.supporting?.hint).toBeUndefined();
    expect(g.media.hint).toBeNull();
  });

  it('task_answer: the hint image rides the media.hint role (image-only hint allowed)', () => {
    const s = newStep('task_answer');
    s.acceptable = ['1730'];
    s.hint = { cost: 5, text: '', image: '/hint.jpg' };
    const g = stepToGameStep(s, newQuest({}).meta);
    expect(g.supporting?.hint).toEqual({ cost_coins: 5, reveal_text: '' });
    expect(g.media.hint).toBe('/hint.jpg');
    const d = toDesignStep(g);
    expect(d.hint).toEqual({ cost: 5, text: '', image: '/hint.jpg' });
  });

  it('task steps always carry the fixed 5-coin gift', () => {
    for (const tpl of ['task_no', 'task_answer'] as const) {
      const s = newStep(tpl);
      s.gift = { narrative: 'Острый глаз!' };
      const g = stepToGameStep(s, newQuest({}).meta);
      expect(g.supporting?.gift).toEqual({ coins: GIFT_COINS, narrative_text: 'Острый глаз!' });
    }
    expect(GIFT_COINS).toBe(5);
  });

  it('non-task steps carry no gift', () => {
    for (const tpl of ['start', 'video', 'continue', 'route_video', 'congrats'] as const) {
      expect(stepToGameStep(newStep(tpl), newQuest({}).meta).supporting?.gift).toBeUndefined();
    }
  });

  it('the single step image maps to the primary media slot; legacy roles stay empty', () => {
    const s = newStep('task_no');
    s.image = '/img.jpg';
    const g = stepToGameStep(s, newQuest({}).meta);
    expect(g.media.task).toBe('/img.jpg');
    expect(g.media.character).toBeNull();
    expect(g.media.hint).toBeNull();
    expect(g.media.atmosphere).toBeNull();
    expect(toDesignStep(g).image).toBe('/img.jpg');
  });

  it('task_no: physical action, place and navigator survive the mapping', () => {
    const s = newStep('task_no');
    s.text = 'Дойдите до церкви';
    s.place = 'ул. Николаевска порта 2';
    s.action = { desc: 'Прикоснитесь к ограде', confirmLabel: 'Я на месте, нашёл' };
    s.nav = { on: true, coords: '45.2551, 19.8451' };
    const g = stepToGameStep(s, newQuest({}).meta);
    // The note feature is gone: physical completion carries the mode only.
    expect(g.completion).toEqual({ mode: 'physical' });
    const d = toDesignStep(g);
    expect(d.place).toBe('ул. Николаевска порта 2');
    expect(d.action?.confirmLabel).toBe('Я на месте, нашёл');
    // the content-block address doubles as the navigator point label
    expect(d.nav).toEqual({ lat: 45.2551, lng: 19.8451, label: 'ул. Николаевска порта 2' });
  });

  it('task_answer: the address lives in content and flows to place_text', () => {
    const s = newStep('task_answer');
    s.place = 'пл. Свободы 1';
    const d = toDesignStep(stepToGameStep(s, newQuest({}).meta));
    expect(d.place).toBe('пл. Свободы 1');
  });

  it('video: duration and caption flow into the design video block', () => {
    const s = newStep('video');
    s.video = { dur: '0:48', label: 'видео-приветствие' };
    const d = toDesignStep(stepToGameStep(s, newQuest({}).meta));
    expect(d.video).toEqual({ dur: '0:48', label: 'видео-приветствие' });
  });

  it('navigator with unparsable coords is dropped from the snapshot (gates block publish anyway)', () => {
    const s = newStep('task_no');
    s.nav = { on: true, coords: '' };
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
    src.action = { ...src.action, desc: 'исходное' };
    const { steps, newId } = duplicateStep(q.steps, src.id);
    expect(steps).toHaveLength(3);
    expect(steps[1].id).toBe(newId);
    expect(steps[1].name).toBe(src.name + ' (копия)');
    steps[1].action.desc = 'изменённое';
    expect(src.action.desc).toBe('исходное');
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

describe('parseCoords', () => {
  it('parses the Google Maps copy format «lat, lng»', () => {
    expect(parseCoords('45.2651377918879, 19.865664144668212')).toEqual({
      lat: 45.2651377918879,
      lng: 19.865664144668212,
    });
  });

  it('tolerates missing space, extra whitespace and negative values', () => {
    expect(parseCoords('45.26,-19.86')).toEqual({ lat: 45.26, lng: -19.86 });
    expect(parseCoords('  -45.26 ,  19.86  ')).toEqual({ lat: -45.26, lng: 19.86 });
  });

  it('rejects junk, partial input and out-of-range values', () => {
    expect(parseCoords('')).toBeNull();
    expect(parseCoords('45.26')).toBeNull();
    expect(parseCoords('abc, 19.86')).toBeNull();
    expect(parseCoords('91, 19.86')).toBeNull();
    expect(parseCoords('45.26, 181')).toBeNull();
    expect(parseCoords('45.26, 19.86, 7')).toBeNull();
  });
});

describe('migrateQuest (legacy draft bodies)', () => {
  const legacyBody = () => {
    const q = quest({ id: 'q-old' });
    const task = {
      ...newStep('task_answer'),
      images: { task: '/t.jpg', character: '/c.jpg', hint: null, atmosphere: '/a.jpg' },
      gift: { on: true, coins: 12, narrative: 'молодец' },
      hint: { on: true, cost: 5, text: 'ищите выше' },
      nav: { on: true, lat: '45.2551', lng: '19.8451', label: 'Церковь' },
      allowNote: true,
      place: '',
    } as unknown as CtorQuest['steps'][number];
    delete (task as unknown as { image?: unknown }).image;
    q.steps = [q.steps[0], task, q.steps[1]];
    return JSON.parse(JSON.stringify(q)) as unknown;
  };

  it('returns null for a non-quest body', () => {
    expect(migrateQuest(null, 'q-1')).toBeNull();
    expect(migrateQuest({ meta: {} }, 'q-1')).toBeNull();
  });

  it('forces the server id onto the body', () => {
    const q = migrateQuest(legacyBody(), 'q-server');
    expect(q?.id).toBe('q-server');
  });

  it('collapses the legacy role images to the single image (task first)', () => {
    const q = migrateQuest(legacyBody(), 'q-old')!;
    expect(q.steps[1].image).toBe('/t.jpg');
    expect((q.steps[1] as unknown as { images?: unknown }).images).toBeUndefined();
  });

  it('normalizes gift to narrative-only and nav to a single coords field', () => {
    const q = migrateQuest(legacyBody(), 'q-old')!;
    expect(q.steps[1].gift).toEqual({ narrative: 'молодец' });
    expect(q.steps[1].nav).toEqual({ on: true, coords: '45.2551, 19.8451' });
  });

  it('moves the legacy navigator label into the empty content address', () => {
    const q = migrateQuest(legacyBody(), 'q-old')!;
    expect(q.steps[1].place).toBe('Церковь');
  });

  it('keeps an existing address over the legacy navigator label', () => {
    const body = legacyBody() as { steps: Array<{ place: string }> };
    body.steps[1].place = 'пл. Свободы 1';
    const q = migrateQuest(body, 'q-old')!;
    expect(q.steps[1].place).toBe('пл. Свободы 1');
  });

  it('drops the legacy hint toggle, keeping cost and text; adds the image slot', () => {
    const q = migrateQuest(legacyBody(), 'q-old')!;
    expect(q.steps[1].hint).toEqual({ cost: 5, text: 'ищите выше', image: null });
  });

  it('preserves hint text even when the legacy toggle was off (no data loss)', () => {
    const body = legacyBody() as { steps: Array<{ hint: unknown }> };
    body.steps[1].hint = { on: false, cost: 3, text: 'черновик подсказки' };
    const q = migrateQuest(body, 'q-old')!;
    expect(q.steps[1].hint).toEqual({ cost: 3, text: 'черновик подсказки', image: null });
  });

  it('strips the legacy allowNote flag', () => {
    const q = migrateQuest(legacyBody(), 'q-old')!;
    expect('allowNote' in (q.steps[1] as unknown as Record<string, unknown>)).toBe(false);
  });

  it('is idempotent on a current-shape quest', () => {
    const current = quest({ id: 'q-new' });
    current.steps[0].image = '/cover.jpg';
    const once = migrateQuest(JSON.parse(JSON.stringify(current)), 'q-new')!;
    const twice = migrateQuest(JSON.parse(JSON.stringify(once)), 'q-new')!;
    expect(twice).toEqual(once);
    expect(once.steps[0].image).toBe('/cover.jpg');
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
