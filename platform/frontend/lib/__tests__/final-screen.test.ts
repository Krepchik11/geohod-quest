/**
 * FinalScreen («ПОЗДРАВЛЯЕМ ВЫ ПРОШЛИ КВЕСТ») render contract (§11):
 * - «ОТПРАВИТЬ ОЦЕНКУ» is the one forward CTA and unlocks only when BOTH the
 *   stars and a review text are in;
 * - «Пропустить оценку» is a real button and stays as the exit while the
 *   submit is locked;
 * - there is no replay affordance on the finale.
 *
 * Rendered with react-dom/server (no DOM env needed) — markup assertions only.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  FinalScreen,
  PREVIEW_HANDLERS,
  type StepHandlers,
  type StepState,
} from '../../app/player/PlayerComponents';
import { PLAYER_COPY } from '../player-copy';

function render(st: StepState, on: StepHandlers = PREVIEW_HANDLERS): string {
  return renderToStaticMarkup(createElement(FinalScreen, { copy: PLAYER_COPY, st, on }));
}

describe('FinalScreen', () => {
  it('congratulates, invites the rating with the coins pitch, shows coins + time', () => {
    const html = render({ coinsEarned: 12, time: '1:24' });
    expect(html).toContain('ПОЗДРАВЛЯЕМ ВЫ ПРОШЛИ КВЕСТ');
    expect(html).toContain('Оцените квест, оставьте отзыв и получите дополнительные коины');
    expect(html).toContain('12');
    expect(html).toContain('1:24');
    expect(html).toContain('монет собрано');
    expect(html).toContain('в пути');
  });

  it('«ОТПРАВИТЬ ОЦЕНКУ» unlocks only when stars AND a comment are in', () => {
    expect(render({ coinsEarned: 5 })).toMatch(/ОТПРАВИТЬ ОЦЕНКУ[^>]*/);
    expect(render({ coinsEarned: 5 })).toContain('disabled');
    expect(render({ coinsEarned: 5, rating: 5 })).toContain('disabled');
    expect(render({ coinsEarned: 5, rating: 5, reviewText: '   ' })).toContain('disabled');
    expect(render({ coinsEarned: 5, rating: 5, reviewText: 'Отлично!' })).not.toContain('disabled');
  });

  it('«Пропустить оценку» is a BUTTON and stays while the submit is locked', () => {
    const locked = render({ coinsEarned: 5, rating: 5 });
    expect(locked).toMatch(/<button[^>]*>Пропустить оценку<\/button>/);
    const unlocked = render({ coinsEarned: 5, rating: 5, reviewText: 'Отлично!' });
    expect(unlocked).not.toContain('Пропустить оценку');
  });

  it('never renders a replay affordance', () => {
    expect(render({ coinsEarned: 5 })).not.toContain('пройти заново');
  });
});
