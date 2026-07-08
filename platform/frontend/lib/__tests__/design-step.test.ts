/**
 * GameStep → DesignStep mapper: ONE path for every quest (the hardcoded demo
 * array is gone). Verified against both seeded goldens so the player renders
 * all 7 designed templates from real snapshot data, including video blocks.
 */
import { describe, expect, it } from 'vitest';
import { toDesignStep } from '../design-step';
import { getSnapshot } from '../goldens';

describe('toDesignStep over golden-ironia-sudby-v1 (all 7 templates)', () => {
  const steps = getSnapshot('ironia-sudby').steps.map(toDesignStep);

  it('covers every designed template in order', () => {
    expect(steps.map((s) => s.template)).toEqual([
      'start', 'video', 'continue', 'task_no', 'task_answer', 'route_video', 'continue', 'congrats',
    ]);
  });

  it('maps the start screen (kicker, title, subtitle, cover image)', () => {
    expect(steps[0]).toMatchObject({
      kicker: 'Городской квест',
      title: 'Ирония судьбы',
      text: 'по следам исторических личностей',
      image: '/assets/img/quest-card.png',
    });
  });

  it('maps inline video blocks with duration label and caption', () => {
    expect(steps[1].video).toEqual({ dur: '0:48', label: 'видео-приветствие автора' });
    expect(steps[5].video).toEqual({ dur: '0:31', label: 'видео маршрута до парка' });
    expect(steps[5].nav).toMatchObject({ lat: 45.2552, lng: 19.8489 });
  });

  it('maps the physical task (place, action, navigator, gift); the retired note flag is ignored', () => {
    expect(steps[3]).toMatchObject({
      place: 'ул. Николаевска порта 2 · 400 м отсюда',
      action: {
        desc: 'Найдите кованую ограду у входа и прикоснитесь к холодному металлу — так здоровались с церковью сто лет назад.',
        confirmLabel: 'Я на месте, нашёл',
      },
      nav: { lat: 45.2551, lng: 19.8451, label: 'Николаевская церковь' },
      gift: { coins: 3, narrative_text: 'За смелость и точность' },
    });
    // Frozen snapshots still carry completion.allow_note — the mapper drops it.
    expect('allowNote' in (steps[3] as unknown as Record<string, unknown>)).toBe(false);
  });

  it('maps the answer task (prompt, acceptable, hint cost/text/image, gift)', () => {
    expect(steps[4]).toMatchObject({
      prompt: 'Введите год',
      acceptable: ['1730'],
      hint: { cost: 5, text: 'Цифры выбиты в каменной арке над дверью — две первые уже видны с дорожки.', image: null },
      gift: { coins: 5, narrative_text: 'Острый глаз!' },
    });
  });

  it('maps the terminal congrats', () => {
    expect(steps[7]).toMatchObject({ template: 'congrats', title: 'Квест пройден!' });
  });
});

describe('toDesignStep over golden-mystery-fortress-v1 (legacy 4-step golden)', () => {
  const steps = getSnapshot('mystery-fortress-v1').steps.map(toDesignStep);

  it('keeps templates and answer machinery intact', () => {
    expect(steps[0].template).toBe('start');
    const answers = steps.filter((s) => s.template === 'task_answer');
    expect(answers.length).toBe(2);
    for (const a of answers) expect((a.acceptable || []).length).toBeGreaterThan(0);
  });
});
