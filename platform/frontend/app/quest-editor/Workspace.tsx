'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  adoptCover,
  computeGates,
  duplicateQuest,
  duplicateStep as modelDuplicate,
  insertionIndex,
  migrateQuest,
  newQuest,
  newStep,
  questUpsert,
  removeStep as modelRemove,
  reorderSteps,
  serializeDraft,
  uid,
  type CtorQuest,
  type CtorSelection,
  type CtorTemplate,
} from '../../lib/constructor-model';
import {
  api,
  classify,
  isAuthFailure,
  type ConstructorAuthorWire,
  type ConstructorQuestWire,
  type CtorStatus,
} from '../../lib/api';
import { isAdmin } from '../../lib/roles';
import { useMe } from '../../lib/use-me';
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

/** Безопасно привести серверное тело к CtorQuest: валидация + миграция старых
 *  форм шагов (images-роли, gift-тумблер, nav.lat/lng) — вся логика в модели. */
const bodyToQuest = migrateQuest;

export default function Workspace() {
  const { role } = useMe();

  // ---- Список (дашборд) ----
  const [list, setList] = useState<ConstructorQuestWire[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Билдер (один активный квест) ----
  const [screen, setScreen] = useState<Screen>('list');
  const [active, setActive] = useState<CtorQuest | null>(null);
  const [sel, setSel] = useState<CtorSelection | null>(null);
  const [saveOk, setSaveOk] = useState(true);
  // §9.4 auto-retry: bumping the tick re-runs the autosave effect. Fired by the
  // browser's online event and by a slow poll while a save is failing.
  const [saveRetryTick, setSaveRetryTick] = useState(0);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // True after a successful save in THIS session (drives «Сохранено · только что»).
  const [saveFresh, setSaveFresh] = useState(false);
  const [justPublished, setJustPublished] = useState<number | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [exporting, setExporting] = useState(false);

  // ---- Тест-игрок (оверлей) ----
  const [test, setTest] = useState<{ quest: CtorQuest; startPos: number } | null>(null);

  // ---- Передача квеста другому автору (#100) ----
  // Кому можно передать. Список нужен только администратору, поэтому и грузится
  // только для него; владелец активного квеста берётся из уже загруженного
  // списка квестов, а не хранится второй копией.
  const [authors, setAuthors] = useState<ConstructorAuthorWire[] | null>(null);

  const showToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const errMessage = (e: unknown): string => {
    if (isAuthFailure(e)) return 'Нет доступа — войдите под учётной записью редактора.';
    if (classify(e).kind === 'offline') return 'Не удалось связаться с сервером.';
    return 'Сервер недоступен — попробуйте ещё раз.';
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

  // Mount: the quest list (identity lives in the shared UserMenu). The
  // microtask hop keeps the fetch's setState out of the synchronous effect body.
  useEffect(() => {
    void Promise.resolve().then(refreshList);
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [refreshList]);

  // Who a quest may be handed to — fetched only for an admin, the one role that
  // may transfer (lib/roles, the same predicate the nav and the gates use). An
  // editor therefore makes no request at all instead of a guaranteed 403.
  useEffect(() => {
    if (!isAdmin(role)) return;
    void api
      .listConstructorAuthors()
      .then(setAuthors)
      .catch(() => setAuthors(null));
  }, [role]);

  // Server autosave: persist the active draft (debounced) whenever it changes.
  // savedAt is NOT part of `active`, so updating it never retriggers this effect.
  // saveRetryTick re-runs it after a failure (reconnect / poll) — §9.4: the
  // header promises «Повторим автоматически», so we actually do.
  useEffect(() => {
    if (!active) return;
    const quest = active;
    const t = setTimeout(() => {
      void api
        .saveConstructorQuest(quest.id, questUpsert(quest))
        .then((res) => {
          setSaveOk(true);
          setSaveFresh(true);
          setSavedAt(Date.now());
          // The server externalizes an inline cover; adopt the stored URL so the
          // next autosave carries a reference instead of the bytes again.
          setActive((q) =>
            q && q.id === quest.id ? adoptCover(q, quest.meta.cover, res.cover) : q,
          );
        })
        .catch(() => setSaveOk(false));
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [active, saveRetryTick]);

  // While a save is failing: retry the moment the browser reports connectivity,
  // and poll slowly as a fallback (the online event is not reliable everywhere).
  useEffect(() => {
    if (saveOk) return;
    const retry = () => setSaveRetryTick((n) => n + 1);
    window.addEventListener('online', retry);
    const iv = setInterval(retry, 15_000);
    return () => {
      window.removeEventListener('online', retry);
      clearInterval(iv);
    };
  }, [saveOk]);

  const patchQuest = useCallback((fn: (q: CtorQuest) => CtorQuest) => {
    setActive((q) => (q ? fn(q) : q));
  }, []);

  // ---- Dashboard actions ----

  const createQuest = async () => {
    const q = newQuest({});
    try {
      const row = await api.createConstructorQuest({ quest_id: q.id, ...questUpsert(q) });
      // Держим список актуальным сразу: он источник строки активного квеста
      // (автор, статус), и без этого новый квест не имел бы её до возврата.
      setList((l) => [row, ...l]);
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
      setSaveFresh(false);
      setSaveOk(true);
      setActive(q);
      setSel(q.steps.length ? { type: 'page', id: q.steps[0].id } : { type: 'settings' });
      setScreen('builder');
    } catch (e) {
      showToast(errMessage(e));
    }
  };

  /** Передать активный квест другому автору (#100). Админ сохраняет доступ к
   *  любому квесту, поэтому билдер остаётся открытым и после передачи; строка
   *  списка обновляется ответом, без повторной загрузки всего списка. */
  const transferQuest = async (questId: string, userId: string) => {
    try {
      const row = await api.setConstructorAuthor(questId, userId);
      setList((l) => l.map((q) => (q.quest_id === row.quest_id ? row : q)));
      showToast(`Квест передан: ${row.author}`);
    } catch (e) {
      throw new Error(errMessage(e));
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
      await api.createConstructorQuest({ quest_id: copy.id, ...questUpsert(copy) });
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
      const f = classify(e);
      if (f.kind === 'rejected' && f.status === 400 && status !== 'draft') {
        showToast('Сначала опубликуйте версию в редакторе — затем выберите статус.');
        void openQuest(row.quest_id);
      } else {
        showToast(errMessage(e));
      }
    }
  };

  // ---- Builder actions ----

  // §9.1: a snapshot-less quest can't be flipped to test/published — the
  // dashboard routes those transitions here, straight into the gated panel.
  const openPublish = async (id: string) => {
    await openQuest(id);
    setSel({ type: 'publish' });
  };

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
        await api.saveConstructorQuest(active.id, questUpsert(active));
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
        description: active.meta.desc,
        players_bonus: active.meta.playersBonus,
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

  // Full backup download (record + steps + media), same zip the
  // backend export endpoint builds — triggers a normal browser file save via a
  // throwaway object URL, no navigation.
  const exportQuest = async () => {
    if (!active || exporting) return;
    setExporting(true);
    try {
      const blob = await api.exportConstructorQuest(active.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `quest-${active.id}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      showToast(errMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const builderQuest = active ? { ...active, lastSaved: savedAt } : null;
  // Серверная строка активного квеста: автор и статус живут там, а не в теле
  // черновика. Одна копия — та, что уже загружена для дашборда.
  const activeRow = active ? list.find((q) => q.quest_id === active.id) : undefined;

  return (
    <>
      {screen === 'builder' && builderQuest ? (
        <div className="admin wsp">
          <BuilderScreen
            saveFresh={saveFresh}
            quest={builderQuest}
            sel={sel}
            saveOk={saveOk}
            justPublished={justPublished}
            publishError={publishError}
            publishing={publishing}
            exporting={exporting}
            transfer={
              authors && activeRow
                ? {
                    current: { id: activeRow.author_id, name: activeRow.author },
                    candidates: authors,
                    onTransfer: (userId) => transferQuest(activeRow.quest_id, userId),
                  }
                : undefined
            }
            actions={{
              onSel: selectIn,
              onPatchQuest: patchQuest,
              onBack: () => void backToList(),
              onTest: (startPos) => active && setTest({ quest: active, startPos }),
              onExport: () => void exportQuest(),
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
            toast={toast}
            actions={{
              onCreate: () => void createQuest(),
              onEdit: (id) => void openQuest(id),
              onRun: (q) => void runQuest(q),
              onDuplicate: (q) => void duplicate(q),
              onDelete: (q) => void deleteQuest(q),
              onStatusChange: (q, status) => void changeStatus(q, status),
              onOpenPublish: (q) => void openPublish(q.quest_id),
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
