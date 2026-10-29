'use client';

import React, { useId, useState } from 'react';
import type { ConstructorQuestWire, CtorStatus } from '../../lib/api';
import type { CtorQuest } from '../../lib/constructor-model';
import {
  TILE_SORTS,
  TILE_TABS,
  readTileView,
  tabCounts,
  tileCities,
  visibleTiles,
  writeTileView,
  type TileSort,
  type TileTab,
  type TileView,
} from '../../lib/quest-tiles';
import SpaceHeader from '../components/SpaceHeader';
import { DeleteQuestModal } from './Dashboard';
import QuestTile, { type TileActions } from './QuestTile';
import QuickSettings, { type QuickSettingsPatch } from './QuickSettings';

export interface QuestTilesActions {
  onCreate: () => void;
  onEdit: (id: string) => void;
  onRun: (q: ConstructorQuestWire) => void;
  onDuplicate: (q: ConstructorQuestWire) => void;
  onDelete: (q: ConstructorQuestWire) => void;
  onStatusChange: (q: ConstructorQuestWire, status: CtorStatus) => void;
  onOpenPublish: (q: ConstructorQuestWire) => void;
  onCopyLink: (q: ConstructorQuestWire) => void;
  onExport: (q: ConstructorQuestWire) => void;
  onTransfer?: (q: ConstructorQuestWire) => void;
  /** Свежий черновик для быстрых настроек. */
  loadQuest: (id: string) => Promise<CtorQuest>;
  saveSettings: (q: ConstructorQuestWire, patch: QuickSettingsPatch) => Promise<void>;
}

const IconPlus = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
);
const IconSearch = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M20 20l-3.6-3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
);
const IconGrid = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden><rect x="4" y="4" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" /><rect x="13" y="4" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" /><rect x="4" y="13" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" /><rect x="13" y="13" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" /></svg>
);
const IconRows = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden><rect x="4" y="5" width="16" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.8" /><rect x="4" y="14" width="16" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.8" /></svg>
);

/**
 * Список квестов плитками (флаг ctor_tiles) — новый вид главной конструктора.
 * Вкладки статусов с «Требуют внимания», поиск, город, сортировка («Недавно
 * изменённые» по умолчанию) и переключатель «Плитки / Строки», который браузер
 * запоминает. Данные и операции — в Workspace; здесь фильтры, меню и листы.
 */
export default function QuestTiles({
  quests,
  loading,
  error,
  toast,
  isAdmin,
  cities,
  actions,
}: {
  quests: ConstructorQuestWire[];
  loading: boolean;
  error: string | null;
  toast: string | null;
  isAdmin: boolean;
  /** Города администратора для быстрых настроек (флаг ctor_city_list). */
  cities?: readonly string[];
  actions: QuestTilesActions;
}) {
  const [tab, setTab] = useState<TileTab>('all');
  const [search, setSearch] = useState('');
  const [city, setCity] = useState('');
  const [sort, setSort] = useState<TileSort>('updated');
  const [view, setView] = useState<TileView>(readTileView);
  const [deleteTarget, setDeleteTarget] = useState<ConstructorQuestWire | null>(null);
  const [settingsFor, setSettingsFor] = useState<ConstructorQuestWire | null>(null);
  // «Изменён вчера» считается от момента загрузки страницы — без тиков таймера.
  const [nowMs] = useState(() => Date.now());
  const id = useId();

  const counts = tabCounts(quests);
  const cityList = tileCities(quests);
  const shown = visibleTiles(quests, { tab, search, city, sort });
  const filtered = tab !== 'all' || search.trim() !== '' || city !== '';

  const pickView = (v: TileView) => {
    setView(v);
    writeTileView(v);
  };
  const reset = () => {
    setTab('all');
    setSearch('');
    setCity('');
  };

  const tileActions: TileActions = {
    onEdit: actions.onEdit,
    onRun: actions.onRun,
    onStatusChange: actions.onStatusChange,
    onOpenPublish: actions.onOpenPublish,
    onSettings: setSettingsFor,
    onCopyLink: actions.onCopyLink,
    onDuplicate: actions.onDuplicate,
    onExport: actions.onExport,
    onTransfer: actions.onTransfer,
    onDelete: setDeleteTarget,
  };

  return (
    <div className="qcd-root qct-root">
      <SpaceHeader eyebrow="КОНСТРУКТОР" />

      <main className="qct-main">
        <div className="qct-head">
          <h1>Ваши квесты</h1>
          <button className="qct-create" type="button" onClick={actions.onCreate}>
            <IconPlus />
            <span className="qct-create__long">Создать квест</span>
            <span className="qct-create__short">Квест</span>
          </button>
        </div>

        <div className="qct-tabs" role="tablist" aria-label="Статус квестов">
          {TILE_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`qct-tab${t.key === 'attention' && counts.attention > 0 ? ' qct-tab--attention' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              <span className="qct-tab__count">{counts[t.key]}</span>
            </button>
          ))}
        </div>

        <div className="qct-tools">
          <label className="qct-search" htmlFor={`${id}-search`}>
            <IconSearch />
            <input
              id={`${id}-search`}
              type="search"
              placeholder="Название, город, тег"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          {cityList.length > 1 ? (
            <select
              className="input qct-tools__city"
              aria-label="Город"
              value={city}
              onChange={(e) => setCity(e.target.value)}
            >
              <option value="">Все города</option>
              {cityList.map((c) => (
                <option key={c.name} value={c.name}>{`${c.name} · ${c.count}`}</option>
              ))}
            </select>
          ) : null}
          <select
            className="input qct-tools__sort"
            aria-label="Сортировка"
            value={sort}
            onChange={(e) => setSort(e.target.value as TileSort)}
          >
            {TILE_SORTS.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
          <div className="qct-view" role="group" aria-label="Вид списка">
            <button type="button" aria-pressed={view === 'tiles'} title="Плитки" onClick={() => pickView('tiles')}>
              <IconGrid />
            </button>
            <button type="button" aria-pressed={view === 'rows'} title="Строки" onClick={() => pickView('rows')}>
              <IconRows />
            </button>
          </div>
        </div>

        {error ? <div className="qcd-error-banner">{error}</div> : null}

        {loading ? (
          <div className={`qct-grid${view === 'rows' ? ' qct-grid--rows' : ''}`} aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div className="qct-skel" key={i}>
                <div className="qct-skel__cover qcd-skel" />
                <div className="qct-skel__line qcd-skel" />
                <div className="qct-skel__line qct-skel__line--short qcd-skel" />
              </div>
            ))}
          </div>
        ) : quests.length === 0 ? (
          <div className="qcd-empty">
            <div className="qcd-empty__title">Пока ни одного квеста</div>
            <p className="qcd-empty__text">
              Создайте первый квест — он сразу получит «Первый экран» и «Поздравление»,
              а затем появится здесь плиткой.
            </p>
            <button className="qcd-empty__btn" type="button" onClick={actions.onCreate}>
              Создать квест
            </button>
          </div>
        ) : shown.length === 0 ? (
          <div className="qcd-empty">
            <div className="qcd-empty__title">Ничего не найдено</div>
            <p className="qcd-empty__text">
              {tab === 'attention' && !search && !city
                ? 'Ничего не ждёт публикации: правки дошли до игроков, а готовых черновиков нет.'
                : 'Попробуйте другое название или сбросьте фильтры.'}
            </p>
            {filtered ? (
              <button className="qcd-empty__clear" type="button" onClick={reset}>Сбросить фильтры</button>
            ) : null}
          </div>
        ) : (
          <div className={`qct-grid${view === 'rows' ? ' qct-grid--rows' : ''}`}>
            {shown.map((q) => (
              <QuestTile key={q.quest_id} q={q} actions={tileActions} isAdmin={isAdmin} nowMs={nowMs} />
            ))}
          </div>
        )}
      </main>

      {deleteTarget ? (
        <DeleteQuestModal
          quest={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            setDeleteTarget(null);
            actions.onDelete(deleteTarget);
          }}
        />
      ) : null}

      {settingsFor ? (
        <QuickSettings
          key={settingsFor.quest_id}
          row={settingsFor}
          load={() => actions.loadQuest(settingsFor.quest_id)}
          onSave={(patch) => actions.saveSettings(settingsFor, patch)}
          onClose={() => setSettingsFor(null)}
          cities={cities}
          isAdmin={isAdmin}
        />
      ) : null}

      {toast ? <div className="qcd-toast" role="status">{toast}</div> : null}
    </div>
  );
}
