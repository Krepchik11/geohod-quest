'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, hasAdminToken } from '../../lib/api';
import {
  contactsOf,
  detectHint,
  filterUsers,
  formatJoined,
  pluralizeUsers,
  ROLE_LABELS,
  ROLE_ORDER,
  type AdminUser,
  type Role,
  titleOf,
  toAdminUser,
} from '../../lib/admin-users';

/**
 * Admin · Users (admin-users spec) — a faithful build of Admin Users.dc.html in the
 * real stack: a searchable, role-filterable list → tap → profile with a role editor,
 * a confirm sheet, and a success toast. Mobile-first 480px frame (styles/admin-users.css).
 *
 * Access is gated twice: the backend authorizes every /api/admin/* call (role==admin
 * session OR the shared ADMIN_TOKEN), and this page checks /api/players/me up front so
 * non-admins see a clear "no access" screen instead of an empty list. The operator
 * path (NEXT_PUBLIC_ADMIN_TOKEN configured) is admitted via hasAdminToken() so the
 * very first admin can be promoted before any admin account exists.
 *
 * Reality vs. the prototype: the backend models email + display_name + role + join
 * date only (no telegram/phone/last-active), so contact rows render present-only.
 * liveSearch + a confirm-before-apply sheet are both on (the safer, complete flow).
 */

type Access = 'checking' | 'granted' | 'denied' | 'error';
type ListError = 'none' | 'auth' | 'network';
type Toast = { text: string; error?: boolean };

function errorKind(err: unknown): 'auth' | 'network' {
  const status = err instanceof ApiError ? err.status : null;
  return status === 401 || status === 403 ? 'auth' : 'network';
}

export default function AdminUsersPage() {
  const [access, setAccess] = useState<Access>('checking');
  const [meInitial, setMeInitial] = useState('Я');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [listError, setListError] = useState<ListError>('none');

  const [query, setQuery] = useState('');
  const [activeRoles, setActiveRoles] = useState<Role[]>([]);
  // §10.2: classic pagination — 25 per page, reset on any filter change.
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftRole, setDraftRole] = useState<Role | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((text: string, error = false) => {
    setToast({ text, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  // Gate access, then (if granted) load the user list. Single mount-time pass.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const tokenAdmin = hasAdminToken();
      let granted = tokenAdmin;
      let initial = 'Я';
      try {
        const me = await api.me();
        if (me.registered) {
          const label = (me.display_name || me.email || '').trim();
          if (label) initial = label[0].toUpperCase();
        }
        if (me.role === 'admin') granted = true;
      } catch (err) {
        // /me failed: only a configured admin token can still grant access.
        if (!tokenAdmin) {
          if (!cancelled) setAccess(errorKind(err) === 'auth' ? 'denied' : 'error');
          return;
        }
      }
      if (cancelled) return;
      if (!granted) {
        setAccess('denied');
        return;
      }
      setMeInitial(initial);
      setAccess('granted');
      try {
        const wire = await api.adminListUsers();
        if (!cancelled) {
          setUsers(wire.map(toAdminUser));
          setListError('none');
        }
      } catch (err) {
        if (!cancelled) setListError(errorKind(err) === 'auth' ? 'auth' : 'network');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const filtered = useMemo(
    () => filterUsers(users, activeRoles, query),
    [users, activeRoles, query],
  );
  const hint = useMemo(() => detectHint(query), [query]);
  const PER_PAGE = 25;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const pageItems = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);
  const rangeLabel = filtered.length === 0
    ? '0 из 0'
    : `${(safePage - 1) * PER_PAGE + 1}–${Math.min(safePage * PER_PAGE, filtered.length)} из ${filtered.length}`;
  const selected = useMemo(
    () => users.find((u) => u.id === selectedId) ?? null,
    [users, selectedId],
  );
  const canSave = !!(selected && draftRole && draftRole !== selected.role);

  const openUser = (u: AdminUser) => {
    setSelectedId(u.id);
    setDraftRole(u.role);
    setConfirmOpen(false);
  };
  const back = () => {
    setSelectedId(null);
    setConfirmOpen(false);
  };
  const toggleRole = (role: Role) => {
    setPage(1); // §10.2: filters reset pagination
    setActiveRoles((roles) =>
      roles.includes(role) ? roles.filter((r) => r !== role) : [...roles, role],
    );
  };

  const applyRole = useCallback(async () => {
    if (!selected || !draftRole) return;
    setSaving(true);
    try {
      const updated = await api.adminSetUserRole(selected.id, draftRole);
      const next = toAdminUser(updated);
      setUsers((list) => list.map((u) => (u.id === next.id ? next : u)));
      setConfirmOpen(false);
      setSelectedId(null);
      showToast('Роль обновлена');
    } catch (err) {
      setConfirmOpen(false);
      const status = err instanceof ApiError ? err.status : null;
      if (status === 409) showToast('Нельзя изменить свою роль', true);
      else if (status === 404) showToast('Пользователь не найден', true);
      else showToast('Не удалось обновить роль', true);
    } finally {
      setSaving(false);
    }
  }, [selected, draftRole, showToast]);

  const save = () => {
    if (!canSave) return;
    setConfirmOpen(true);
  };

  // ---- gate states -------------------------------------------------------
  if (access === 'checking') {
    return (
      <div className="au-root">
        <div className="au-frame">
          <AdminHeader initial={meInitial} />
          <div className="au-state">
            <span className="au-spinner" aria-label="Загрузка" />
          </div>
        </div>
      </div>
    );
  }
  if (access !== 'granted') {
    const denied = access === 'denied';
    return (
      <div className="au-root">
        <div className="au-frame">
          <AdminHeader initial={meInitial} />
          <div className="au-state">
            <div className="au-state-title">{denied ? 'Нет доступа' : 'Сервер недоступен'}</div>
            <div className="au-state-text">
              {denied
                ? 'Эта страница доступна только администраторам. Войдите под учётной записью администратора.'
                : 'Не удалось связаться с сервером. Попробуйте обновить страницу позже.'}
            </div>
            <Link className="au-state-link" href={denied ? '/auth' : '/'}>
              {denied ? 'Войти' : 'На главную'}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ---- granted: list or detail ------------------------------------------
  return (
    <div className="au-root">
      <div className="au-frame">
        <AdminHeader initial={meInitial} />

        {/* §10.3: ≥1024px master-detail — list left (460px, selected row gets a
            blue bar), profile right; below 1024 the panes swap like screens. */}
        <div className={`au-split${selected ? ' has-selected' : ''}`}>
          <main className="au-main au-pane au-pane--list">
            <div>
              <div className="au-eyebrow">УПРАВЛЕНИЕ</div>
              <h1 className="au-title">Пользователи</h1>
            </div>

            <div className="au-search-row">
              <div className="au-search">
                <span className="au-search-icon" aria-hidden />
                <input
                  type="text"
                  className="au-search-input"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setPage(1); }}
                  placeholder="Почта или имя…"
                  aria-label="Поиск пользователей"
                  autoComplete="off"
                  spellCheck={false}
                />
                {query.length > 0 && (
                  <button
                    type="button"
                    className="au-clear"
                    aria-label="Очистить"
                    onClick={() => { setQuery(''); setPage(1); }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {hint && (
              <div className="au-hint">
                <span className="au-hint-label">РАСПОЗНАНО</span>
                <span className="au-hint-chip">{hint}</span>
              </div>
            )}

            <div className="au-roles">
              <span className="au-roles-label">РОЛИ</span>
              {ROLE_ORDER.map((role) => (
                <button
                  type="button"
                  key={role}
                  className={`au-chip${activeRoles.includes(role) ? ' is-on' : ''}`}
                  aria-pressed={activeRoles.includes(role)}
                  onClick={() => toggleRole(role)}
                >
                  {ROLE_LABELS[role]}
                </button>
              ))}
            </div>

            {listError === 'none' && <div className="au-count">{pluralizeUsers(filtered.length)} · новые сверху</div>}

            {listError !== 'none' ? (
              <div className="au-empty">
                <div className="au-empty-mark" aria-hidden>
                  !
                </div>
                <div className="au-empty-title">
                  {listError === 'auth' ? 'Сессия устарела' : 'Не удалось загрузить'}
                </div>
                <div className="au-empty-text">
                  {listError === 'auth'
                    ? 'Войдите снова под учётной записью администратора.'
                    : 'Проверьте соединение и обновите страницу.'}
                </div>
              </div>
            ) : filtered.length === 0 ? (
              <div className="au-empty">
                <div className="au-empty-mark" aria-hidden>
                  ∅
                </div>
                <div className="au-empty-title">Никого не нашлось</div>
                <div className="au-empty-text">Измените запрос или снимите фильтр по ролям.</div>
              </div>
            ) : (
              pageItems.map((u) => (
                <div
                  key={u.id}
                  className={`au-card${selected?.id === u.id ? ' is-selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => openUser(u)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openUser(u);
                    }
                  }}
                >
                  <div className="au-card-head">
                    <div className="au-card-main">
                      <div className="au-card-name">{titleOf(u)}</div>
                      <div className="au-card-meta">вступил {formatJoined(u.createdAt)}</div>
                    </div>
                    <span className={`au-badge au-badge--${u.role}`}>{ROLE_LABELS[u.role]}</span>
                    <span className="au-chev" aria-hidden>
                      ›
                    </span>
                  </div>
                  <div className="au-contacts">
                    {contactsOf(u).map((c) => (
                      <div className="au-contact" key={c.glyph + c.value}>
                        <span className="au-contact-glyph" aria-hidden>
                          {c.glyph}
                        </span>
                        <span className="au-contact-val">{c.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}

            {listError === 'none' && filtered.length > PER_PAGE && (
              <div className="au-pager">
                <span className="au-pager__range">{rangeLabel}</span>
                <div className="au-pager__pages">
                  {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`au-pager__page${n === safePage ? ' is-on' : ''}`}
                      onClick={() => setPage(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </main>
          <aside className="au-main au-pane au-pane--detail">
            {selected ? (
              <>
            <button type="button" className="au-back" onClick={back}>
              <span className="au-back-arrow" aria-hidden>
                ‹
              </span>{' '}
              назад
            </button>

            <div className="au-identity">
              <div className="au-identity-title">{titleOf(selected)}</div>
              <span className={`au-badge au-badge--${selected.role}`}>
                {ROLE_LABELS[selected.role]}
              </span>
            </div>

            <div className="au-info">
              {contactsOf(selected).map((c) =>
                c.glyph === '✉' ? (
                  <div className="au-info-row" key="email">
                    <span className="au-info-label">ПОЧТА</span>
                    <span className="au-info-val">{c.value}</span>
                  </div>
                ) : null,
              )}
              <div className="au-info-row">
                <span className="au-info-label">ВСТУПИЛ</span>
                <span className="au-info-val">{formatJoined(selected.createdAt)}</span>
              </div>
            </div>

            <div className="au-role-editor">
              <div className="au-role-editor-label">РОЛЬ</div>
              <div className="au-role-opts">
                {ROLE_ORDER.map((role) => {
                  const sel = draftRole === role;
                  return (
                    <button
                      type="button"
                      key={role}
                      className={`au-role-opt${sel ? ' is-sel' : ''}`}
                      aria-pressed={sel}
                      onClick={() => setDraftRole(role)}
                    >
                      <span className="au-radio">
                        <span className="au-dot" />
                      </span>
                      <span className="au-opt-label">{ROLE_LABELS[role]}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="button"
              className={`au-save${canSave ? ' is-on' : ''}`}
              disabled={!canSave}
              onClick={save}
            >
              {canSave ? 'Сохранить роль' : 'Текущая роль'}
            </button>
          </>
            ) : (
              <div className="au-detail-empty">Выберите пользователя из списка</div>
            )}
          </aside>
        </div>

        {confirmOpen && selected && draftRole && (
          <div
            className="au-sheet-backdrop"
            role="presentation"
            onClick={() => !saving && setConfirmOpen(false)}
          >
            <div
              className="au-sheet"
              role="dialog"
              aria-modal="true"
              aria-label="Сменить роль"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="au-sheet-grip" aria-hidden />
              <div className="au-sheet-title">Сменить роль?</div>
              <div className="au-sheet-text">
                {titleOf(selected)} получит роль «{ROLE_LABELS[draftRole]}». Доступ изменится сразу.
              </div>
              <div className="au-sheet-actions">
                <button
                  type="button"
                  className="au-sheet-cancel"
                  disabled={saving}
                  onClick={() => setConfirmOpen(false)}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="au-sheet-apply"
                  disabled={saving}
                  onClick={applyRole}
                >
                  {saving ? 'Сохраняем…' : 'Назначить'}
                </button>
              </div>
            </div>
          </div>
        )}

        {toast && (
          <div className={`au-toast${toast.error ? ' au-toast--error' : ''}`} role="status">
            <span className="au-toast-check" aria-hidden>
              {toast.error ? '!' : '✓'}
            </span>
            {toast.text}
          </div>
        )}
      </div>
    </div>
  );
}

/** The admin chrome: brand → home, role eyebrow, and the current admin's monogram. */
function AdminHeader({ initial }: { initial: string }) {
  return (
    <header className="au-header">
      <Link className="au-brand" href="/" aria-label="GEOHOD — на главную">
        <span className="au-logo">G</span>
        <span className="au-brand-text">
          <span className="au-brand-name">GEOHOD</span>
          <span className="au-brand-sub">АДМИНКА</span>
        </span>
      </Link>
      <Link className="au-avatar" href="/profile" aria-label="Мой профиль">
        {initial}
      </Link>
    </header>
  );
}
