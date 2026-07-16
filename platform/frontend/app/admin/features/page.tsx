'use client';

import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../../lib/api';
import {
  availabilityNote,
  stateLabel,
  toAdminFeature,
  type AdminFeature,
} from '../../../lib/admin-features';
import { WspToggle } from '../../quest-editor/controls';
import AdminShell, { AdminGate, useAdminAccess } from '../shell';
import { AdminPageHead, AdminToast } from '../ui';

/**
 * Admin · Feature toggles: one row per registered flag (the registry lives in
 * backend code — features.rs), with an ARIA switch for the effective state, a
 * «сбросить» affordance while an override is stored, and an inline warning
 * when the feature is switched on but unconfigured on this deployment (the
 * toggle is then honest but inert). Mutations are per-row optimistic-free:
 * the row re-renders from the wire object the POST returns.
 */
export default function AdminFeaturesPage() {
  const access = useAdminAccess();
  const [features, setFeatures] = useState<AdminFeature[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (access !== 'granted') return;
    let cancelled = false;
    void api
      .adminListFeatures()
      .then((wire) => {
        if (!cancelled) {
          setFeatures(wire.map(toAdminFeature));
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

  const showToast = (text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  /** Store an override (flip) or clear it (`enabled: null` — back to default). */
  const applyChange = async (f: AdminFeature, enabled: boolean | null) => {
    setBusyKey(f.key);
    try {
      const wire = await api.adminSetFeature(f.key, enabled);
      const next = toAdminFeature(wire);
      setFeatures((list) => list.map((x) => (x.key === next.key ? next : x)));
      showToast(
        enabled === null
          ? `${next.label}: сброшено к значению по умолчанию`
          : `${next.label}: ${next.effective ? 'включено' : 'выключено'}`,
      );
    } catch {
      showToast('Не удалось сохранить изменение');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <AdminShell active="features">
      <AdminGate access={access}>
        <div className="ap-root">
          <main className="ap-main ap-main--narrow">
            <AdminPageHead
              eyebrow="УПРАВЛЕНИЕ"
              title="Функции"
              lede="Включение и выключение возможностей платформы на лету. Список функций задаётся кодом; здесь хранится только переопределение — сброшенная функция возвращается к значению по умолчанию."
            />

            {loadError ? (
              <div className="af-list">
                <div className="af-empty">
                  Не удалось загрузить список функций. Проверьте соединение и обновите страницу.
                </div>
              </div>
            ) : (
              <div className="af-list">
                {features.map((f) => (
                  <FeatureRow
                    key={f.key}
                    feature={f}
                    busy={busyKey === f.key}
                    onToggle={() => void applyChange(f, !f.effective)}
                    onReset={() => void applyChange(f, null)}
                  />
                ))}
              </div>
            )}
          </main>

          {toast && <AdminToast text={toast} />}
        </div>
      </AdminGate>
    </AdminShell>
  );
}

/** One flag row: label + description on the left, state + switch on the right. */
function FeatureRow({
  feature: f,
  busy,
  onToggle,
  onReset,
}: {
  feature: AdminFeature;
  busy: boolean;
  onToggle: () => void;
  onReset: () => void;
}) {
  const note = availabilityNote(f);
  return (
    <div className={`af-row${f.effective ? '' : ' is-off'}`}>
      <div className="af-row__info">
        <div className="af-row__label">{f.label}</div>
        {f.description && <div className="af-row__desc">{f.description}</div>}
        {note && f.effective && <div className="af-row__note">{note}</div>}
      </div>
      <div className="af-row__controls">
        <span className="af-row__state">{stateLabel(f)}</span>
        {f.override !== null && (
          <button
            type="button"
            className="af-row__reset"
            disabled={busy}
            onClick={onReset}
          >
            сбросить
          </button>
        )}
        <WspToggle
          on={f.effective}
          onClick={onToggle}
          disabled={busy}
          ariaLabel={`${f.label}: ${f.effective ? 'включено' : 'выключено'}`}
        />
      </div>
    </div>
  );
}
