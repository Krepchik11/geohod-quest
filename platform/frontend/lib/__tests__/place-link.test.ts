/**
 * The address line IS the map affordance: a step with coordinates renders its
 * place line as a button that opens system maps, and the old separate
 * «навигатор» ghost button no longer exists on any template. A place without
 * coordinates stays a plain (non-interactive) line.
 *
 * react-dom/server markup assertions (matches answer-input.test.ts) — no DOM env.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PREVIEW_HANDLERS, StepView, type DesignStep } from '../../app/player/PlayerComponents';
import { PLAYER_COPY } from '../player-copy';
import { mapsSearchUrl } from '../maps';

const nav = { lat: 45.2551, lng: 19.8451, label: 'Церковь' };

function render(step: DesignStep): string {
  return renderToStaticMarkup(createElement(StepView, { step, copy: PLAYER_COPY, st: {}, on: PREVIEW_HANDLERS }));
}

describe('clickable address line (replaces the navigator button)', () => {
  it('task_no: address with coordinates renders as a button, labelled for maps', () => {
    const html = render({ template: 'task_no', text: 'Дойдите.', place: 'ул. Николаевска порта 2 · 400 м', nav });
    expect(html).toContain('p-place--link');
    expect(html).toContain('<button class="p-place p-place--link"');
    expect(html).toContain('Открыть в картах: ул. Николаевска порта 2 · 400 м');
  });

  it('task_no: address without coordinates stays a plain line', () => {
    const html = render({ template: 'task_no', text: 'Дойдите.', place: 'пл. Свободы 1' });
    expect(html).toContain('p-place');
    expect(html).not.toContain('p-place--link');
  });

  it('task_answer renders the address line too', () => {
    const html = render({ template: 'task_answer', text: 'Вопрос.', place: 'пл. Свободы 1', nav });
    expect(html).toContain('p-place--link');
  });

  it('video/route_video render the address line instead of a navigator button', () => {
    for (const template of ['video', 'route_video']) {
      const html = render({ template, text: 'Смотрите.', place: 'Парк · 650 м', nav, video: { dur: '0:31' } });
      expect(html).toContain('p-place--link');
      expect(html).not.toContain('авигатор');
    }
  });

  it('no template renders the old navigator ghost button', () => {
    for (const template of ['task_no', 'task_answer', 'video', 'route_video']) {
      const html = render({ template, text: 't', place: 'x', nav, video: { dur: '0:01' } });
      expect(html).not.toContain('авигатор');
    }
  });

  it('a step without a place renders no address line at all', () => {
    const html = render({ template: 'task_no', text: 'Дойдите.', nav });
    expect(html).not.toContain('p-place');
  });
});

describe('mapsSearchUrl', () => {
  it('builds the system-maps search link from coordinates', () => {
    expect(mapsSearchUrl(45.2551, 19.8451)).toBe(
      'https://www.google.com/maps/search/?api=1&query=45.2551,19.8451',
    );
  });
});
