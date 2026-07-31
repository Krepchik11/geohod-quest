'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, apiErrorMessage, type CouponPayload, type PublishedQuestWire } from '../../../lib/api';
import {
  STATUS_LABELS,
  formatRubles,
  generateCode,
  lastUsedLabel,
  tileColor,
  toAdminCoupon,
  usagePercent,
  type AdminCoupon,
} from '../../../lib/admin-coupons';
import { AdminConfirmSheet, AdminToast } from '../ui';

/**
 * Admin · Coupon editor (Admin Coupons.dc.html §1b/§1d/§1e) — one screen for
 * create and edit. Left: the form (code + «Сгенерировать», % / ₽ discount,
 * «действует до» with «Без срока», usage caps, quest applicability with search
 * and letter-tile rows). Right (desktop) / top (mobile): the usage card; edit
 * mode adds the «Действия» card — pause is the reversible stop, delete is
 * confirmed through a sheet and keeps already-applied discounts.
 *
 * All rules live server-side (validation, uniqueness, redeem caps); the form
 * only keeps obvious slips from a round-trip and renders the backend's
 * Russian error messages verbatim.
 */

/** One row of the applicability picker. */
export interface QuestPickerRow {
  questId: string;
  name: string;
  /** `null` for an off-catalog quest — its price is genuinely unknown here. */
  price: number | null;
  /** Selected earlier, but the catalog no longer offers it — no name to show. */
  offCatalog: boolean;
}

/**
 * Rows for the applicability picker: every paid catalog quest, PLUS any already
 * selected quest the catalog no longer offers.
 *
 * The union is the point. Rendering the catalog alone left an id that is in the
 * payload and counted by «Выбрано: N» with no row to untick — a selection the
 * admin could neither see nor remove. An off-catalog quest has no name here (the
 * catalog is the only source the editor loads), so its id is the honest label and
 * also what the search matches on.
 */
export function questPickerRows(
  quests: ReadonlyArray<{ quest_id: string; name: string; price?: number | null }>,
  selectedIds: readonly string[],
  query: string,
): QuestPickerRow[] {
  const inCatalog = new Set(quests.map((q) => q.quest_id));
  const rows: QuestPickerRow[] = [
    ...quests.map((q) => ({
      questId: q.quest_id,
      name: q.name,
      price: q.price ?? 0,
      offCatalog: false,
    })),
    ...selectedIds
      .filter((id) => !inCatalog.has(id))
      .map((id) => ({ questId: id, name: id, price: null, offCatalog: true })),
  ];
  const needle = query.trim().toLowerCase();
  return needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : rows;
}

interface FormState {
  code: string;
  discountType: 'percent' | 'fixed';
  discountValue: string;
  noExpiry: boolean;
  validUntil: string;
  noLimit: boolean;
  maxRedemptions: string;
  noPerUserLimit: boolean;
  perUserLimit: string;
  allQuests: boolean;
  questIds: string[];
  paused: boolean;
}

const EMPTY_FORM: FormState = {
  code: '',
  discountType: 'percent',
  discountValue: '',
  noExpiry: true,
  validUntil: '',
  noLimit: true,
  maxRedemptions: '',
  noPerUserLimit: true,
  perUserLimit: '',
  allQuests: true,
  questIds: [],
  paused: false,
};

function formFrom(c: AdminCoupon): FormState {
  return {
    code: c.code,
    discountType: c.discountType,
    discountValue: String(c.discountValue),
    noExpiry: c.validUntil === null,
    validUntil: c.validUntil ?? '',
    noLimit: c.maxRedemptions === null,
    maxRedemptions: c.maxRedemptions === null ? '' : String(c.maxRedemptions),
    noPerUserLimit: c.perUserLimit === null,
    perUserLimit: c.perUserLimit === null ? '' : String(c.perUserLimit),
    allQuests: c.questIds === null,
    questIds: c.questIds ?? [],
    paused: c.paused,
  };
}

/** Form → wire payload, or a Russian error for the obvious local slips. */
export function buildPayload(f: FormState): { payload: CouponPayload } | { error: string } {
  const code = f.code.trim();
  if (!code) return { error: 'Введите код купона или нажмите «Сгенерировать».' };
  const value = Number(f.discountValue);
  if (!Number.isInteger(value) || value <= 0) {
    return { error: 'Укажите размер скидки — целое число больше нуля.' };
  }
  if (f.discountType === 'percent' && value > 100) {
    return { error: 'Процент скидки не может быть больше 100.' };
  }
  if (!f.noExpiry && !f.validUntil) {
    return { error: 'Выберите дату «действует до» или отметьте «Без срока».' };
  }
  const maxRedemptions = f.noLimit ? null : Number(f.maxRedemptions);
  if (maxRedemptions !== null && (!Number.isInteger(maxRedemptions) || maxRedemptions <= 0)) {
    return { error: 'Лимит использований — целое число больше нуля, либо «Без лимита».' };
  }
  const perUser = f.noPerUserLimit ? null : Number(f.perUserLimit);
  if (perUser !== null && (!Number.isInteger(perUser) || perUser <= 0)) {
    return { error: 'Лимит на пользователя — целое число больше нуля, либо «Без лимита».' };
  }
  if (!f.allQuests && f.questIds.length === 0) {
    return { error: 'Выберите хотя бы один квест или переключитесь на «Все квесты».' };
  }
  return {
    payload: {
      code,
      discount_type: f.discountType,
      discount_value: value,
      valid_until: f.noExpiry ? null : f.validUntil,
      max_redemptions: maxRedemptions,
      per_user_limit: perUser,
      quest_ids: f.allQuests ? null : f.questIds,
      paused: f.paused,
    },
  };
}

/** The backend's {"error": msg} body, or a generic fallback. */
function serverMessage(err: unknown): string {
  return apiErrorMessage(err, 'Не удалось сохранить купон. Проверьте соединение и попробуйте ещё раз.');
}

export default function CouponEditor({ couponId }: { couponId?: string }) {
  const router = useRouter();
  const isNew = !couponId;

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [coupon, setCoupon] = useState<AdminCoupon | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'missing' | 'error'>(
    isNew ? 'ready' : 'loading',
  );
  const [quests, setQuests] = useState<PublishedQuestWire[]>([]);
  const [questQuery, setQuestQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    let cancelled = false;
    // Paid published quests feed the applicability picker.
    void api
      .listQuests()
      .then((all) => {
        if (!cancelled) setQuests(all.filter((q) => (q.price ?? 0) > 0));
      })
      .catch(() => {
        /* picker degrades to an empty list; «Все квесты» still works */
      });
    if (couponId) {
      void api
        .adminGetCoupon(couponId)
        .then((wire) => {
          if (cancelled) return;
          const c = toAdminCoupon(wire);
          setCoupon(c);
          setForm(formFrom(c));
          setLoadState('ready');
        })
        .catch((err) => {
          if (cancelled) return;
          const status = err instanceof ApiError ? err.status : null;
          setLoadState(status === 404 ? 'missing' : 'error');
        });
    }
    return () => {
      cancelled = true;
    };
  }, [couponId]);

  const filteredQuests = useMemo(
    () => questPickerRows(quests, form.questIds, questQuery),
    [quests, form.questIds, questQuery],
  );

  const showToast = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 2600);
  };

  const back = () => router.push('/admin/coupons');

  const save = async (over: Partial<FormState> = {}) => {
    const draft = { ...form, ...over };
    const built = buildPayload(draft);
    if ('error' in built) {
      setFormError(built.error);
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      const wire = isNew
        ? await api.adminCreateCoupon(built.payload)
        : await api.adminSaveCoupon(couponId, built.payload);
      if (isNew) {
        // Land in edit mode so usage/actions appear and a double-submit
        // cannot create a twin coupon.
        router.push(`/admin/coupons/${encodeURIComponent(wire.coupon_id)}`);
        return;
      }
      const next = toAdminCoupon(wire);
      setCoupon(next);
      setForm(formFrom(next));
      showToast('Купон сохранён');
    } catch (err) {
      setFormError(serverMessage(err));
    } finally {
      setSaving(false);
    }
  };

  /** «Поставить на паузу» / «Возобновить» — an immediate save with paused flipped. */
  const togglePause = () => void save({ paused: !form.paused });

  const deleteCoupon = async () => {
    if (!couponId) return;
    setSaving(true);
    try {
      await api.adminDeleteCoupon(couponId);
      back();
    } catch {
      setSaving(false);
      setConfirmDelete(false);
      showToast('Не удалось удалить купон');
    }
  };

  const generate = () =>
    set('code', generateCode((n) => crypto.getRandomValues(new Uint8Array(n))));

  const usage = coupon ? usagePercent(coupon) : null;

  return (
    <>
    <main className="ap-main">
      <button type="button" className="ac-back" onClick={back}>
        <span className="ac-back__arrow" aria-hidden>‹</span> Купоны
      </button>

      {loadState === 'loading' ? (
        <div className="ash-state"><span className="ash-spinner" aria-label="Загрузка" /></div>
      ) : loadState !== 'ready' ? (
        <div className="ash-state">
          <div className="ash-state-title">
            {loadState === 'missing' ? 'Купон не найден' : 'Не удалось загрузить купон'}
          </div>
          <div className="ash-state-text">
            {loadState === 'missing'
              ? 'Возможно, он был удалён. Вернитесь к списку купонов.'
              : 'Проверьте соединение и обновите страницу.'}
          </div>
        </div>
      ) : (
        <>
          <div className="ac-editor-head">
            <h1 className="ap-title">{isNew ? 'Новый купон' : coupon?.code}</h1>
            {coupon && (
              <span className={`ac-badge ac-badge--${coupon.status}`}>
                {STATUS_LABELS[coupon.status]}
              </span>
            )}
          </div>

          <div className="ac-editor">
            <div className="ac-editor__form">
              <section className="ac-card">
                <div className="ac-card__label">ОСНОВНОЕ</div>
                <div className="ac-field">
                  <label htmlFor="cpn-code">Код купона</label>
                  <div className="ac-input-row">
                    <input
                      id="cpn-code"
                      className="ac-input ac-input--code"
                      value={form.code}
                      onChange={(e) => set('code', e.target.value.toUpperCase())}
                      placeholder="LETO-20"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button type="button" className="ac-gen" onClick={generate}>
                      Сгенерировать
                    </button>
                  </div>
                  <div className="ac-field-hint">
                    Любой непустой код. Игрок вводит его в окне покупки.
                  </div>
                </div>
                <div className="ac-grid-2">
                  <div className="ac-field">
                    <label>Тип скидки</label>
                    <div className="ac-seg" role="group" aria-label="Тип скидки">
                      <button
                        type="button"
                        className={form.discountType === 'percent' ? 'is-on' : undefined}
                        aria-pressed={form.discountType === 'percent'}
                        onClick={() => set('discountType', 'percent')}
                      >
                        Процент %
                      </button>
                      <button
                        type="button"
                        className={form.discountType === 'fixed' ? 'is-on' : undefined}
                        aria-pressed={form.discountType === 'fixed'}
                        onClick={() => set('discountType', 'fixed')}
                      >
                        Сумма ₽
                      </button>
                    </div>
                  </div>
                  <div className="ac-field">
                    <label htmlFor="cpn-value">Размер скидки</label>
                    <span
                      className="ac-input--unit"
                      data-unit={form.discountType === 'percent' ? '%' : '₽'}
                    >
                      <input
                        id="cpn-value"
                        className="ac-input ac-input--num"
                        inputMode="numeric"
                        value={form.discountValue}
                        onChange={(e) => set('discountValue', e.target.value.replace(/\D/g, ''))}
                        placeholder={form.discountType === 'percent' ? '20' : '300'}
                      />
                    </span>
                  </div>
                </div>
              </section>

              <section className="ac-card">
                <div className="ac-card__label">ОГРАНИЧЕНИЯ</div>
                <div className="ac-grid-3">
                  <div className="ac-field">
                    <label htmlFor="cpn-until">Действует до</label>
                    <input
                      id="cpn-until"
                      type="date"
                      className="ac-input"
                      value={form.validUntil}
                      disabled={form.noExpiry}
                      onChange={(e) => set('validUntil', e.target.value)}
                    />
                    <label className="ac-check">
                      <input
                        type="checkbox"
                        checked={form.noExpiry}
                        onChange={(e) => set('noExpiry', e.target.checked)}
                      />
                      <span className="ac-check__box" aria-hidden />
                      Без срока
                    </label>
                  </div>
                  <div className="ac-field">
                    <label htmlFor="cpn-max">Лимит использований</label>
                    <input
                      id="cpn-max"
                      className="ac-input ac-input--num"
                      inputMode="numeric"
                      value={form.maxRedemptions}
                      disabled={form.noLimit}
                      onChange={(e) => set('maxRedemptions', e.target.value.replace(/\D/g, ''))}
                      placeholder="100"
                    />
                    <label className="ac-check">
                      <input
                        type="checkbox"
                        checked={form.noLimit}
                        onChange={(e) => set('noLimit', e.target.checked)}
                      />
                      <span className="ac-check__box" aria-hidden />
                      Без лимита
                    </label>
                  </div>
                  <div className="ac-field">
                    <label htmlFor="cpn-per-user">На одного пользователя</label>
                    <input
                      id="cpn-per-user"
                      className="ac-input ac-input--num"
                      inputMode="numeric"
                      value={form.perUserLimit}
                      disabled={form.noPerUserLimit}
                      onChange={(e) => set('perUserLimit', e.target.value.replace(/\D/g, ''))}
                      placeholder="1"
                    />
                    <label className="ac-check">
                      <input
                        type="checkbox"
                        checked={form.noPerUserLimit}
                        onChange={(e) => set('noPerUserLimit', e.target.checked)}
                      />
                      <span className="ac-check__box" aria-hidden />
                      Без лимита
                    </label>
                  </div>
                </div>
              </section>

              <section className="ac-card">
                <div className="ac-card__labelrow">
                  <div className="ac-card__label">ПРИМЕНИМОСТЬ</div>
                  {!form.allQuests && (
                    <span className="ac-card__chosen">Выбрано: {form.questIds.length}</span>
                  )}
                </div>
                <div className="ac-seg ac-seg--capped" role="group" aria-label="Применимость">
                  <button
                    type="button"
                    className={form.allQuests ? 'is-on' : undefined}
                    aria-pressed={form.allQuests}
                    onClick={() => set('allQuests', true)}
                  >
                    Все квесты
                  </button>
                  <button
                    type="button"
                    className={!form.allQuests ? 'is-on' : undefined}
                    aria-pressed={!form.allQuests}
                    onClick={() => set('allQuests', false)}
                  >
                    Выбранные
                  </button>
                </div>
                {form.allQuests ? (
                  <div className="ac-field-hint">
                    Купон примет любой платный квест из магазина, включая будущие.
                  </div>
                ) : (
                  <>
                    <div className="ac-search">
                      <span className="ac-search-icon" aria-hidden />
                      <input
                        type="text"
                        className="ac-search-input"
                        value={questQuery}
                        onChange={(e) => setQuestQuery(e.target.value)}
                        placeholder="Название квеста…"
                        aria-label="Поиск квеста"
                      />
                    </div>
                    <div className="ac-quests">
                      {filteredQuests.length === 0 ? (
                        <div className="ac-field-hint">
                          {quests.length === 0
                            ? 'Платных квестов в магазине пока нет.'
                            : 'Ничего не нашлось.'}
                        </div>
                      ) : (
                        filteredQuests.map((q) => {
                          const on = form.questIds.includes(q.questId);
                          return (
                            <button
                              type="button"
                              key={q.questId}
                              className={`ac-quest${on ? ' is-on' : ''}`}
                              aria-pressed={on}
                              title={q.offCatalog ? 'Квеста нет в магазине' : undefined}
                              onClick={() =>
                                set(
                                  'questIds',
                                  on
                                    ? form.questIds.filter((id) => id !== q.questId)
                                    : [...form.questIds, q.questId],
                                )
                              }
                            >
                              <span className="ac-quest__tick" aria-hidden />
                              <span
                                className="ac-quest__cover"
                                style={{ background: tileColor(q.questId) }}
                                aria-hidden
                              >
                                {(q.name.trim()[0] || '?').toUpperCase()}
                              </span>
                              <span className="ac-quest__name">
                                {q.name}
                                {q.offCatalog && ' · нет в каталоге'}
                              </span>
                              <span className="ac-quest__price">
                                {q.price === null ? '—' : `${formatRubles(q.price)} ₽`}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </>
                )}
              </section>

              {formError && <div className="ac-form-error" role="alert">{formError}</div>}

              <div className="ac-actions">
                <button type="button" className="ac-save" disabled={saving} onClick={() => void save()}>
                  {saving ? 'Сохраняем…' : isNew ? 'Создать купон' : 'Сохранить купон'}
                </button>
                <button type="button" className="ac-cancel" disabled={saving} onClick={back}>
                  Отмена
                </button>
              </div>

              {/* Mobile: the «Действия» card lives below the save button. */}
              {!isNew && (
                <section className="ac-card ac-card--actions ac-actions--mobile-extra">
                  <div className="ac-card__label">ДЕЙСТВИЯ</div>
                  <button type="button" className="ac-side-btn" disabled={saving} onClick={togglePause}>
                    {form.paused ? 'Возобновить' : 'Поставить на паузу'}
                  </button>
                  <button
                    type="button"
                    className="ac-side-btn ac-side-btn--danger"
                    disabled={saving}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Удалить купон
                  </button>
                  <div className="ac-side-note">
                    Пауза мгновенно останавливает приём кода. Удаление необратимо; уже
                    применённые скидки сохраняются.
                  </div>
                </section>
              )}
            </div>

            {!isNew && coupon && (
              <div className="ac-editor__side">
                <section className="ac-card">
                  <div className="ac-card__label">ИСПОЛЬЗОВАНИЕ</div>
                  <div>
                    <div className="ac-usage-big">
                      <b>{coupon.used}</b>
                      <span>
                        {coupon.maxRedemptions === null
                          ? 'активаций · без лимита'
                          : `из ${coupon.maxRedemptions} активаций`}
                      </span>
                    </div>
                    <div className="ac-bar ac-bar--big">
                      {usage === null ? (
                        <div className="ac-bar__fill ac-bar__fill--stripes" />
                      ) : (
                        <div className="ac-bar__fill" style={{ width: `${usage}%` }} />
                      )}
                    </div>
                    <div className="ac-usage-rows">
                      {coupon.maxRedemptions !== null && (
                        <div>
                          <span>Осталось активаций</span>
                          <b>{Math.max(0, coupon.maxRedemptions - coupon.used)}</b>
                        </div>
                      )}
                      <div>
                        <span>Последнее применение</span>
                        <b>{lastUsedLabel(coupon.lastRedeemedAt, new Date())}</b>
                      </div>
                      <div>
                        <span>Сумма скидок</span>
                        <b>{formatRubles(coupon.totalDiscounted)} ₽</b>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="ac-card ac-card--actions">
                  <div className="ac-card__label">ДЕЙСТВИЯ</div>
                  <button type="button" className="ac-side-btn" disabled={saving} onClick={togglePause}>
                    {form.paused ? 'Возобновить' : 'Поставить на паузу'}
                  </button>
                  <button
                    type="button"
                    className="ac-side-btn ac-side-btn--danger"
                    disabled={saving}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Удалить купон
                  </button>
                  <div className="ac-side-note">
                    Пауза мгновенно останавливает приём кода. Удаление необратимо; уже
                    применённые скидки сохраняются.
                  </div>
                </section>
              </div>
            )}
          </div>
        </>
      )}
    </main>

    {confirmDelete && coupon && (
      <AdminConfirmSheet
        label="Удалить купон"
        title={`Удалить купон ${coupon.code}?`}
        text="Удаление необратимо. Уже применённые скидки и покупки сохраняются."
        applyLabel="Удалить"
        busyLabel="Удаляем…"
        busy={saving}
        danger
        onCancel={() => setConfirmDelete(false)}
        onApply={() => void deleteCoupon()}
      />
    )}

    {toast && <AdminToast text={toast} />}
    </>
  );
}
