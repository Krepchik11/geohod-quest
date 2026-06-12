'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  computeGates,
  duplicateStep as modelDuplicate,
  insertionIndex,
  loadWorkspace,
  newQuest,
  newStep,
  removeStep as modelRemove,
  reorderSteps,
  saveWorkspace,
  serializeDraft,
  type CtorQuest,
  type CtorQuestMeta,
  type CtorSelection,
  type CtorTemplate,
  type WorkspaceState,
} from '../../lib/constructor-model';
import { api } from '../../lib/api';
import { BuilderScreen } from './Builder';
import { QuestListScreen } from './QuestList';
import { TestOverlay } from './TestPlayer';

const AUTOSAVE_DEBOUNCE_MS = 250;

/**
 * Конструктор v2 — единое рабочее место (design «Конструктор v2.html»):
 * список квестов → создание → билдер 3 панели → тест-игрок → публикация.
 * Черновики и позиция переживают перезагрузку (localStorage).
 *
 * Рендерится только на клиенте (см. WorkspaceGate) — состояние читается из
 * localStorage синхронно в инициализаторе, без гидрационных расхождений.
 */
export default function Workspace() {
  const [state, setState] = useState<WorkspaceState>(() => loadWorkspace());
  const [saveOk, setSaveOk] = useState(true);
  const [test, setTest] = useState<{ startPos: number } | null>(null);
  const [justPublished, setJustPublished] = useState<number | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  // Автосейв с дебаунсом: не сериализуем многомегабайтный черновик на каждый ввод.
  useEffect(() => {
    const t = setTimeout(() => setSaveOk(saveWorkspace(state)), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [state]);

  const quest = state.quests.find((q) => q.id === state.questId) || null;

  const go = useCallback((patch: Partial<WorkspaceState>) => {
    setState((s) => ({ ...s, ...patch }));
  }, []);

  const patchQuest = useCallback((fn: (q: CtorQuest) => CtorQuest) => {
    setState((s) => ({
      ...s,
      quests: s.quests.map((q) => (q.id === s.questId ? { ...fn(q), lastSaved: Date.now() } : q)),
    }));
  }, []);

  const openQuest = (id: string) => {
    const q = state.quests.find((x) => x.id === id);
    setJustPublished(null);
    setPublishError(null);
    go({
      screen: 'builder',
      questId: id,
      sel: q && q.steps.length ? { type: 'page', id: q.steps[0].id } : { type: 'settings' },
    });
  };

  const createQuest = (meta: Partial<CtorQuestMeta>) => {
    const q = newQuest(meta);
    setJustPublished(null);
    setPublishError(null);
    setState((s) => ({
      ...s,
      quests: [q, ...s.quests],
      screen: 'builder',
      questId: q.id,
      sel: { type: 'page', id: q.steps[0].id },
    }));
  };

  const selectIn = (sel: CtorSelection) => {
    if (sel.type !== 'publish') {
      setJustPublished(null);
      setPublishError(null);
    }
    go({ sel });
  };

  const insertStep = (template: CtorTemplate) => {
    const step = newStep(template);
    patchQuest((q) => {
      const selectedId = state.sel?.type === 'page' ? state.sel.id : null;
      const arr = [...q.steps];
      arr.splice(insertionIndex(arr, selectedId, template), 0, step);
      return { ...q, steps: arr };
    });
    go({ sel: { type: 'page', id: step.id } });
  };

  // NB: результат правки вычисляется от текущего quest.steps ДО setState —
  // updater выполняется лениво, читать из него наружу нельзя.
  const removeStep = (id: string) => {
    if (!quest) return;
    const r = modelRemove(quest.steps, id);
    patchQuest((q) => ({ ...q, steps: r.steps }));
    go({ sel: r.nextSelectedId ? { type: 'page', id: r.nextSelectedId } : { type: 'settings' } });
  };

  const duplicateStep = (id: string) => {
    if (!quest) return;
    const r = modelDuplicate(quest.steps, id);
    patchQuest((q) => ({ ...q, steps: r.steps }));
    if (r.newId) go({ sel: { type: 'page', id: r.newId } });
  };

  const reorder = (from: number, to: number) => {
    patchQuest((q) => ({ ...q, steps: reorderSteps(q.steps, from, to) }));
  };

  const publish = async () => {
    if (!quest || publishing) return;
    setPublishing(true);
    setPublishError(null);
    try {
      const snapshot = serializeDraft(quest);
      await api.publishQuest({
        quest_id: quest.id,
        name: quest.meta.title,
        primary_comic: quest.meta.cover,
        template_summary: quest.steps.map((s) => s.template).join(', '),
        snapshot_version: snapshot.snapshot_version,
        snapshot_id: `${quest.id}-v${snapshot.snapshot_version}`,
        snapshot,
      });
      const sizeLabel = computeGates(quest).sizeLabel;
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

  return (
    <div className="admin wsp">
      {state.screen === 'builder' && quest ? (
        <BuilderScreen
          quest={quest}
          sel={state.sel}
          saveOk={saveOk}
          justPublished={justPublished}
          publishError={publishError}
          publishing={publishing}
          actions={{
            onSel: selectIn,
            onPatchQuest: patchQuest,
            onBack: () => go({ screen: 'list' }),
            onTest: (startPos) => setTest({ startPos }),
            insertStep,
            removeStep,
            duplicateStep,
            reorder,
            publish: () => void publish(),
          }}
        />
      ) : (
        <QuestListScreen quests={state.quests} onOpen={openQuest} onCreate={createQuest} />
      )}

      {test && quest ? (
        <TestOverlay quest={quest} startPos={test.startPos} onClose={() => setTest(null)} />
      ) : null}
    </div>
  );
}
