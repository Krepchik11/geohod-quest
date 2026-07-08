/**
 * task_answer render contract — the "reachable submit under the keyboard" fix.
 * The submit must share the field's ROW inside a <form> (so the browser's native
 * scroll-into-view lifts both above the on-screen keyboard), the keyboard action
 * key must be labelled, and an empty/whitespace answer must dim+disable submit.
 * Regression guard for design/design_handoff_answer_input_submit (direction 1a).
 *
 * react-dom/server markup assertions (matches final-screen.test.ts) — no DOM env.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StepView, type DesignStep, type StepState } from '../../app/player/PlayerComponents';
import { PLAYER_COPY } from '../player-copy';

const step: DesignStep = { template: 'task_answer', text: 'Вопрос?', prompt: 'Введите ответ' };

function render(st: StepState): string {
  return renderToStaticMarkup(
    createElement(StepView, { step, copy: PLAYER_COPY, st, on: {} })
  );
}

describe('task_answer inline-submit', () => {
  it('wraps the field + submit in a single-row <form> (not a stacked div)', () => {
    const html = render({ answer: '' });
    expect(html).toContain('<form');
    expect(html).toContain('p-actions--field');
    // Icon submit on the field's row, accessible by label, not visible text.
    expect(html).toContain('class="p-submit"');
    expect(html).toContain('aria-label="Ответить"');
    expect(html).toContain('<svg'); // PArrow glyph
  });

  it('labels the keyboard action key and disables autocorrect on the answer field', () => {
    // HTML attribute names are case-insensitive (the parser lowercases them), so
    // match case-insensitively — React serializes these props as-is (camelCase).
    const html = render({ answer: '' }).toLowerCase();
    expect(html).toContain('enterkeyhint="send"');
    expect(html).toContain('autocapitalize="off"');
    expect(html).toContain('autocorrect="off"');
  });

  it('dims + disables submit on an empty or whitespace-only answer', () => {
    expect(render({ answer: '' })).toContain('disabled');
    expect(render({ answer: '   ' })).toContain('disabled');
  });

  it('enables submit once the answer has non-whitespace content', () => {
    const html = render({ answer: '1947' });
    expect(html).not.toContain('disabled');
    expect(html).toContain('value="1947"');
  });

  it('still surfaces the wrong-answer state above the field', () => {
    const html = render({ answer: 'x', wrong: true });
    expect(html).toContain('p-input--wrong');
    expect(html).toContain('Неверно');
  });
});

/**
 * The question must live ON THE PAGE, never only inside the input: a placeholder
 * vanishes the moment the player types, so a question stored there becomes
 * unreadable mid-answer. `prompt` renders as visible .p-prompt text and the
 * input placeholder is always the generic «Введите ответ».
 */
describe('task_answer question placement', () => {
  function renderStep(s: DesignStep): string {
    return renderToStaticMarkup(
      createElement(StepView, { step: s, copy: PLAYER_COPY, st: { answer: '' }, on: {} })
    );
  }

  it('renders the authored question as page text, not as the placeholder', () => {
    const html = renderStep({ template: 'task_answer', text: 'Осмотритесь.', prompt: 'Сколько колонн у собора?' });
    expect(html).toContain('p-prompt');
    expect(html).toContain('Сколько колонн у собора?');
    expect(html).toContain('placeholder="Введите ответ"');
    expect(html).not.toContain('placeholder="Сколько колонн у собора?"');
  });

  it('suppresses the legacy default prompt («Введите ответ») from page text', () => {
    const html = renderStep({ template: 'task_answer', text: 'Вопрос?', prompt: 'Введите ответ' });
    expect(html).not.toContain('p-prompt');
    expect(html).toContain('placeholder="Введите ответ"');
  });

  it('renders no question block when the prompt is empty', () => {
    const html = renderStep({ template: 'task_answer', text: 'Вопрос?', prompt: '' });
    expect(html).not.toContain('p-prompt');
  });
});
