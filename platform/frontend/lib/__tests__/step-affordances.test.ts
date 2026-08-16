/**
 * StepView affordance contract (stated in full on `StepHandlers`): a rendered
 * control ALWAYS has a working handler, so a missing handler hides its control and
 * a deliberately inert surface opts in via `PREVIEW_HANDLERS`.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_HANDLERS,
  StepView,
  type DesignStep,
  type StepHandlers,
} from '../../app/player/PlayerComponents';
import { PLAYER_COPY } from '../player-copy';

const render = (step: DesignStep, on: StepHandlers): string =>
  renderToStaticMarkup(createElement(StepView, { step, copy: PLAYER_COPY, st: {}, on }));

const ANSWER_STEP: DesignStep = {
  template: 'task_answer',
  text: 'Вопрос?',
  hint: { cost: 5, text: 'подсказка', image: null },
  acceptable: ['1730'],
};

const CONTROLS: Array<{ name: string; step: DesignStep; handler: keyof StepHandlers; marker: string }> = [
  { name: 'start CTA', step: { template: 'start', text: 'Поехали' }, handler: 'next', marker: 'начать квест' },
  { name: 'continue CTA', step: { template: 'continue', text: 'Дальше' }, handler: 'next', marker: 'продолжить' },
  {
    name: 'video CTA',
    step: { template: 'video', text: 'Смотрите', video: { dur: '0:30' } },
    handler: 'next',
    marker: 'продолжить',
  },
  {
    name: 'physical confirm',
    step: { template: 'task_no', text: 'Дойдите', action: { confirmLabel: 'Я на месте' } },
    handler: 'confirm',
    marker: 'Я на месте',
  },
  { name: 'hint chip', step: ANSWER_STEP, handler: 'buyHint', marker: 'p-hintchip' },
  { name: 'answer form', step: ANSWER_STEP, handler: 'submit', marker: 'p-submit' },
  {
    name: 'map affordance',
    step: { template: 'task_no', text: 'Дойдите', place: 'Арка', nav: { lat: 1, lng: 2 } },
    handler: 'navigator',
    marker: 'p-place--link',
  },
  {
    name: 'video play button',
    step: { template: 'video', text: 'Смотрите', video: { dur: '0:30' } },
    handler: 'play',
    marker: 'p-media__play',
  },
];

describe('StepView renders no control without a handler', () => {
  CONTROLS.forEach(({ name, step, handler, marker }) => {
    it(`${name}: hidden with no handler, shown when wired`, () => {
      expect(render(step, {})).not.toContain(marker);
      expect(render(step, { [handler]: () => {} })).toContain(marker);
    });
  });
});

describe('PREVIEW_HANDLERS', () => {
  it('keeps every control visible for the inert editor previews', () => {
    const html = render(ANSWER_STEP, PREVIEW_HANDLERS);
    expect(html).toContain('p-hintchip');
    expect(html).toContain('p-submit');
  });

  it('renders the finale complete (rating, «ОТПРАВИТЬ ОЦЕНКУ», skip button)', () => {
    const html = render({ template: 'congrats', title: 'Готово' }, PREVIEW_HANDLERS);
    expect(html).toContain('ОТПРАВИТЬ ОЦЕНКУ');
    expect(html).toContain('Пропустить оценку');
    expect(html).toContain('p-rate');
  });
});
