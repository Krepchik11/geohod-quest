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

/** Wire row plus display strings resolved from the key. */
export interface AdminFeature extends AdminFeatureWire {
  label: string;
  description: string;
}

/** Russian labels for the known registry keys; an unknown key falls back to itself. */
const META: Record<string, { label: string; description: string }> = {
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
};

export function toAdminFeature(w: AdminFeatureWire): AdminFeature {
  const meta = META[w.key];
  return { ...w, label: meta?.label ?? w.key, description: meta?.description ?? '' };
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
