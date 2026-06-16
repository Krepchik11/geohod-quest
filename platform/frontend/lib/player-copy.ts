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
  // Финал «Квест пройден!» — оценка необязательна и не блокирует «что дальше».
  final: 'Квест пройден!',
  whatNext: 'что дальше',
  skipRating: 'Пропустить оценку',
  rateLead: 'Понравился квест? Оцените — это поможет автору. Можно пропустить.',
  rateThanks: 'Спасибо за оценку — отправим автору',
  // Пост-финальный каталог «Продолжите путешествие».
  catalogKicker: 'маршрут окончен',
  catalogTitle: 'Продолжите путешествие',
  catalogLead: 'Рядом — ещё истории этого города. Монеты переходят в ваш баланс.',
  catalogShare: 'поделиться результатом',
  catalogHome: 'На главную',
  catalogEmpty: 'Скоро здесь появятся новые истории.',
  shareCopied: 'Ссылка скопирована',
};
