'use client';

import React, { useEffect, useState } from 'react';
import AdminHeader from '../AdminHeader';
import ConfirmModal from '../components/ConfirmModal';
import Link from 'next/link';
import { api } from '../../lib/api';

/**
 * Cabinet - now live-wired to backend /api/quests (published) + /api/grants (owned).
 * Matches design/admin/Кабинет.html list + filters + create + run (with grant).
 * After ctor publish + checkout, quests appear here. "Запустить" opens player (grant checked in player).
 * Delete is local UI only (real would call backend; YAGNI for demo).
 */
interface Quest {
  quest_id?: string;
  id?: string;
  name?: string;
  snapshot_version?: number;
}

interface Grant {
  quest_id?: string;
}

export default function CabinetPage() {
  const [quests, setQuests] = useState<Quest[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<Quest | null>(null);
  const [showEmpty, setShowEmpty] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.listQuests().catch(() => [{ quest_id: 'mystery-fortress-v1', name: 'Mystery of the Fortress (seed)', snapshot_version: 1 }]),
      api.listGrants ? api.listGrants().catch(() => []) : Promise.resolve([]),
    ]).then(([q, g]) => {
      setQuests(Array.isArray(q) ? q : []);
      setGrants(Array.isArray(g) ? g : []);
    }).finally(() => setLoading(false));
  }, []);

  const filtered = showEmpty ? [] : quests;

  const hasGrant = (qid: string) => grants.some((g) => g.quest_id === qid);

  const doDelete = () => {
    if (deleteTarget) {
      setQuests(qs => qs.filter((q) => (q.quest_id || q.id) !== (deleteTarget.quest_id || deleteTarget.id)));
      setDeleteTarget(null);
    }
  };

  return (
    <div className="admin min-h-screen bg-[var(--bg-light)]">
      <AdminHeader active="kvesty" />

      <main className="container">
        <section className="welcome">
          <h1>Добро пожаловать!</h1>
          <Link href="/quest-editor" className="btn-ui" style={{ minWidth: 218, marginTop: 60, display: 'inline-flex' }}>Создать новый квест</Link>
          <p className="helper">Здесь Вы можете создавать новые квесты или управлять ранее созданными. Данные из backend (publish + grants).</p>
        </section>

        <section className="filters">
          <div className="filter">
            <h2 className="h-label">Фильтр по автору:</h2>
            <select className="field-ui"><option>Все</option><option>Сергей Шестак</option></select>
          </div>
          <div className="filter">
            <h2 className="h-label">Фильтр по статусу:</h2>
            <select className="field-ui"><option>Все</option><option>Опубликован</option><option>Проект</option><option>Тест</option></select>
          </div>
        </section>

        <h2 className="h-label quests-title">Созданные квесты:</h2>

        {loading && <p className="text-xs">Загрузка из backend…</p>}

        <div className="list-card quest-list">
          {filtered.length === 0 && <div className="empty-state" style={{ display: 'block' }}>У вас пока нет созданных квестов. Нажмите «Создать новый квест», чтобы начать. (Опубликуйте из конструктора — появится здесь.)</div>}
          {filtered.map((q) => {
            const qid = q.quest_id || q.id || 'mystery-fortress-v1';
            const name = q.name || q.quest_id || 'Quest';
            const owned = hasGrant(qid);
            return (
              <div key={qid} className="list-row" data-name={name}>
                <span className="list-row__name">“{name}” v{q.snapshot_version || 1}</span>
                <span className="quest-row__status select-wrap">
                  <select className="field-ui" defaultValue={owned ? 'Опубликован' : 'Проект'}>
                    <option>Опубликован</option><option>Проект</option><option>Тест</option>
                  </select>
                </span>
                <Link href="/quest-editor" className="btn-ui">Редактировать</Link>
                <Link href={`/quest/${qid}`} className="btn-ui btn-ui--outline">Запустить</Link>
                <button className="btn-ui btn-ui--ghost-danger" onClick={() => setDeleteTarget(q)}>Удалить</button>
              </div>
            );
          })}
        </div>

        <div className="mt-6 text-xs opacity-60">Гранты/owned из /api/grants. После /api/checkout или publish квесты видны. Полная синхронизация с фактами в плеере.</div>
      </main>

      <ConfirmModal
        open={!!deleteTarget}
        message={<>Внимание! Вы подтверждаете удаление квеста <b>“{deleteTarget?.name || deleteTarget?.quest_id}”</b>?</>}
        onConfirm={doDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <button className="state-toggle" onClick={() => setShowEmpty(!showEmpty)}>
        {showEmpty ? 'Показать список квестов' : 'Показать пустое состояние'}
      </button>
    </div>
  );
}
