'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../../lib/api';
import {
  FILTER_LABELS,
  FILTER_ORDER,
  STATUS_LABELS,
  discountLabel,
  filterCoupons,
  isArchived,
  pluralizeCoupons,
  scopeLabel,
  toAdminCoupon,
  usageLabel,
  usagePercent,
  validityLabel,
  type AdminCoupon,
  type CouponFilter,
} from '../../../lib/admin-coupons';
import AdminShell, { AdminGate, useAdminAccess } from '../shell';

/**
 * Admin · Coupons list (Admin Coupons.dc.html §1a/§1c): search by code, status
 * chips with the automatic archive (+count), newest-first rows with discount,
 * validity, usage progress and a status badge. Desktop renders a table-like
 * grid inside one card; mobile restyles each row into a stacked card (same
 * DOM, CSS switches). The ⋯ menu offers edit / pause–resume / delete without
 * leaving the list; clicking a row opens the editor.
 */
export default function AdminCouponsPage() {
  const access = useAdminAccess();
  const router = useRouter();
  const [coupons, setCoupons] = useState<AdminCoupon[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CouponFilter>('all');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdminCoupon | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (access !== 'granted') return;
    let cancelled = false;
    void api
      .adminListCoupons()
      .then((wire) => {
        if (!cancelled) {
          setCoupons(wire.map(toAdminCoupon));
          setLoadError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [access]);

  // Click anywhere closes an open row menu.
  useEffect(() => {
    if (!menuFor) return;
    const onDoc = () => setMenuFor(null);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [menuFor]);

  const filtered = useMemo(() => filterCoupons(coupons, filter, query), [coupons, filter, query]);
  const archivedCount = useMemo(() => coupons.filter(isArchived).length, [coupons]);

  const showToast = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 2600);
  };

  /** Pause/resume straight from the list: save the coupon with paused flipped. */
  const togglePause = async (c: AdminCoupon) => {
    setMenuFor(null);
    setBusyId(c.id);
    try {
      const wire = await api.adminSaveCoupon(c.id, {
        code: c.code,
        discount_type: c.discountType,
        discount_value: c.discountValue,
        valid_until: c.validUntil,
        max_redemptions: c.maxRedemptions,
        per_user_limit: c.perUserLimit,
        quest_ids: c.questIds,
        paused: !c.paused,
      });
      const next = toAdminCoupon(wire);
      setCoupons((list) => list.map((x) => (x.id === next.id ? next : x)));
      showToast(next.paused ? 'Купон поставлен на паузу' : 'Купон снова активен');
    } catch {
      showToast('Не удалось обновить купон');
    } finally {
      setBusyId(null);
    }
  };

  const deleteCoupon = async (c: AdminCoupon) => {
    setBusyId(c.id);
    try {
      await api.adminDeleteCoupon(c.id);
      setCoupons((list) => list.filter((x) => x.id !== c.id));
      showToast('Купон удалён');
    } catch {
      showToast('Не удалось удалить купон');
    } finally {
      setBusyId(null);
      setConfirmDelete(null);
    }
  };

  return (
    <AdminShell active="coupons">
      <AdminGate access={access}>
        <div className="ac-root">
          <main className="ac-main">
            <div className="ac-head">
              <div>
                <div className="ac-eyebrow">УПРАВЛЕНИЕ</div>
                <h1 className="ac-title">Купоны</h1>
              </div>
              <button type="button" className="ac-new" onClick={() => router.push('/admin/coupons/new')}>
                <span className="ac-new__plus" aria-hidden>+</span>
                <span className="ac-new__label">Новый купон</span>
              </button>
            </div>

            <div className="ac-filters">
              <div className="ac-search">
                <span className="ac-search-icon" aria-hidden />
                <input
                  type="text"
                  className="ac-search-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Код купона…"
                  aria-label="Поиск по коду купона"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="ac-chips">
                <span className="ac-chips-label">СТАТУС</span>
                {FILTER_ORDER.map((f) => (
                  <button
                    type="button"
                    key={f}
                    className={`ac-chip${filter === f ? ' is-on' : ''}`}
                    aria-pressed={filter === f}
                    onClick={() => setFilter(f)}
                  >
                    {FILTER_LABELS[f]}
                    {f === 'archive' && archivedCount > 0 && (
                      <span className="ac-chip__count">{archivedCount}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {!loadError && (
              <div className="ac-count">
                {pluralizeCoupons(filtered.length)} · новые сверху · истёкшие и исчерпанные попадают в архив автоматически
              </div>
            )}

            {loadError ? (
              <div className="ac-list"><div className="ac-empty">Не удалось загрузить купоны. Проверьте соединение и обновите страницу.</div></div>
            ) : filtered.length === 0 ? (
              <div className="ac-list">
                <div className="ac-empty">
                  {coupons.length === 0
                    ? 'Купонов пока нет — создайте первый.'
                    : 'Ничего не нашлось. Измените запрос или фильтр.'}
                </div>
              </div>
            ) : (
              <div className="ac-list">
                <div className="ac-cols" aria-hidden>
                  <span>КУПОН</span>
                  <span>СКИДКА</span>
                  <span>ДЕЙСТВУЕТ</span>
                  <span>ИСПОЛЬЗОВАНИЯ</span>
                  <span>СТАТУС</span>
                  <span />
                </div>
                {filtered.map((c) => (
                  <CouponRow
                    key={c.id}
                    coupon={c}
                    busy={busyId === c.id}
                    menuOpen={menuFor === c.id}
                    onOpen={() => router.push(`/admin/coupons/${encodeURIComponent(c.id)}`)}
                    onMenu={() => setMenuFor((cur) => (cur === c.id ? null : c.id))}
                    onTogglePause={() => void togglePause(c)}
                    onDelete={() => {
                      setMenuFor(null);
                      setConfirmDelete(c);
                    }}
                  />
                ))}
              </div>
            )}
          </main>

          {confirmDelete && (
            <div
              className="ac-sheet-backdrop"
              role="presentation"
              onClick={() => busyId === null && setConfirmDelete(null)}
            >
              <div
                className="ac-sheet"
                role="dialog"
                aria-modal="true"
                aria-label="Удалить купон"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="ac-sheet-grip" aria-hidden />
                <div className="ac-sheet-title">Удалить купон {confirmDelete.code}?</div>
                <div className="ac-sheet-text">
                  Удаление необратимо. Уже применённые скидки и покупки сохраняются.
                </div>
                <div className="ac-sheet-actions">
                  <button
                    type="button"
                    className="ac-sheet-cancel"
                    disabled={busyId !== null}
                    onClick={() => setConfirmDelete(null)}
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    className="ac-sheet-apply"
                    disabled={busyId !== null}
                    onClick={() => void deleteCoupon(confirmDelete)}
                  >
                    {busyId !== null ? 'Удаляем…' : 'Удалить'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {toast && <div className="ac-toast" role="status">{toast}</div>}
        </div>
      </AdminGate>
    </AdminShell>
  );
}

/** One coupon row: desktop grid columns / mobile card (CSS switches). */
function CouponRow({
  coupon: c,
  busy,
  menuOpen,
  onOpen,
  onMenu,
  onTogglePause,
  onDelete,
}: {
  coupon: AdminCoupon;
  busy: boolean;
  menuOpen: boolean;
  onOpen: () => void;
  onMenu: () => void;
  onTogglePause: () => void;
  onDelete: () => void;
}) {
  const pct = usagePercent(c);
  const spent = c.status === 'exhausted' || c.status === 'expired';
  const canPause = c.status === 'active' || c.status === 'paused';
  return (
    <div
      className={`ac-row${isArchived(c) ? ' is-archived' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="ac-row__head">
        <div className="ac-row__id">
          <div className="ac-row__code">{c.code}</div>
          <div className="ac-row__scope">{scopeLabel(c)}</div>
          <div className="ac-row__mobile-meta">
            {validityLabel(c)} · {scopeLabel(c).toLowerCase()}
          </div>
        </div>
        <span className="ac-row__discount">{discountLabel(c)}</span>
        <span className="ac-row__chev" aria-hidden>›</span>
      </div>
      <div className="ac-row__discount ac-row__discount--col">{discountLabel(c)}</div>
      <div className="ac-row__validity">{validityLabel(c)}</div>
      <div className="ac-row__usage">
        <div className="ac-usage__line">
          <span className="ac-usage__count">
            {c.used}{' '}
            <small>{c.maxRedemptions === null ? '· без лимита' : `из ${c.maxRedemptions}`}</small>
          </span>
          {pct !== null && <span className="ac-usage__pct">{pct}%</span>}
          <span className={`ac-badge ac-badge--${c.status} ac-badge--mobile`}>
            {STATUS_LABELS[c.status]}
          </span>
        </div>
        <div className="ac-bar">
          {pct === null ? (
            <div className="ac-bar__fill ac-bar__fill--stripes" />
          ) : (
            <div
              className={`ac-bar__fill${spent ? ' ac-bar__fill--spent' : ''}`}
              style={{ width: `${pct}%` }}
            />
          )}
        </div>
      </div>
      <span className={`ac-badge ac-badge--${c.status} ac-badge--cell`}>{STATUS_LABELS[c.status]}</span>
      <div className="ac-more">
        <button
          type="button"
          className="ac-more__btn"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Действия с купоном ${c.code}`}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onMenu();
          }}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="ac-more__menu" role="menu" onClick={(e) => e.stopPropagation()}>
            <button type="button" role="menuitem" onClick={onOpen}>Редактировать</button>
            {canPause && (
              <button type="button" role="menuitem" onClick={onTogglePause}>
                {c.paused ? 'Возобновить' : 'Поставить на паузу'}
              </button>
            )}
            <button type="button" role="menuitem" className="is-danger" onClick={onDelete}>
              Удалить
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
