'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  api,
  type AdminStatsOverviewWire,
  type AdminStatsQuestWire,
} from '../../../lib/api';
import {
  CHART,
  RANGE_CHIPS,
  addDaysIso,
  boundsFor,
  fmtInt,
  funnelVm,
  kpisFor,
  overviewVm,
  periodLabel,
  questMetaLine,
  todayUtc,
  type ChartVm,
  type KpiVm,
  type StatsRangeKey,
} from '../../../lib/admin-stats';
import { AdminPageHead } from '../ui';

/**
 * Admin · Статистика (Admin Stats.dc.html): KPI cards + trend chart + the
 * per-quest table over a selectable period, and a per-quest drill-down with
 * the step funnel. All numbers are real backend aggregates
 * (`/api/admin/stats*`); the view-model math lives in lib/admin-stats.ts.
 */
export default function AdminStatsPage() {
  const [rangeKey, setRangeKey] = useState<StatsRangeKey>('30');
  const [customFrom, setCustomFrom] = useState(() => addDaysIso(todayUtc(), -29));
  const [customTo, setCustomTo] = useState(() => todayUtc());
  const [overview, setOverview] = useState<AdminStatsOverviewWire | null>(null);
  const [overviewError, setOverviewError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminStatsQuestWire | null>(null);
  const [detailError, setDetailError] = useState(false);

  // null while a custom date input is empty/half-typed: both effects then keep
  // the current data instead of firing a request for the wrong range.
  const bounds = useMemo(
    () => boundsFor(rangeKey, { from: customFrom, to: customTo }),
    [rangeKey, customFrom, customTo],
  );

  useEffect(() => {
    if (!bounds) return;
    let cancelled = false;
    void api
      .adminStatsOverview(bounds)
      .then((wire) => {
        if (!cancelled) {
          setOverview(wire);
          setOverviewError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setOverviewError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bounds]);

  // Selection transitions (open/back) reset detail state in the event
  // handlers below; this effect only synchronizes with the backend.
  useEffect(() => {
    if (!selectedId || !bounds) return;
    let cancelled = false;
    void api
      .adminStatsQuest(selectedId, bounds)
      .then((wire) => {
        if (!cancelled) {
          setDetail(wire);
          setDetailError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setDetailError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, bounds]);

  return (
    <main className="ap-main">
      {selectedId ? (
        <QuestDetail
          detail={detail}
          error={detailError}
          onBack={() => {
            setSelectedId(null);
            setDetail(null);
            setDetailError(false);
          }}
        />
      ) : (
        <Overview
          overview={overview}
          error={overviewError}
          rangeKey={rangeKey}
          onRange={setRangeKey}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFrom={setCustomFrom}
          onCustomTo={setCustomTo}
          onOpenQuest={(questId) => {
            setDetail(null);
            setDetailError(false);
            setSelectedId(questId);
          }}
        />
      )}
    </main>
  );
}

function RangeFilter({
  rangeKey,
  onRange,
  customFrom,
  customTo,
  onCustomFrom,
  onCustomTo,
}: {
  rangeKey: StatsRangeKey;
  onRange: (k: StatsRangeKey) => void;
  customFrom: string;
  customTo: string;
  onCustomFrom: (v: string) => void;
  onCustomTo: (v: string) => void;
}) {
  return (
    <div className="ast-filter">
      <span className="ast-filter__label">ПЕРИОД</span>
      {RANGE_CHIPS.map((chip) => (
        <button
          key={chip.key}
          type="button"
          className={`ast-chip${rangeKey === chip.key ? ' is-on' : ''}`}
          aria-pressed={rangeKey === chip.key}
          onClick={() => onRange(chip.key)}
        >
          {chip.label}
        </button>
      ))}
      {rangeKey === 'custom' && (
        <span className="ast-filter__dates">
          <input
            type="date"
            className="ast-date"
            aria-label="Начало периода"
            value={customFrom}
            onChange={(e) => onCustomFrom(e.target.value)}
          />
          <span className="ast-filter__dash">—</span>
          <input
            type="date"
            className="ast-date"
            aria-label="Конец периода"
            value={customTo}
            onChange={(e) => onCustomTo(e.target.value)}
          />
        </span>
      )}
    </div>
  );
}

function KpiCards({ kpis }: { kpis: KpiVm[] }) {
  return (
    <div className="ast-kpis">
      {kpis.map((kpi) => (
        <div className="ast-card ast-kpi" key={kpi.label}>
          <div className="ast-kpi__label">{kpi.label}</div>
          <div className="ast-kpi__value">{kpi.value}</div>
          <div className={`ast-kpi__delta is-${kpi.tone}`}>
            {kpi.delta}
            {kpi.deltaNote && <span className="ast-kpi__note"> {kpi.deltaNote}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Overview({
  overview,
  error,
  rangeKey,
  onRange,
  customFrom,
  customTo,
  onCustomFrom,
  onCustomTo,
  onOpenQuest,
}: {
  overview: AdminStatsOverviewWire | null;
  error: boolean;
  rangeKey: StatsRangeKey;
  onRange: (k: StatsRangeKey) => void;
  customFrom: string;
  customTo: string;
  onCustomFrom: (v: string) => void;
  onCustomTo: (v: string) => void;
  onOpenQuest: (questId: string) => void;
}) {
  const vm = overview ? overviewVm(overview) : null;
  return (
    <div>
      <AdminPageHead eyebrow="АНАЛИТИКА" title="Статистика" />

      <RangeFilter
        rangeKey={rangeKey}
        onRange={onRange}
        customFrom={customFrom}
        customTo={customTo}
        onCustomFrom={onCustomFrom}
        onCustomTo={onCustomTo}
      />

      {error ? (
        <div className="ast-error">
          Не удалось загрузить статистику. Проверьте соединение — данные обновятся при смене
          периода.
        </div>
      ) : !vm ? (
        <div className="ast-loading">
          <span className="ash-spinner" aria-label="Загрузка" />
        </div>
      ) : (
        <>
          <div className="ast-period">{vm.period}</div>
          <KpiCards kpis={vm.kpis} />
          {vm.chart && <TrendChart chart={vm.chart} />}
          <div className="ast-table-note">
            {vm.questsCount} · по убыванию стартов · нажмите на квест, чтобы увидеть конверсию по
            шагам
          </div>
          <div className="ast-card ast-table-card">
            <div className="ast-table">
              <div className="ast-table__head">
                <span>Квест</span>
                <span className="ast-num">Куплено</span>
                <span className="ast-num">Начато</span>
                <span className="ast-num">Завершено</span>
                <span>Завершаемость</span>
                <span />
              </div>
              {vm.rows.map((row) => (
                <button
                  key={row.questId}
                  type="button"
                  className="ast-table__row"
                  disabled={!row.published}
                  title={row.published ? undefined : 'Квест снят с публикации — воронка недоступна'}
                  onClick={() => onOpenQuest(row.questId)}
                >
                  <span className="ast-quest">
                    <span className="ast-quest__name">{row.name}</span>
                    <span className="ast-quest__meta">{row.meta}</span>
                  </span>
                  <span className="ast-num ast-strong">{row.purchased}</span>
                  <span className="ast-num ast-strong">{row.started}</span>
                  <span className="ast-num ast-strong">{row.finished}</span>
                  <span className="ast-completion">
                    <span className="ast-completion__line">
                      <span className={`ast-completion__pct${row.low ? ' is-low' : ''}`}>
                        {row.pct}%
                      </span>
                      <span className="ast-completion__note">{row.pctNote}</span>
                    </span>
                    <span className="ast-bar">
                      <span
                        className={`ast-bar__fill${row.low ? ' is-low' : ''}`}
                        style={{ width: `${row.pct}%` }}
                      />
                    </span>
                  </span>
                  <span className="ast-chevron" aria-hidden>
                    {row.published ? '›' : ''}
                  </span>
                </button>
              ))}
              {vm.rows.length === 0 && (
                <div className="ast-empty">Пока нет опубликованных квестов.</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function TrendChart({ chart }: { chart: ChartVm }) {
  return (
    <div className="ast-card ast-chart">
      <div className="ast-chart__head">
        <div className="ast-chart__title">Динамика</div>
        <div className="ast-chart__legend">
          <span>
            <span className="ast-dot ast-dot--started" />
            Начато
          </span>
          <span>
            <span className="ast-dot ast-dot--finished" />
            Завершено
          </span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        role="img"
        aria-label="График начатых и завершённых квестов по дням"
      >
        {chart.grid.map((g) => (
          <React.Fragment key={g.y}>
            <line x1={CHART.left} x2={CHART.right} y1={g.y} y2={g.y} stroke="#f0f1f4" strokeWidth={1} />
            <text x={CHART.left - 6} y={g.y + 3.5} textAnchor="end" fontSize={10.5} fill="#9a9ca3">
              {g.label}
            </text>
          </React.Fragment>
        ))}
        <path d={chart.area} fill="rgba(59,113,254,.07)" />
        <path
          d={chart.lineStarted}
          fill="none"
          stroke="#3b71fe"
          strokeWidth={2.2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d={chart.lineFinished}
          fill="none"
          stroke="#1f8a5b"
          strokeWidth={2.2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {chart.xLabels.map((xl) => (
          <text
            key={xl.x}
            x={xl.x}
            y={CHART.height - 6}
            textAnchor="middle"
            fontSize={10.5}
            fill="#9a9ca3"
          >
            {xl.label}
          </text>
        ))}
      </svg>
    </div>
  );
}

function QuestDetail({
  detail,
  error,
  onBack,
}: {
  detail: AdminStatsQuestWire | null;
  error: boolean;
  onBack: () => void;
}) {
  return (
    <div>
      <button type="button" className="ast-back" onClick={onBack}>
        <span aria-hidden>‹</span> ко всем квестам
      </button>
      {error ? (
        <div className="ast-error">
          Не удалось загрузить статистику квеста. Вернитесь к списку и попробуйте ещё раз.
        </div>
      ) : !detail ? (
        <div className="ast-loading">
          <span className="ash-spinner" aria-label="Загрузка" />
        </div>
      ) : (
        <DetailBody detail={detail} />
      )}
    </div>
  );
}

function DetailBody({ detail }: { detail: AdminStatsQuestWire }) {
  const funnel = funnelVm(detail);
  return (
    <>
      <AdminPageHead
        className="ast-head--detail"
        eyebrow="КОНВЕРСИЯ ПО ШАГАМ"
        title={detail.name}
        lede={`${questMetaLine({
          city: detail.city,
          pages: detail.pages,
          template_summary: detail.template_summary,
        })} · ${periodLabel(detail.from, detail.to)}`}
      />

      <KpiCards kpis={kpisFor(detail.totals, detail.prev)} />

      <div className="ast-card ast-funnel">
        <div className="ast-funnel__head">
          <div className="ast-funnel__title">Воронка шагов</div>
          {/* The funnel is a cohort over the CURRENT version's attempts; its
              denominator can be smaller than the all-versions «Начато» KPI, so
              both numbers are spelled out here. */}
          <div className="ast-funnel__hint">
            доля игроков, дошедших до шага · от {fmtInt(detail.funnel_started)} начавших на версии{' '}
            {detail.snapshot_version}
          </div>
        </div>
        <div className="ast-funnel__list">
          {funnel.steps.map((st) => (
            <div key={st.idx}>
              {st.drop && (
                <div className={`ast-drop is-${st.drop.tone}`}>
                  <span aria-hidden>↓</span>
                  <span>{st.drop.label}</span>
                  {st.isWorst && <span className="ast-drop__badge">наибольший отток</span>}
                </div>
              )}
              <div className="ast-step">
                <span className="ast-step__idx">{st.idx}</span>
                <span className="ast-step__body">
                  <span className="ast-step__line">
                    <span className="ast-step__name">{st.name}</span>
                    <span className="ast-step__template">{st.template}</span>
                  </span>
                  <span className="ast-step__bar">
                    <span
                      className={`ast-step__fill is-${st.tone}`}
                      style={{ width: `${st.barW}%` }}
                    />
                  </span>
                </span>
                <span className="ast-step__nums">
                  <span className="ast-step__count">{st.count}</span>
                  <span className="ast-step__pct">{st.pct}%</span>
                </span>
              </div>
            </div>
          ))}
          {funnel.steps.length === 0 && (
            <div className="ast-empty">Для текущей версии квеста нет данных о шагах.</div>
          )}
        </div>
        <div className="ast-funnel__summary">{funnel.summary}</div>
      </div>
    </>
  );
}
