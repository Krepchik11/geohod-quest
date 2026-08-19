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
  wrong1: 'Неверно. Попробуйте ещё раз.',
  hintTitle: 'Нужна подсказка?',
  hintBody: (cost: number) => `Обменяйте ${cost} монет на подсказку — она останется с вами до конца шага.`,
  hintYes: (cost: number) => `Потратить ${cost} монет`,
  hintNo: 'Попробую сам',
  hintRevealTitle: 'Подсказка',
  hintOk: 'Понятно',
  giftToast: (n: number) => `+${n} монет`,
  spendToast: (n: number) => `−${n} монет`,
  // Финал (§11): «ОТПРАВИТЬ ОЦЕНКУ» активна при звёздах + отзыве; выход без
  // отзыва тоже отправляет выбранные звёзды (и платит их бонус).
  final: 'ПОЗДРАВЛЯЕМ ВЫ ПРОШЛИ КВЕСТ',
  submitRating: 'ОТПРАВИТЬ ОЦЕНКУ',
  skipRating: 'Пропустить оценку',
  skipRated: 'Отправить без отзыва',
  rateLead: 'Оцените квест, оставьте отзыв и получите дополнительные коины',
  rateThanks: 'Спасибо за оценку — отправим автору',
  // Пост-финальный каталог «Продолжите путешествие».
};
