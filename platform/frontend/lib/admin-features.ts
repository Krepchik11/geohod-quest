/**
 * Pure view-model for the admin feature-toggles page (mirrors the
 * lib/admin-users.ts pattern: wire types + display derivations, no React).
 *
 * The flag registry lives in backend code (`backend/src/features.rs`); the
 * client renders whatever the list endpoint serves, so a newly registered
 * flag appears here without a frontend change — labels below are optional
 * polish keyed by the stable wire key, with the key itself as fallback.
 */

/** One feature as served by GET /api/admin/features. */
export interface AdminFeatureWire {
  key: string;
  default_enabled: boolean;
  /** Stored admin override; `null` = the code default applies. */
  override: boolean | null;
  /** The enforced toggle verdict (`override ?? default`). */
  effective: boolean;
  /** Capability: the deployment is configured for the feature (credentials present). */
  available: boolean;
}

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

/** Russian labels for the known registry keys; an unknown key falls back to itself. */
const META: Record<string, { label: string; description: string; setting?: FeatureSetting }> = {
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

/** One runtime setting as served by GET/POST /api/admin/settings/{key}. */
export interface AdminSettingWire {
  key: string;
  /** Stored value; `null` = unset (settings have no default values). */
  value: string | null;
}

export function toAdminFeature(w: AdminFeatureWire): AdminFeature {
  const meta = META[w.key];
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
