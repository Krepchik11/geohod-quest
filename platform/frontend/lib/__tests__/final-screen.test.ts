/**
 * FinalScreen («Квест пройден!») render contract. The finale must, on every
 * surface, expose a forward CTA and show coins + time; in the real player it
 * additionally offers «пройти заново» (gated on a wired `replay` handler so the
 * constructor test-player / editor previews — which pass none — stay clean).
 *
 * Rendered with react-dom/server (no DOM env needed) — markup assertions only;
 * the replay handler's data behaviour is covered by the queue/restart tests.
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

/** A fully-wired finale; individual tests override to probe a missing handler. */
function render(st: StepState, on: StepHandlers = PREVIEW_HANDLERS): string {
  return renderToStaticMarkup(createElement(FinalScreen, { copy: PLAYER_COPY, st, on }));
}

describe('FinalScreen', () => {
  it('always exposes the forward «что дальше» CTA and the coins + time stats', () => {
    const html = render({ coinsEarned: 12, time: '1:24' });
    expect(html).toContain('что дальше');
    expect(html).toContain('12');
    expect(html).toContain('1:24');
    expect(html).toContain('монет собрано');
    expect(html).toContain('в пути');
  });

  it('renders «пройти заново» only when a replay handler is wired', () => {
    expect(render({ coinsEarned: 5 }, { ...PREVIEW_HANDLERS, replay: () => {} })).toContain('пройти заново');
    // Editor previews / constructor test-player pass no replay handler — no dead button.
    expect(render({ coinsEarned: 5 })).not.toContain('пройти заново');
  });

  it('offers «Пропустить оценку» only while unrated', () => {
    expect(render({ coinsEarned: 5 })).toContain('Пропустить оценку');
    const rated = render({ coinsEarned: 5, rating: 5 });
    expect(rated).not.toContain('Пропустить оценку');
    expect(rated).toContain('Спасибо за оценку');
  });
});
