/**
 * Hint content render contract — a hint is text, an image, or both.
 * The purchased content opens as a popup (HintRevealPopup) and stays available
 * inline (.p-hintbox) for the rest of the step; the coin toast covers BOTH
 * directions (gain «+N», spend «−N» with the accent variant). The retired
 * note feature must not render on physical steps.
 *
 * react-dom/server markup assertions (matches answer-input.test.ts) — no DOM env.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CoinToast,
  HintPopup,
  HintRevealPopup,
  PREVIEW_HANDLERS,
  StepView,
  type DesignStep,
} from '../../app/player/PlayerComponents';
import { PLAYER_COPY } from '../player-copy';

describe('HintRevealPopup', () => {
  const render = (hint: { text?: string; image?: string | null }): string =>
    renderToStaticMarkup(createElement(HintRevealPopup, { hint, copy: PLAYER_COPY, on: {} }));

  it('renders a text-only hint', () => {
    const html = render({ text: 'Смотрите на арку' });
    expect(html).toContain('Подсказка');
    expect(html).toContain('Смотрите на арку');
    expect(html).not.toContain('<img');
    expect(html).toContain('Понятно');
  });

  it('renders an image-only hint', () => {
    const html = render({ text: '', image: '/hint.jpg' });
    expect(html).toContain('src="/hint.jpg"');
    expect(html).toContain('p-popup__img');
    expect(html).not.toContain('p-popup__text');
  });

  it('renders text and image together', () => {
    const html = render({ text: 'Смотрите на арку', image: '/hint.jpg' });
    expect(html).toContain('Смотрите на арку');
    expect(html).toContain('src="/hint.jpg"');
  });
});

describe('wrong-answer popup buttons', () => {
  const render = (hintCost: number, skipCost: number): string =>
    renderToStaticMarkup(
      createElement(HintPopup, {
        popup: { hint: 'offer' },
        hint: { cost: hintCost, text: 'текст' },
        skipCost,
        copy: PLAYER_COPY,
        on: {},
      })
    );

  it('«Подсказка −N монет» agrees with the number; a free hint carries no price', () => {
    expect(render(1, 10)).toContain('>Подсказка −1 монета<');
    expect(render(2, 10)).toContain('>Подсказка −2 монеты<');
    expect(render(5, 10)).toContain('>Подсказка −5 монет<');
    expect(render(0, 10)).toContain('>Подсказка<');
  });

  it('«Пропустить задание — N монет», no price when free; «Решу сам» closes', () => {
    expect(render(5, 10)).toContain('>Пропустить задание — 10 монет<');
    expect(render(5, 3)).toContain('>Пропустить задание — 3 монеты<');
    expect(render(5, 0)).toContain('>Пропустить задание<');
    expect(render(5, 10)).toContain('>Решу сам<');
  });
});

describe('inline hint box (persistent reveal)', () => {
  const render = (step: DesignStep, hintRevealed: boolean): string =>
    renderToStaticMarkup(
      createElement(StepView, { step, copy: PLAYER_COPY, st: { answer: '', hintRevealed }, on: PREVIEW_HANDLERS })
    );

  it('shows the hint image inside the revealed box', () => {
    const step: DesignStep = {
      template: 'task_answer',
      text: 'Вопрос?',
      hint: { cost: 5, text: 'текст подсказки', image: '/hint.jpg' },
    };
    const html = render(step, true);
    expect(html).toContain('p-hintbox');
    expect(html).toContain('текст подсказки');
    expect(html).toContain('p-hintbox__img');
    expect(html).toContain('src="/hint.jpg"');
  });

  it('keeps the text-only box image-free', () => {
    const step: DesignStep = {
      template: 'task_answer',
      text: 'Вопрос?',
      hint: { cost: 5, text: 'только текст', image: null },
    };
    const html = render(step, true);
    expect(html).toContain('только текст');
    expect(html).not.toContain('p-hintbox__img');
  });
});

describe('retired note feature', () => {
  it('task_no renders no note textarea', () => {
    const step: DesignStep = {
      template: 'task_no',
      text: 'Дойдите до места',
      action: { desc: '', confirmLabel: 'Я на месте' },
    };
    const html = renderToStaticMarkup(
      createElement(StepView, { step, copy: PLAYER_COPY, st: {}, on: PREVIEW_HANDLERS })
    );
    expect(html).not.toContain('p-note');
    expect(html).not.toContain('<textarea');
  });
});

describe('CoinToast directions', () => {
  it('renders a gain as «+N монет»', () => {
    const html = renderToStaticMarkup(createElement(CoinToast, { amount: 5, copy: PLAYER_COPY }));
    expect(html).toContain('+5 монет');
    expect(html).not.toContain('p-toast--spend');
  });

  it('sits at the top on request (the finale — its buttons fill the bottom), at the bottom otherwise', () => {
    const top = renderToStaticMarkup(createElement(CoinToast, { amount: 5, copy: PLAYER_COPY, top: true }));
    expect(top).toContain('p-toast--top');
    const bottom = renderToStaticMarkup(createElement(CoinToast, { amount: 5, copy: PLAYER_COPY }));
    expect(bottom).not.toContain('p-toast--top');
  });

  it('renders a spend as «−N монет» with the accent variant', () => {
    const html = renderToStaticMarkup(
      createElement(CoinToast, { amount: -5, narrative: 'подсказка', copy: PLAYER_COPY })
    );
    expect(html).toContain('−5 монет');
    expect(html).toContain('p-toast--spend');
    expect(html).toContain('подсказка');
  });
});
