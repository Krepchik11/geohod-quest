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
    const submit = /<button[^>]*disabled[^>]*>ОТПРАВИТЬ ОЦЕНКУ/;
    expect(render({ coinsEarned: 5 })).toMatch(submit);
    expect(render({ coinsEarned: 5, rating: 5 })).toMatch(submit);
    expect(render({ coinsEarned: 5, rating: 5, reviewText: '   ' })).toMatch(submit);
    expect(render({ coinsEarned: 5, rating: 5, reviewText: 'Отлично!' })).not.toMatch(submit);
  });

  it('the exit is a BUTTON, honest about what it sends, gone once submit unlocks', () => {
    expect(render({ coinsEarned: 5 })).toMatch(/<button[^>]*>Пропустить оценку<\/button>/);
    // Stars tapped: the exit still commits them, so its label says so.
    expect(render({ coinsEarned: 5, rating: 5 })).toMatch(/<button[^>]*>Отправить без отзыва<\/button>/);
    const unlocked = render({ coinsEarned: 5, rating: 5, reviewText: 'Отлично!' });
    expect(unlocked).not.toContain('Пропустить оценку');
    expect(unlocked).not.toContain('Отправить без отзыва');
  });

  it('never renders a replay affordance', () => {
    expect(render({ coinsEarned: 5 })).not.toContain('пройти заново');
  });

  /* §share: the finale's share button is handler-driven, like `back`. The
     constructor test-player and the editor previews pass PREVIEW_HANDLERS,
     which deliberately omits it, so only the real player shows it. */
  describe('«Поделиться квестом»', () => {
    const share = () => {};

    it('is absent for previews and the constructor test-player', () => {
      expect(render({ coinsEarned: 5 })).not.toContain('Поделиться квестом');
      expect(PREVIEW_HANDLERS).not.toHaveProperty('share');
    });

    it('appears for the real player, which passes the handler', () => {
      const html = render({ coinsEarned: 5 }, { ...PREVIEW_HANDLERS, share });
      expect(html).toMatch(/<button[^>]*>Поделиться квестом<\/button>/);
    });

    it('stays put once the rating submit unlocks — it is not an exit', () => {
      const html = render(
        { coinsEarned: 5, rating: 5, reviewText: 'Отлично!' },
        { ...PREVIEW_HANDLERS, share },
      );
      // The «skip» exit is gone at this point; sharing is not an exit, so it stays.
      expect(html).not.toContain('Отправить без отзыва');
      expect(html).toContain('Поделиться квестом');
    });

    it('stands alongside the two commit-and-leave buttons, not instead of them', () => {
      const html = render({ coinsEarned: 5 }, { ...PREVIEW_HANDLERS, share });
      expect(html).toContain('ОТПРАВИТЬ ОЦЕНКУ');
      expect(html).toContain('Пропустить оценку');
      expect(html).toMatch(/<button[^>]*>Поделиться квестом<\/button>/);
    });
  });
});
