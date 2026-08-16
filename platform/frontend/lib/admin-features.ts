/**
 * Pure view-model for the admin feature-toggles page (mirrors the
 * lib/admin-users.ts pattern: wire types + display derivations, no React).
 *
 * The flag registry lives in backend code (`backend/src/features.rs`); the
 * client renders whatever the list endpoint serves, so a newly registered
 * flag appears here without a frontend change — labels below are optional
 * polish keyed by the stable wire key, with the key itself as fallback.
 */

import type { AdminFeatureWire } from './generated';

export type { AdminFeatureWire };

/** A runtime setting hosted under a flag's row on the features page: the
 *  value half of a flag-gated feature (registry in backend settings.rs). */
export interface FeatureSetting {
  key: string;
  label: string;
  hint: string;
}

/** Wire row plus display strings resolved from the key. */
export interface AdminFeature extends AdminFeatureWire {
  label: string;
  description: string;
  /** Companion runtime setting rendered under this flag's row, if any. */
  setting?: FeatureSetting;
}

/**
 * The flag registry, in backend order — goldens/wire/features-registry.json
 * pins it against backend features.rs, so a missed registration breaks a test.
 */
export const FEATURE_KEYS = [
  'auth_google',
  'auth_telegram',
  'payments_mock',
  'payments_yookassa',
  'player_back_button',
  'player_universal_answer',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** Russian labels for the registry; a key typo here is a compile error. */
const META: Record<FeatureKey, { label: string; description: string; setting?: FeatureSetting }> = {
  auth_google: {
    label: 'Вход через Google',
    description: 'Кнопка «Войти через Google» на странице входа и привязка Google-аккаунта.',
  },
  auth_telegram: {
    label: 'Вход через Telegram',
    description: 'Кнопка входа через Telegram на странице входа и привязка Telegram-аккаунта.',
  },
  payments_mock: {
    label: 'Тестовая оплата',
    description:
      'Тестовый провайдер оплаты: мгновенно одобряет покупку без списания денег. Для разработки и проверок.',
  },
  payments_yookassa: {
    label: 'Оплата через ЮKassa',
    description: 'Реальные платежи через ЮKassa (переход на страницу оплаты).',
  },
  player_back_button: {
    label: 'Кнопка «назад» в квесте',
    description:
      'Системная кнопка «назад» (жест или кнопка на телефоне) листает шаги квеста на шаг назад, а не выходит из игры.',
  },
  player_universal_answer: {
    label: 'Универсальный ответ',
    description:
      'Ответ, который принимается на любом вопросе любого квеста. Действует, только когда включён переключатель И задано значение ниже.',
    setting: {
      key: 'universal_answer',
      label: 'Значение универсального ответа',
      hint: 'Пусто — ответ не действует, даже когда переключатель включён.',
    },
  },
};

export function toAdminFeature(w: AdminFeatureWire): AdminFeature {
  // The wire may serve a key newer than this build — fall back gracefully.
  const meta = (META as Partial<Record<string, (typeof META)[FeatureKey]>>)[w.key];
  return {
    ...w,
    label: meta?.label ?? w.key,
    description: meta?.description ?? '',
    setting: meta?.setting,
  };
}

/** «вкл/выкл» plus where the verdict comes from (default vs admin override). */
export function stateLabel(f: AdminFeature): string {
  const verdict = f.effective ? 'вкл' : 'выкл';
  return f.override === null ? `по умолчанию · ${verdict}` : `переопределено · ${verdict}`;
}

/** Warning when the switch is inert on this deployment; null when it acts. */
export function availabilityNote(f: AdminFeature): string | null {
  return f.available
    ? null
    : 'Не настроено на этом сервере — переключатель ничего не включит, пока не заданы учётные данные.';
}
