'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  computeGates,
  duplicateQuest,
  duplicateStep as modelDuplicate,
  insertionIndex,
  newQuest,
  newStep,
  removeStep as modelRemove,
  reorderSteps,
  serializeDraft,
  uid,
  type CtorQuest,
  type CtorSelection,
  type CtorTemplate,
} from '../../lib/constructor-model';
import { api, ApiError, type ConstructorQuestWire, type CtorStatus } from '../../lib/api';
import { logoutAndReset } from '../../lib/session-actions';
import { BuilderScreen } from './Builder';
import Dashboard from './Dashboard';
import { TestOverlay } from './TestPlayer';

const AUTOSAVE_DEBOUNCE_MS = 350;

/**
 * Конструктор квестов — рабочее место. Список квестов теперь живёт на сервере
 * (constructor-quests): дашборд читает GET /api/constructor/quests, создание/
 * дублирование/удаление/смена статуса ходят в API, а открытие квеста подтягивает
 * полное тело (черновик) и редактирует его в билдере с автосейвом на сервер.
 *
 * Так список авторства/статусов/прохождений и кросс-устройство возможны вообще —
 * раньше черновики жили только в localStorage этого устройства. Билдер не изменён:
 * он по-прежнему получает один CtorQuest и набор действий.
 */

type Screen = 'list' | 'builder';

/** Безопасно привести серверное тело к CtorQuest (это тот же объект, что мы храним). */
function bodyToQuest(body: unknown, fallbackId: string): CtorQuest | null {
  if (!body || typeof body !== 'object') return null;
  const q = body as CtorQuest;
  if (!Array.isArray(q.steps) || !q.meta) return null;
  // Гарантируем согласованность id тела с серверным id (на случай рассинхрона).
  return { ...q, id: fallbackId };
}

export default function Workspace() {
  // ---- Список (дашборд) ----
  const [list, setList] = useState<ConstructorQuestWire[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [profileName, setProfileName] = useState('Редактор');
  const [profileRole, setProfileRole] = useState('editor');
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Билдер (один активный квест) ----
  const [screen, setScreen] = useState<Screen>('list');
  const [active, setActive] = useState<CtorQuest | null>(null);
  const [sel, setSel] = useState<CtorSelection | null>(null);
  const [saveOk, setSaveOk] = useState(true);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [justPublished, setJustPublished] = useState<number | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  // ---- Тест-игрок (оверлей) ----
  const [test, setTest] = useState<{ quest: CtorQuest; startPos: number } | null>(null);

  const showToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const errMessage = (e: unknown): string => {
    if (e instanceof ApiError) {
      if (e.status === 401 || e.status === 403) return 'Нет доступа — войдите под учётной записью редактора.';
      return 'Сервер недоступен — попробуйте ещё раз.';
    }
    return 'Не удалось связаться с сервером.';
  };

  const refreshList = useCallback(async () => {
    try {
      const quests = await api.listConstructorQuests();
      setList(quests);
      setListError(null);
    } catch (e) {
      setListError(errMessage(e));
    } finally {
      setListLoading(false);
    }
  }, []);

  // Mount: identity (for the profile menu) + the quest list.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await api.me();
        if (!cancelled) {
          setProfileName(me.display_name || me.email || 'Редактор');
          setProfileRole(me.role || 'editor');
        }
      } catch {
        /* keep defaults — the gate already granted access */
      }
      await refreshList();
    })();
    return () => {
      cancelled = true;
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [refreshList]);

  // Server autosave: persist the active draft (debounced) whenever it changes.
  // savedAt is NOT part of `active`, so updating it never retriggers this effect.
  useEffect(() => {
    if (!active) return;
    const quest = active;
    const t = setTimeout(() => {
      void api
        .saveConstructorQuest(quest.id, {
          name: quest.meta.title,
          cover: quest.meta.cover,
          steps_count: quest.steps.length,
          body: quest,
        })
        .then(() => {
          setSaveOk(true);
          setSavedAt(Date.now());
        })
        .catch(() => setSaveOk(false));
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [active]);

  const patchQuest = useCallback((fn: (q: CtorQuest) => CtorQuest) => {
    setActive((q) => (q ? fn(q) : q));
  }, []);

  // ---- Dashboard actions ----

  const createQuest = async () => {
    const q = newQuest({});
    try {
      await api.createConstructorQuest({
        quest_id: q.id,
        name: q.meta.title,
        cover: q.meta.cover,
        steps_count: q.steps.length,
        body: q,
      });
      setJustPublished(null);
      setPublishError(null);
      setSavedAt(null);
      setSaveOk(true);
      setActive(q);
      setSel({ type: 'page', id: q.steps[0].id });
      setScreen('builder');
    } catch (e) {
      showToast(errMessage(e));
    }
  };

  const openQuest = async (id: string) => {
    try {
      const full = await api.getConstructorQuest(id);
      const q = bodyToQuest(full.body, full.quest_id);
      if (!q) {
        showToast('Не удалось открыть квест — повреждённый черновик.');
        return;
      }
      setJustPublished(null);
      setPublishError(null);
      setSavedAt(q.lastSaved ?? null);
      setSaveOk(true);
      setActive(q);
      setSel(q.steps.length ? { type: 'page', id: q.steps[0].id } : { type: 'settings' });
      setScreen('builder');
    } catch (e) {
      showToast(errMessage(e));
    }
  };

  const runQuest = async (row: ConstructorQuestWire) => {
    try {
      const full = await api.getConstructorQuest(row.quest_id);
      const q = bodyToQuest(full.body, full.quest_id);
      if (!q) {
        showToast('Не удалось запустить квест — повреждённый черновик.');
        return;
      }
      setTest({ quest: q, startPos: 0 });
      showToast(
        row.status === 'published'
          ? `Запуск опубликованной версии: «${row.name}»`
          : `Тестовый прогон черновика: «${row.name}»`,
      );
    } catch (e) {
      showToast(errMessage(e));
    }
  };

  const duplicate = async (row: ConstructorQuestWire) => {
    try {
      const full = await api.getConstructorQuest(row.quest_id);
      const src = bodyToQuest(full.body, full.quest_id);
      if (!src) {
        showToast('Не удалось дублировать — повреждённый черновик.');
        return;
      }
      const copy = duplicateQuest(src, `q-${uid()}`);
      await api.createConstructorQuest({
        quest_id: copy.id,
        name: copy.meta.title,
        cover: copy.meta.cover,
        steps_count: copy.steps.length,
        body: copy,
      });
      await refreshList();
      showToast('Квест дублирован — копия создана как «Проект»');
    } catch (e) {
      showToast(errMessage(e));
    }
  };

  const deleteQuest = async (row: ConstructorQuestWire) => {
    const prev = list;
    setList((l) => l.filter((q) => q.quest_id !== row.quest_id)); // optimistic
    try {
      await api.deleteConstructorQuest(row.quest_id);
      showToast('Квест удалён');
    } catch (e) {
      setList(prev); // rollback
      showToast(errMessage(e));
    }
  };

  const changeStatus = async (row: ConstructorQuestWire, status: CtorStatus) => {
    const prev = list;
    setList((l) => l.map((q) => (q.quest_id === row.quest_id ? { ...q, status } : q))); // optimistic
    try {
      const updated = await api.setConstructorStatus(row.quest_id, status);
      setList((l) => l.map((q) => (q.quest_id === updated.quest_id ? updated : q)));
    } catch (e) {
      setList(prev); // rollback
      // «Тест»/«Опубликован» need a published version first: the backend coherence
      // guard returns 400 when no frozen snapshot exists. A bare status flip can't
      // put a quest in the store — publishing is the gated action in the editor — so
      // open the quest there instead of failing silently. (Delisting to «Проект»
      // never hits this.)
      if (e instanceof ApiError && e.status === 400 && status !== 'draft') {
        showToast('Сначала опубликуйте версию в редакторе — затем выберите статус.');
        void openQuest(row.quest_id);
      } else {
        showToast(errMessage(e));
      }
    }
  };

  const onLogout = () => {
    void logoutAndReset().finally(() => {
      window.location.href = '/';
    });
  };

  // ---- Builder actions ----

  const selectIn = (s: CtorSelection) => {
    if (s.type !== 'publish') {
      setJustPublished(null);
      setPublishError(null);
    }
    setSel(s);
  };

  const insertStep = (template: CtorTemplate) => {
    const step = newStep(template);
    setActive((q) => {
      if (!q) return q;
      const selectedId = sel?.type === 'page' ? sel.id : null;
      const arr = [...q.steps];
      arr.splice(insertionIndex(arr, selectedId, template), 0, step);
      return { ...q, steps: arr };
    });
    setSel({ type: 'page', id: step.id });
  };

  const removeStep = (id: string) => {
    if (!active) return;
    const r = modelRemove(active.steps, id);
    patchQuest((q) => ({ ...q, steps: r.steps }));
    setSel(r.nextSelectedId ? { type: 'page', id: r.nextSelectedId } : { type: 'settings' });
  };

  const duplicateStep = (id: string) => {
    if (!active) return;
    const r = modelDuplicate(active.steps, id);
    patchQuest((q) => ({ ...q, steps: r.steps }));
    if (r.newId) setSel({ type: 'page', id: r.newId });
  };

  const reorder = (from: number, to: number) => {
    patchQuest((q) => ({ ...q, steps: reorderSteps(q.steps, from, to) }));
  };

  const backToList = async () => {
    // Flush the latest draft so the list reflects the newest name/step count.
    if (active) {
      try {
        await api.saveConstructorQuest(active.id, {
          name: active.meta.title,
          cover: active.meta.cover,
          steps_count: active.steps.length,
          body: active,
        });
      } catch {
        /* best-effort; the list refresh below shows last persisted state */
      }
    }
    setScreen('list');
    setActive(null);
    setSel(null);
    setListLoading(true);
    await refreshList();
  };

  const publish = async () => {
    if (!active || publishing) return;
    setPublishing(true);
    setPublishError(null);
    try {
      const snapshot = serializeDraft(active);
      await api.publishQuest({
        quest_id: active.id,
        name: active.meta.title,
        primary_comic: active.meta.cover,
        template_summary: active.steps.map((s) => s.template).join(', '),
        snapshot_version: snapshot.snapshot_version,
        snapshot_id: `${active.id}-v${snapshot.snapshot_version}`,
        snapshot,
        // Real store-card fields the author set in Settings → the catalog shows
        // these instead of fabricating city/duration/price.
        city: active.meta.city,
        duration: active.meta.duration,
        price: active.meta.price,
      });
      const sizeLabel = computeGates(active).sizeLabel;
      patchQuest((q) => ({
        ...q,
        versions: [
          {
            n: snapshot.snapshot_version,
            date: new Date().toLocaleDateString('ru-RU'),
            pages: q.steps.length,
            size: sizeLabel,
            live: true,
            attempts: 0,
          },
          ...q.versions.map((v) => ({ ...v, live: false })),
        ],
      }));
      setJustPublished(snapshot.snapshot_version);
    } catch (e) {
      setPublishError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  const builderQuest = active ? { ...active, lastSaved: savedAt } : null;

  return (
    <>
      {screen === 'builder' && builderQuest ? (
        <div className="admin wsp">
          <BuilderScreen
            quest={builderQuest}
            sel={sel}
            saveOk={saveOk}
            justPublished={justPublished}
            publishError={publishError}
            publishing={publishing}
            actions={{
              onSel: selectIn,
              onPatchQuest: patchQuest,
              onBack: () => void backToList(),
              onTest: (startPos) => active && setTest({ quest: active, startPos }),
              insertStep,
              removeStep,
              duplicateStep,
              reorder,
              publish: () => void publish(),
            }}
          />
          {test ? (
            <TestOverlay quest={test.quest} startPos={test.startPos} onClose={() => setTest(null)} />
          ) : null}
        </div>
      ) : (
        <>
          <Dashboard
            quests={list}
            loading={listLoading}
            error={listError}
            profileName={profileName}
            profileRole={profileRole}
            toast={toast}
            actions={{
              onCreate: () => void createQuest(),
              onEdit: (id) => void openQuest(id),
              onRun: (q) => void runQuest(q),
              onDuplicate: (q) => void duplicate(q),
              onDelete: (q) => void deleteQuest(q),
              onStatusChange: (q, status) => void changeStatus(q, status),
              onLogout,
            }}
          />
          {test ? (
            <div className="admin wsp">
              <TestOverlay quest={test.quest} startPos={test.startPos} onClose={() => setTest(null)} />
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
