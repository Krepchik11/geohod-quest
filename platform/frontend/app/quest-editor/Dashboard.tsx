'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import type { ConstructorQuestWire, CtorStatus } from '../../lib/api';
import {
  AGE_TARGET_LABEL,
  COMPLEXITY_LABEL,
  type CtorAgeTarget,
  type CtorComplexity,
} from '../../lib/constructor-model';
import QuestFilters, { matchesAttrs, type QuestFiltersValue } from '../components/QuestFilters';
import UserMenu from '../components/UserMenu';
import StatusControl from './StatusControl';

/**
 * Конструктор-дашборд — главная страница конструктора. Точный порт дизайна
 * «Quest Constructor Dashboard.dc.html» (claude.ai/design): шапка «на главную ·
 * заголовок · профиль», приветствие + «создать», фильтры (поиск/автор/статус),
 * список созданных квестов с редактируемым статусом и действиями
 * (редактировать/запустить/дублировать/удалить), модалка удаления и тосты.
 *
 * Презентационный: данные и операции (API) живут в Workspace; здесь — фильтрация,
 * меню профиля, подтверждение удаления и собственная локальная разметка.
 */

const STATUS_LABEL: Record<CtorStatus, string> = {
  published: 'Опубликован',
  test: 'Тест',
  draft: 'Проект',
};
/** Детерминированный градиент-«обложка» по названию (как в дизайне). */
function thumbBg(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 42% 60%), hsl(${(h + 38) % 360} 48% 44%))`;
}

function fmtDate(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  if (Number.isNaN(d.getTime()) || unixSecs <= 0) return '—';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/* ---------- мелкие иконки (инлайн SVG из дизайна) ---------- */
const IconUser = ({ s = '#9098a6' }: { s?: string }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3" stroke={s} strokeWidth="1.7" /><path d="M6 19c0-3 2.7-5 6-5s6 2 6 5" stroke={s} strokeWidth="1.7" /></svg>
);
const IconDoc = ({ s = '#9098a6' }: { s?: string }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="4" y="3" width="16" height="18" rx="2" stroke={s} strokeWidth="1.7" /><path d="M8 8h8M8 12h8M8 16h5" stroke={s} strokeWidth="1.7" strokeLinecap="round" /></svg>
);
const IconCheck = ({ s = '#9098a6' }: { s?: string }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke={s} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const IconCal = ({ s = '#9098a6' }: { s?: string }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="2" stroke={s} strokeWidth="1.7" /><path d="M3 9h18M8 3v4M16 3v4" stroke={s} strokeWidth="1.7" strokeLinecap="round" /></svg>
);

export interface DashboardActions {
  onCreate: () => void;
  onEdit: (id: string) => void;
  onRun: (q: ConstructorQuestWire) => void;
  onDuplicate: (q: ConstructorQuestWire) => void;
  onDelete: (q: ConstructorQuestWire) => void;
  onStatusChange: (q: ConstructorQuestWire, status: CtorStatus) => void;
  /** §9.1: draft→test/published without a snapshot routes into the publish panel. */
  onOpenPublish: (q: ConstructorQuestWire) => void;
}

export interface DashboardProps {
  quests: ConstructorQuestWire[];
  loading: boolean;
  error: string | null;
  toast: string | null;
  actions: DashboardActions;
}

const EMPTY_FILTERS: QuestFiltersValue = {
  search: '',
  status: 'Все',
  complexity: '',
  age: '',
  tag: '',
};

export default function Dashboard({
  quests,
  loading,
  error,
  toast,
  actions,
}: DashboardProps) {
  const [filters, setFilters] = useState<QuestFiltersValue>(EMPTY_FILTERS);
  const [deleteTarget, setDeleteTarget] = useState<ConstructorQuestWire | null>(null);

  // The dashboard is a personal workspace: the server returns ONLY the acting
  // author's quests, so there is no author filter (it could only ever pick
  // "yourself"). Search + status + attributes are the meaningful filters.
  const filtered = useMemo(() => {
    const q0 = filters.search.trim().toLowerCase();
    return quests.filter(
      (q) =>
        (filters.status === 'Все' || STATUS_LABEL[q.status] === filters.status) &&
        matchesAttrs(filters, q) &&
        (q0 === '' || q.name.toLowerCase().includes(q0) || q.author.toLowerCase().includes(q0)),
    );
  }, [quests, filters]);

  // The tag filter offers exactly the tags that exist across the author's
  // quests (sorted for a stable menu) — never a hardcoded list.
  const allTags = useMemo(
    () => Array.from(new Set(quests.flatMap((q) => q.tags))).sort((a, b) => a.localeCompare(b, 'ru')),
    [quests],
  );

  const clearFilters = () => setFilters(EMPTY_FILTERS);

  const showEmpty = !loading && quests.length === 0;
  const showNoResults = !loading && quests.length > 0 && filtered.length === 0;
  const showList = !loading && filtered.length > 0;

  return (
    <div className="qcd-root">
      {/* ===== Шапка ===== */}
      <header className="qcd-header">
        <Link href="/" className="qcd-home" aria-label="На главную">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M19 12H5M5 12l7-7M5 12l7 7" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          На главную
        </Link>

        <div className="qcd-brand">
          <span className="qcd-brand__mark">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 21s7-6.4 7-11a7 7 0 10-14 0c0 4.6 7 11 7 11z" stroke="#fff" strokeWidth="1.7" /><circle cx="12" cy="10" r="2.4" stroke="#fff" strokeWidth="1.7" /></svg>
          </span>
          <span className="qcd-brand__name">Конструктор квестов</span>
        </div>

        <UserMenu siteLink />
      </header>

      <main className="qcd-main">
        {/* §9.3: заголовок страницы + создание — без Prata-приветствия. */}
        <div className="qcd-pagehead">
          <h1 className="qcd-pagehead__title">Ваши квесты</h1>
          <button className="qcd-create" type="button" onClick={actions.onCreate}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="#fff" strokeWidth="2" strokeLinecap="round" /></svg>
            Создать новый квест
          </button>
        </div>

        {error ? <div className="qcd-error-banner">{error}</div> : null}

        {/* ===== Фильтры ===== */}
        <QuestFilters
          value={filters}
          onChange={setFilters}
          tags={allTags}
          statusOptions={['Все', 'Опубликован', 'Тест', 'Проект']}
          searchPlaceholder="Название или автор…"
        />

        {/* ===== Заголовок секции ===== */}
        <div className="qcd-sechead">
          <h2>Созданные квесты</h2>
          <span className="qcd-sechead__count">
            Показано {filtered.length} из {quests.length}
          </span>
        </div>

        {/* ===== Загрузка ===== */}
        {loading ? (
          <div className="qcd-listcard">
            {[0, 1, 2].map((i) => (
              <div className="qcd-skelrow" key={i}>
                <div className="qcd-skel" style={{ width: 64, height: 52, borderRadius: 9 }} />
                <div style={{ flex: 1 }}>
                  <div className="qcd-skel" style={{ width: '46%', height: 15 }} />
                  <div className="qcd-skel" style={{ width: '64%', height: 11, marginTop: 11, background: '#f1f2f5' }} />
                </div>
                <div className="qcd-skel" style={{ width: 150, height: 44, borderRadius: 10 }} />
                <div className="qcd-skel" style={{ width: 220, height: 44, borderRadius: 10, background: '#f1f2f5' }} />
              </div>
            ))}
          </div>
        ) : null}

        {/* ===== Пусто (нет ни одного квеста) ===== */}
        {showEmpty ? (
          <div className="qcd-empty">
            <div className="qcd-empty__icon">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none"><rect x="4" y="3" width="16" height="18" rx="2.5" stroke="var(--blue)" strokeWidth="1.7" /><path d="M8 8h8M8 12h8M8 16h5" stroke="var(--blue)" strokeWidth="1.7" strokeLinecap="round" /></svg>
            </div>
            <div className="qcd-empty__title">Пока ни одного квеста</div>
            <p className="qcd-empty__text">
              Создайте первый квест — он сразу получит «Первый экран» и
              «Поздравление», а затем появится в этом списке.
            </p>
            <button className="qcd-empty__btn" type="button" onClick={actions.onCreate}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="#fff" strokeWidth="2" strokeLinecap="round" /></svg>
              Создать новый квест
            </button>
          </div>
        ) : null}

        {/* ===== Ничего не найдено (фильтры) ===== */}
        {showNoResults ? (
          <div className="qcd-empty">
            <svg width="52" height="52" viewBox="0 0 24 24" fill="none" style={{ margin: '0 auto' }}><circle cx="11" cy="11" r="7" stroke="#c2c7d0" strokeWidth="1.6" /><path d="M20 20l-4-4" stroke="#c2c7d0" strokeWidth="1.6" strokeLinecap="round" /></svg>
            <div className="qcd-empty__title" style={{ fontSize: 19, marginTop: 16 }}>Ничего не найдено</div>
            <p className="qcd-empty__text" style={{ marginTop: 8 }}>
              Попробуйте изменить условия поиска или сбросить фильтры.
            </p>
            <button className="qcd-empty__clear" type="button" onClick={clearFilters}>Сбросить фильтры</button>
          </div>
        ) : null}

        {/* ===== Список ===== */}
        {showList ? (
          <div className="qcd-listcard">
            {filtered.map((q) => {
              const published = q.status === 'published';
              return (
                <div className="qcd-row" key={q.quest_id}>
                  <div className="qcd-thumb" style={{ background: thumbBg(q.name) }}>
                    <span>{(q.name[0] || '?').toUpperCase()}</span>
                  </div>
                  <div className="qcd-row__body">
                    <div className="qcd-row__name">{q.name}</div>
                    <div className="qcd-row__meta">
                      <span><IconUser />{q.author}</span>
                      <span><IconDoc />{q.steps} стр.</span>
                      <span><IconCheck />{q.completed} прох.</span>
                      <span><IconCal />{fmtDate(q.created_at)}</span>
                      <span>{COMPLEXITY_LABEL[q.complexity as CtorComplexity] ?? q.complexity}</span>
                      <span>{AGE_TARGET_LABEL[q.age_target as CtorAgeTarget] ?? q.age_target}</span>
                      {q.tags.length ? <span>{q.tags.join(' · ')}</span> : null}
                    </div>
                  </div>
                  <StatusControl
                    quest={q}
                    onStatusChange={(status) => actions.onStatusChange(q, status)}
                    onOpenPublish={() => actions.onOpenPublish(q)}
                  />
                  <div className="qcd-actions">
                    <button className="qcd-btn-edit" type="button" onClick={() => actions.onEdit(q.quest_id)}>Редактировать</button>
                    <button
                      className="qcd-btn-run"
                      type="button"
                      title={published ? 'Запустить опубликованную версию (как видит игрок)' : 'Тестовый прогон черновика в редакторе'}
                      onClick={() => actions.onRun(q)}
                    >
                      Запустить
                    </button>
                    <button className="qcd-iconbtn" type="button" title="Дублировать" onClick={() => actions.onDuplicate(q)}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="#1a2b48" strokeWidth="1.6" /><path d="M5 15V5a2 2 0 012-2h8" stroke="#1a2b48" strokeWidth="1.6" /></svg>
                    </button>
                    <button className="qcd-iconbtn qcd-iconbtn--danger" type="button" title="Удалить" onClick={() => setDeleteTarget(q)}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 7h14M10 7V5a1 1 0 011-1h2a1 1 0 011 1v2M8 7l1 12a1 1 0 001 1h4a1 1 0 001-1l1-12" stroke="#e75a7c" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </main>

      {/* ===== Модалка удаления ===== */}
      {deleteTarget ? (
        <div className="qcd-ovl" onClick={() => setDeleteTarget(null)}>
          <div className="qcd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="qcd-modal__icon">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M5 7h14M10 7V5a1 1 0 011-1h2a1 1 0 011 1v2M8 7l1 12a1 1 0 001 1h4a1 1 0 001-1l1-12" stroke="#e75a7c" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </div>
            <h3>Удалить квест?</h3>
            <p>
              Квест «{deleteTarget.name}» будет удалён без возможности восстановления,
              вместе со всеми его страницами и черновиками.
            </p>
            <div className="qcd-modal__row">
              <button className="qcd-modal__cancel" type="button" onClick={() => setDeleteTarget(null)}>Отмена</button>
              <button
                className="qcd-modal__confirm"
                type="button"
                onClick={() => {
                  const target = deleteTarget;
                  setDeleteTarget(null);
                  actions.onDelete(target);
                }}
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ===== Тост ===== */}
      {toast ? <div className="qcd-toast">{toast}</div> : null}
    </div>
  );
}
