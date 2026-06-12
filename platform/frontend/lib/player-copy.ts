/**
 * RU player microcopy, classic tone — verbatim from design/player/quest-data.js
 * UI_COPY. Single source for the production player, the builder preview and
 * the constructor test player.
 */
import type { StepCopy } from '../app/player/PlayerComponents';

export const PLAYER_COPY: StepCopy = {
  start: 'начать квест',
  next: 'продолжить',
  onward: 'в путь',
  submit: 'Ответить',
  navigator: 'Навигатор',
  wrong1: 'Неверно. Попробуйте ещё раз.',
  hintTitle: 'Нужна подсказка?',
  hintBody: (cost: number) => `Обменяйте ${cost} монет на подсказку — она останется с вами до конца шага.`,
  hintYes: (cost: number) => `Потратить ${cost} монет`,
  hintNo: 'Попробую сам',
  noteHolder: 'Заметка для себя (необязательно)',
  giftToast: (n: number) => `+${n} монет`,
  finalBtn: 'Оценить квест',
  finalDone: 'Спасибо! Отзыв отправлен',
};
