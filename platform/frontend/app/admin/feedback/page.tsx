'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { api, type AdminFeedbackGroupWire, type AdminReportWire } from '../../../lib/api';
import {
  identityBadge,
  identityName,
  plural,
  questFilterOptions,
  relativeTime,
  templateLabel,
} from '../../../lib/admin-moderation';
import AdminShell, { AdminGate, useAdminAccess } from '../shell';
import { AdminPageHead, AdminToast, useToast } from '../ui';
import { ContactRow } from '../moderation-ui';

/**
 * Admin · Обратная связь (content-moderation). Every player error report, grouped
 * by (quest, version, step) — the step bound to its frozen snapshot. Marking a
 * group resolved acknowledges its current reports; a new report reopens it (the
 * count watermark lives server-side). Past-version groups collapse into an archive.
 */

type StatusFilter = 'open' | 'resolved' | 'all';

const STATUS_CHIPS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'open', label: 'Открытые' },
  { value: 'resolved', label: 'Решённые' },
  { value: 'all', label: 'Все' },
];

function groupKey(g: AdminFeedbackGroupWire): string {
  return `${g.quest_id} ${g.snapshot_id} ${g.step_position}`;
}

export default function AdminFeedbackPage() {
  const access = useAdminAccess();
  const [groups, setGroups] = useState<AdminFeedbackGroupWire[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [quest, setQuest] = useState('all');
  const [status, setStatus] = useState<StatusFilter>('open');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [archiveOpen, setArchiveOpen] = useState(false);
  const { toast, showToast } = useToast();

  useEffect(() => {
    if (access !== 'granted') return;
    let cancelled = false;
    void api
      .adminListFeedback()
      .then((r) => {
        if (!cancelled) setGroups(r.groups);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [access]);

  const setResolved = (target: AdminFeedbackGroupWire, resolved: boolean) =>
    setGroups((gs) =>
      (gs ?? []).map((g) => (groupKey(g) === groupKey(target) ? { ...g, resolved } : g)),
    );

  const toggleResolved = async (g: AdminFeedbackGroupWire) => {
    const next = !g.resolved;
    const body = {
      quest_id: g.quest_id,
      snapshot_id: g.snapshot_id,
      step_position: g.step_position,
    };
    try {
      if (next) await api.adminResolveFeedback(body);
      else await api.adminReopenFeedback(body);
      setResolved(g, next);
      showToast(next ? 'Группа отмечена решённой' : 'Группа снова открыта');
    } catch {
      showToast('Не удалось изменить статус');
    }
  };

  const questOptions = useMemo(() => questFilterOptions(groups ?? []), [groups]);

  const inQuest = (g: AdminFeedbackGroupWire) => quest === 'all' || g.quest_id === quest;
  const matchesStatus = (g: AdminFeedbackGroupWire) =>
    status === 'all' || (status === 'open' ? !g.resolved : g.resolved);

  const current = (groups ?? []).filter((g) => g.current && inQuest(g));
  const openCount = current.filter((g) => !g.resolved).length;
  const resolvedCount = current.filter((g) => g.resolved).length;
  const currentShown = current.filter(matchesStatus);
  const archive = (groups ?? []).filter((g) => !g.current && inQuest(g) && matchesStatus(g));

  return (
    <AdminShell active="feedback">
      <AdminGate access={access}>
        <div className="ap-root">
          <main className="ap-main">
            <AdminPageHead
              eyebrow="МОДЕРАЦИЯ"
              title="Обратная связь"
              lede="Сообщения об ошибках от игроков, сгруппированные по шагу и версии квеста. Отметьте группу решённой — новое сообщение откроет её заново."
            />

            {loadError ? (
              <div className="amod-error">
                Не удалось загрузить обращения. Обновите страницу позже.
              </div>
            ) : !groups ? (
              <div className="amod-loading">
                <span className="ash-spinner" aria-label="Загрузка" />
              </div>
            ) : (
              <>
                <div className="amod-filters">
                  <span className="amod-filters__label">КВЕСТ</span>
                  <select
                    className="amod-select"
                    aria-label="Квест"
                    value={quest}
                    onChange={(e) => setQuest(e.target.value)}
                  >
                    {questOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <span className="amod-filters__label">СТАТУС</span>
                  {STATUS_CHIPS.map((chip) => (
                    <button
                      key={chip.value}
                      type="button"
                      className={`amod-chip${status === chip.value ? ' is-on' : ''}`}
                      aria-pressed={status === chip.value}
                      onClick={() => setStatus(chip.value)}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>

                <div className="amod-count">
                  Открытых: {openCount} · Решённых: {resolvedCount}
                </div>

                <div className="amod-banner" role="note">
                  <span aria-hidden>ⓘ</span>
                  <span>
                    Сообщения сгруппированы по шагу и версии квеста (шаг привязан к замороженному
                    снапшоту). Отметка «решено» закрывает всю группу; новое сообщение по этому шагу
                    открывает её заново.
                  </span>
                </div>

                <div className="amod-list">
                  {currentShown.map((g) => (
                    <FeedbackGroup
                      key={groupKey(g)}
                      group={g}
                      expanded={!!expanded[groupKey(g)]}
                      onToggle={() =>
                        setExpanded((e) => ({ ...e, [groupKey(g)]: !e[groupKey(g)] }))
                      }
                      onResolveToggle={() => void toggleResolved(g)}
                    />
                  ))}
                  {currentShown.length === 0 && (
                    <div className="amod-empty">Нет обращений по выбранному фильтру.</div>
                  )}
                </div>

                {archive.length > 0 && (
                  <div className="amod-archive">
                    <button
                      type="button"
                      className="amod-archive__toggle"
                      aria-expanded={archiveOpen}
                      onClick={() => setArchiveOpen((v) => !v)}
                    >
                      <span aria-hidden>{archiveOpen ? '▾' : '▸'}</span>
                      Архив прошлых версий · {archive.length}
                      <span className="amod-archive__rule" />
                    </button>
                    {archiveOpen && (
                      <div className="amod-list">
                        {archive.map((g) => (
                          <FeedbackGroup
                            key={groupKey(g)}
                            group={g}
                            archived
                            expanded={!!expanded[groupKey(g)]}
                            onToggle={() =>
                              setExpanded((e) => ({ ...e, [groupKey(g)]: !e[groupKey(g)] }))
                            }
                            onResolveToggle={() => void toggleResolved(g)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </main>
        </div>
        {toast && <AdminToast text={toast} />}
      </AdminGate>
    </AdminShell>
  );
}

function FeedbackGroup({
  group,
  expanded,
  archived = false,
  onToggle,
  onResolveToggle,
}: {
  group: AdminFeedbackGroupWire;
  expanded: boolean;
  archived?: boolean;
  onToggle: () => void;
  onResolveToggle: () => void;
}) {
  const count = group.reports.length;
  const metaLine = [
    group.quest_name,
    group.quest_city,
    group.version != null ? `v${group.version}` : null,
    `${count} ${plural(count, 'сообщение', 'сообщения', 'сообщений')}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`amod-group${archived ? ' is-archived' : ''}`}>
      <button type="button" className="amod-group__head" onClick={onToggle} aria-expanded={expanded}>
        <span className={`amod-group__count${group.resolved ? ' is-resolved' : ''}`}>{count}</span>
        <span className="amod-group__body">
          <span className="amod-group__line">
            <span className="amod-group__title">
              Шаг {group.step_position} · {group.step_title ?? 'шаг'}
            </span>
            <span className="amod-group__tmpl">{templateLabel(group.step_template)}</span>
          </span>
          <span className="amod-group__meta">{metaLine}</span>
        </span>
        <span className={`amod-status amod-status--${group.resolved ? 'resolved' : 'open'}`}>
          {group.resolved ? 'РЕШЕНО' : 'ОТКРЫТО'}
        </span>
        <span className="amod-group__chevron" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div className="amod-group__detail">
          {group.reports.map((rep, i) => (
            <ReportRow key={`${rep.identity.player_id}-${rep.recorded_at}-${i}`} report={rep} />
          ))}
          <div className="amod-group__actions">
            <button
              type="button"
              className={`amod-btn${group.resolved ? '' : ' amod-btn--resolve'}`}
              onClick={onResolveToggle}
            >
              {group.resolved ? 'Открыть заново' : 'Отметить решённым'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReportRow({ report }: { report: AdminReportWire }) {
  const badge = identityBadge(report.identity.kind);
  return (
    <div className="amod-report">
      <div className="amod-report__body">
        <div className="amod-report__head">
          <span className="amod-report__name">{identityName(report.identity)}</span>
          <span className={`amod-badge amod-badge--${badge.kind}`}>{badge.label}</span>
          <span className="amod-report__when">{relativeTime(report.recorded_at)}</span>
        </div>
        <p className="amod-report__note">{report.note}</p>
      </div>
      <ContactRow identity={report.identity} report />
    </div>
  );
}
