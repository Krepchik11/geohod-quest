/**
 * RU player microcopy, classic tone — verbatim from design/player/quest-data.js
 * UI_COPY. Single source for the production player, the builder preview and
 * the constructor test player.
 */
import type { StepCopy } from '../app/player/PlayerComponents';
import { pluralCount } from './ru';

/** « за 1 монету / 2 монеты / 5 монет» — цена после «за»; при 0 цены нет. */
const forCoins = (n: number): string => (n ? ` за ${pluralCount(n, 'монету', 'монеты', 'монет')}` : '');

export const PLAYER_COPY: StepCopy = {
  start: 'начать квест',
  next: 'продолжить',
  onward: 'в путь',
  submit: 'Ответить',
  solvedSubmit: 'Дальше',
  wrong1: 'Неверно. Попробуйте ещё раз.',
  // Попап неверного ответа: заголовок уже говорит «неверный», поэтому тело
  // начинается с «Попробуйте ещё раз…», а не повторяет инлайн-строку.
  wrongTitle: 'Ответ неверный',
  wrongBody: (hintCost: number | null, skipCost: number) =>
    hintCost === null
      ? `Попробуйте ещё раз или пропустите задание${forCoins(skipCost)}.`
      : `Попробуйте ещё раз, возьмите подсказку${forCoins(hintCost)} или пропустите задание${forCoins(skipCost)}.`,
  skipYes: (skipCost: number) =>
    skipCost ? `Пропустить задание — ${pluralCount(skipCost, 'монета', 'монеты', 'монет')}` : 'Пропустить задание',
  // «Подсказка −5 монет»: минус — типографский (U+2212), как в тосте списания.
  hintYes: (cost: number) => (cost ? `Подсказка −${pluralCount(cost, 'монета', 'монеты', 'монет')}` : 'Подсказка'),
  hintNo: 'Решу сам',
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
};
