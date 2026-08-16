'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, classify, isAuthFailure } from '../../lib/api';
import { AdminConfirmSheet, AdminPageHead, AdminToast } from './ui';
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
 * Admin · Users (admin-users spec) — a searchable, role-filterable list → tap →
 * profile with a role editor, a confirm sheet, and a success toast. Wears the
 * shared admin-page scaffolding (app/admin/ui.tsx + styles/admin-page.css) under
 * the unified shell, like every other tab; the master-detail split is its own
 * (styles/admin-users.css).
 *
 * Access is gated twice: the backend authorizes every /api/admin/* call (role==admin
 * session OR the shared ADMIN_TOKEN), and the route layout (app/admin/layout.tsx)
 * checks /api/users/me up front so non-admins see a clear "no access" screen
 * instead of an empty list — pages only mount once access is granted. The operator
 * path (NEXT_PUBLIC_ADMIN_TOKEN configured) is admitted so the very first admin
 * can be promoted before any admin account exists.
 *
 * Reality vs. the prototype: the backend models email + display_name + role + join
 * date only (no telegram/phone/last-active), so contact rows render present-only.
 * liveSearch + a confirm-before-apply sheet are both on (the safer, complete flow).
 */

type ListError = 'none' | 'auth' | 'network';
type Toast = { text: string; error?: boolean };

function errorKind(err: unknown): 'auth' | 'network' {
  return isAuthFailure(err) ? 'auth' : 'network';
}

export default function AdminUsersPage() {
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

  // Load the user list on mount — the layout gate mounts pages only when
  // access is granted.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
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
      const f = classify(err);
      if (f.kind === 'rejected' && f.status === 409) showToast('Нельзя изменить свою роль', true);
      else if (f.kind === 'not-found') showToast('Пользователь не найден', true);
      else showToast('Не удалось обновить роль', true);
    } finally {
      setSaving(false);
    }
  }, [selected, draftRole, showToast]);

  const save = () => {
    if (!canSave) return;
    setConfirmOpen(true);
  };

  // ---- list or detail (chrome + gate live in the route layout) -----------
  return (
    <main className="ap-main">
      <AdminPageHead eyebrow="УПРАВЛЕНИЕ" title="Пользователи" />
      {/* §10.3: ≥1024px master-detail — list left (460px, selected row gets a
          blue bar), profile right; below 1024 the panes swap like screens. */}
      <div className={`au-split${selected ? ' has-selected' : ''}`}>
        <div className="au-main au-pane au-pane--list">
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
        </div>
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
        <AdminConfirmSheet
          label="Сменить роль"
          title="Сменить роль?"
          text={`${titleOf(selected)} получит роль «${ROLE_LABELS[draftRole]}». Доступ изменится сразу.`}
          applyLabel="Назначить"
          busyLabel="Сохраняем…"
          busy={saving}
          onCancel={() => setConfirmOpen(false)}
          onApply={() => void applyRole()}
        />
      )}

      {toast && <AdminToast text={toast.text} error={toast.error} />}
    </main>
  );
}
