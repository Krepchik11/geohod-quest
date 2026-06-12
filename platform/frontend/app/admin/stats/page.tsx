'use client';
import AdminHeader from '../../AdminHeader';
import React, { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

/** Stats page - now wired to real /api/admin/versions/.../stats (design table + filters stub).
 * Uses mystery golden snapshot by default; after ctor publish + plays, real data populates via facts.
 * Per design: wrongs, hints, nav, feedbacks, completions per version.
 */
interface VersionStats {
  attempts_count?: number;
  completions_count?: number;
  completion_rate?: number;
  hints_used?: number;
  wrongs_submitted?: number;
  navigator_clicks?: number;
  feedback_count?: number;
  grants_count?: number;
  error?: string;
}

export default function StatsPage() {
  const [stats, setStats] = useState<VersionStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [snapId, setSnapId] = useState('mystery-fortress-v1');

  useEffect(() => {
    let cancelled = false;
    api.getVersionStats<VersionStats>(snapId)
      .then((s) => { if (!cancelled) setStats(s); })
      .catch(() => { if (!cancelled) setStats({ error: 'backend not running or no data; start backend + play quest to populate' }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [snapId]);

  return (
    <div className="admin">
      <AdminHeader active="stat" />
      <main className="container">
        <h1>Статистика прохождений</h1>
        <div className="st-filters">
          <select className="field-ui" value={snapId} onChange={e => { setLoading(true); setSnapId(e.target.value); }}>
            <option value="mystery-fortress-v1">mystery-fortress-v1</option>
            <option value="ironia-sudby-v1">ironia-sudby-v1 (demo)</option>
          </select>
          <select className="field-ui"><option>E-mail пользователя (stub)</option></select>
        </div>

        {loading && <p>Загрузка… (убедись что backend запущен и NEXT_PUBLIC_API_URL указывает на него, напр. http://localhost:8087)</p>}

        {stats && !stats.error && (
          <div>
            <table className="tbl st-table">
              <thead>
                <tr>
                  <th>Версия</th><th>Попыток</th><th>Завершено</th><th>Rate</th>
                  <th>Подсказок</th><th>Ошибок</th><th>Навигатор</th><th>Фидбеков</th>
                  <th>Грантов</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{snapId}</td>
                  <td>{stats.attempts_count ?? 0}</td>
                  <td>{stats.completions_count ?? 0}</td>
                  <td>{(stats.completion_rate ?? 0).toFixed(2)}</td>
                  <td>{stats.hints_used ?? 0}</td>
                  <td>{stats.wrongs_submitted ?? 0}</td>
                  <td>{stats.navigator_clicks ?? 0}</td>
                  <td>{stats.feedback_count ?? 0}</td>
                  <td>{stats.grants_count ?? 0}</td>
                </tr>
              </tbody>
            </table>

            <div className="mt-4 text-xs opacity-70">
              Per-step (wrongs/hints/nav/fb) available in stats.per_step when data present. Play quests + POST facts to populate.
            </div>
          </div>
        )}

        {stats?.error && <div className="text-red-600 text-sm mt-2">{stats.error}</div>}

        <p className="text-xs mt-6 opacity-60">Данные из чистых проекторов фактов (идемпотентно, negative OK, multi-device union). Соответствует design + SPEC.</p>
      </main>
    </div>
  );
}
