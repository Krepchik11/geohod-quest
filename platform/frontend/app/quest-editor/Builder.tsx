'use client';

import React, { useMemo, useState } from 'react';
import {
  CTOR_TEMPLATES,
  TPL_BY_KEY,
  computeGates,
  fmtTime,
  newStep,
  plural,
  serializeDraft,
  stepToGameStep,
  type CtorQuest,
  type CtorQuestMeta,
  type CtorSelection,
  type CtorStep,
  type CtorTemplate,
  type Gates,
  type GateField,
} from '../../lib/constructor-model';
import { toDesignStep } from '../../lib/design-step';
import { PLAYER_COPY } from '../../lib/player-copy';
import { PlayerFrame, StepView, TopBar, type DesignStep } from '../player/PlayerComponents';
import { ImageZone, WspBlock, WspToggle } from './controls';
import { PageEditor } from './PageEditor';
import { PublishPanel } from './PublishPanel';
import { WspHeader } from './QuestList';

/* ---------- Мини-превью шаблона настоящими компонентами плеера ---------- */

/** Нейтральная мета для превью пикера — обобщённый плейсхолдер, НЕ настоящий и не
 *  выдуманный квест. Показывает форму шаблона, а не чьи-то данные. */
const PREVIEW_META: CtorQuestMeta = {
  title: 'Название квеста',
  city: 'Город',
  duration: '1–2 часа',
  cover: '/assets/img/quest-card.png',
  desc: '',
  price: 0,
};

/** Краткий обобщённый текст-иллюстрация для каждого шаблона: показывает, как
 *  выглядит страница такого типа, не притворяясь реальным контентом квеста. */
const PREVIEW_TEXT: Record<CtorTemplate, string> = {
  start: 'краткое описание квеста',
  video: 'видео-знакомство с квестом',
  task_no: 'дойдите до указанной точки и осмотритесь',
  task_answer: 'рассмотрите место и ответьте на вопрос',
  continue: 'развитие сюжета между заданиями',
  route_video: 'видео-навигация до следующей точки',
  congrats: 'поздравляем с прохождением!',
};

/** Превью-шаг из ПРЕФИЛЛА самого шаблона (newStep) + нейтральный текст. Без
 *  seed-квеста: ни одной выдуманной строки контента. */
function previewStepFor(template: CtorTemplate): { step: DesignStep; pos: number; total: number } {
  const s = newStep(template);
  s.text = PREVIEW_TEXT[template];
  // Задания рисуют комикс — нейтральный плейсхолдер, чтобы рамка выглядела цельной,
  // не привязываясь ни к какому квесту.
  if (template === 'task_no' || template === 'task_answer') {
    s.images = { ...s.images, task: '/assets/img/quest-card.png' };
  }
  if (template === 'task_no') s.place = 'адрес точки · 300 м';
  const idx = CTOR_TEMPLATES.findIndex((t) => t.key === template);
  return {
    step: toDesignStep(stepToGameStep(s, PREVIEW_META)),
    pos: (idx >= 0 ? idx : 0) + 1,
    total: CTOR_TEMPLATES.length,
  };
}

function MiniTemplatePreview({ template }: { template: CtorTemplate }) {
  const { step, pos, total } = useMemo(() => previewStepFor(template), [template]);
  return (
    <div className="mini">
      <PlayerFrame tw={{ art: 'paper', layout: 'image', anims: false }}>
        {template !== 'start' ? <TopBar pos={pos} total={total} coins={0} /> : null}
        <StepView step={step} quest={{ city: PREVIEW_META.city, duration: PREVIEW_META.duration }} copy={PLAYER_COPY} st={{}} on={{}} />
      </PlayerFrame>
    </div>
  );
}

function TemplatePickerModal({ onClose, onPick }: { onClose: () => void; onPick: (key: CtorTemplate) => void }) {
  return (
    <div className="wsp-ovl" onClick={onClose}>
      <div className="wsp-tpick" onClick={(e) => e.stopPropagation()}>
        <h3>Новая страница — выберите шаблон</h3>
        <p className="sub">Страница добавится после текущей, но не позже финального «Поздравления». Превью отрисованы настоящими компонентами плеера.</p>
        <div className="wsp-tgrid">
          {CTOR_TEMPLATES.map((t) => (
            <div key={t.key} className="wsp-tcell" onClick={() => onPick(t.key)} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onPick(t.key); }}>
              <div className="frame"><MiniTemplatePreview template={t.key} /></div>
              <span className="nm">{t.name}</span>
              <span className="fl"><b>Префилл:</b> {t.fill}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- Настройки квеста ---------- */

function QuestSettings({ quest, onMeta }: { quest: CtorQuest; onMeta: (meta: CtorQuestMeta) => void }) {
  const m = quest.meta;
  const set = (patch: Partial<CtorQuestMeta>) => onMeta({ ...m, ...patch });
  return (
    <div className="ed-form">
      <div className="wsp-edhead">
        <span className="wsp-tplchip">Настройки квеста</span>
      </div>
      <WspBlock title="Карточка квеста" aside="используется «Первым экраном» и магазином">
        <div>
          <label className="adm-label">Название</label>
          <input className="input" value={m.title} onChange={(e) => set({ title: e.target.value })} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <div>
            <label className="adm-label">Город</label>
            <input className="input" value={m.city} onChange={(e) => set({ city: e.target.value })} />
          </div>
          <div>
            <label className="adm-label">Длительность</label>
            <input className="input" placeholder="2–3 часа" value={m.duration} onChange={(e) => set({ duration: e.target.value })} />
          </div>
          <div>
            <label className="adm-label">Цена, ₽</label>
            <input className="input" type="number" min={0} value={m.price} onChange={(e) => set({ price: Math.max(0, +e.target.value || 0) })} />
          </div>
        </div>
        <div>
          <label className="adm-label">Описание для магазина</label>
          <textarea className="textarea" value={m.desc} onChange={(e) => set({ desc: e.target.value })} />
        </div>
        <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12, margin: 0 }}>0 ₽ — бесплатный квест. Оплата, купоны и выдача доступов — на стороне магазина, не конструктора.</p>
      </WspBlock>
      <WspBlock title="Обложка" aside="первый экран и карточка магазина">
        <ImageZone src={m.cover} label="обложка" hint="PNG/JPG — будет ужата до 1280px" width={240} onChange={(cover) => set({ cover })} />
      </WspBlock>
    </div>
  );
}

/* ---------- Превью-панель: настоящие компоненты плеера ---------- */

function PreviewBody({ quest, designStep, pos, total, onTestFrom }: {
  quest: CtorQuest;
  designStep: DesignStep;
  pos: number;
  total: number;
  onTestFrom: (i: number) => void;
}) {
  // Тогглы живут в keyed-компоненте: смена страницы пересоздаёт их с нуля.
  const [hintOn, setHintOn] = useState(false);
  const [wrongOn, setWrongOn] = useState(false);
  return (
    <>
      <div className="wsp-phone">
        <PlayerFrame tw={{ art: 'paper', layout: 'image', anims: false }}>
          {designStep.template !== 'start' ? <TopBar pos={pos + 1} total={total} coins={0} /> : null}
          <StepView
            step={designStep}
            quest={{ title: quest.meta.title, city: quest.meta.city || '—', duration: quest.meta.duration || '—' }}
            copy={PLAYER_COPY}
            st={{ hintRevealed: hintOn, wrong: wrongOn }}
            on={{}}
          />
        </PlayerFrame>
      </div>
      {designStep.hint ? <WspToggle on={hintOn} onClick={() => setHintOn(!hintOn)} label="С купленной подсказкой" /> : null}
      {designStep.template === 'task_answer' ? <WspToggle on={wrongOn} onClick={() => setWrongOn(!wrongOn)} label="С ошибкой ответа" /> : null}
      <button className="btn btn--secondary btn--sm" type="button" style={{ width: '100%' }} onClick={() => onTestFrom(pos)}>▶ Тест с этой страницы</button>
    </>
  );
}

function PreviewPanel({ quest, idx, onTestFrom }: { quest: CtorQuest; idx: number; onTestFrom: (i: number) => void }) {
  const snapshot = useMemo(() => serializeDraft(quest), [quest]);
  const total = snapshot.steps.length;
  const i = Math.max(0, Math.min(idx, total - 1));
  const designStep = total ? toDesignStep(snapshot.steps[i]) : null;
  if (!designStep) {
    return <aside className="wsp-preview"><p className="cap">Нет страниц — превью появится после добавления первой.</p></aside>;
  }
  return (
    <aside className="wsp-preview">
      <p className="cap">Живое превью — настоящие компоненты плеера · {i + 1} / {total}</p>
      <PreviewBody key={quest.steps[i].id} quest={quest} designStep={designStep} pos={i} total={total} onTestFrom={onTestFrom} />
    </aside>
  );
}

/* ---------- Строка страницы в рельсе ---------- */

interface DragHandlers {
  over: boolean;
  start: (e: React.DragEvent) => void;
  overHandler: (e: React.DragEvent) => void;
  leave: () => void;
  drop: (e: React.DragEvent) => void;
}

function PageRow({ step, index, active, msgs, onClick, drag }: {
  step: CtorStep;
  index: number;
  active: boolean;
  msgs: Array<{ kind: 'err' | 'warn'; text: string }> | undefined;
  onClick: () => void;
  drag: DragHandlers;
}) {
  const errs = (msgs || []).filter((m) => m.kind === 'err');
  return (
    <div
      className={'wsp-page' + (active ? ' active' : '') + (drag.over ? ' dragover' : '')}
      onClick={onClick}
      draggable
      onDragStart={drag.start}
      onDragOver={drag.overHandler}
      onDragLeave={drag.leave}
      onDrop={drag.drop}
      title={errs.map((e) => e.text).join('\n') || undefined}
    >
      <span className="grip">⠿</span>
      <span className="num">{index + 1}</span>
      <span className="body">
        <span className="nm">{step.name || TPL_BY_KEY[step.template].name}</span>
        <span className="tp">{TPL_BY_KEY[step.template].name}</span>
      </span>
      <span className={'dot ' + (errs.length ? 'err' : 'ok')} />
    </div>
  );
}

/* ---------- Билдер ---------- */

export interface BuilderActions {
  onSel: (sel: CtorSelection) => void;
  onPatchQuest: (fn: (q: CtorQuest) => CtorQuest) => void;
  onBack: () => void;
  onTest: (startPos: number) => void;
  insertStep: (template: CtorTemplate) => void;
  removeStep: (id: string) => void;
  duplicateStep: (id: string) => void;
  reorder: (from: number, to: number) => void;
  publish: () => void;
}

export function BuilderScreen({ quest, sel, saveOk, saveFresh, justPublished, publishError, publishing, actions }: {
  quest: CtorQuest;
  sel: CtorSelection | null;
  saveOk: boolean;
  /** True once a save completed in THIS session — «Сохранено · только что». */
  saveFresh: boolean;
  justPublished: number | null;
  publishError: string | null;
  publishing: boolean;
  actions: BuilderActions;
}) {
  const gates: Gates = useMemo(() => computeGates(quest), [quest]);
  const steps = quest.steps;
  const selStep = sel && sel.type === 'page' ? steps.find((s) => s.id === sel.id) : undefined;
  const view = sel && (sel.type === 'settings' || sel.type === 'publish') ? sel.type : selStep ? 'page' : 'settings';
  const selIdx = selStep ? steps.indexOf(selStep) : 0;
  const [picker, setPicker] = useState(false);
  // §9.2: which control the last «Исправить →» pointed at; nonce re-fires the
  // scroll/flash when the same field is clicked twice.
  const [highlight, setHighlight] = useState<{ pageId: string | null; field?: GateField; nonce: number } | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const live = quest.versions.find((v) => v.live);
  const errN = gates.errors.length;

  const patchStep = (id: string, patch: Partial<CtorStep>) =>
    actions.onPatchQuest((q) => ({
      ...q,
      steps: q.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));

  return (
    <>
      <WspHeader
        crumbs={
          <>
            <a onClick={actions.onBack}>Квесты</a>
            <span>/</span>
            <b>{quest.meta.title}</b>
          </>
        }
      >
        {/* §9.4: автосейв серверный — статус честный про сеть, не про localStorage. */}
        <span className={'wsp-save' + (saveOk ? '' : ' failed')}>
          {saveOk
            ? quest.lastSaved
              ? saveFresh
                ? 'Сохранено · только что'
                : `Сохранено · ${fmtTime(quest.lastSaved)}`
              : 'Черновик'
            : 'Нет сети — правки не сохранены. Повторим автоматически.'}
        </span>
        <button className="btn btn--secondary btn--sm" type="button" onClick={() => actions.onTest(0)}>▶ Тест-игрок</button>
        <button className="btn btn--md" type="button" onClick={() => actions.onSel({ type: 'publish' })}>
          {errN ? `Опубликовать · ${errN} ${plural(errN, 'ошибка', 'ошибки', 'ошибок')}` : 'Опубликовать'}
        </button>
      </WspHeader>

      <div className="wsp-builder">
        <nav className="wsp-rail">
          <h5>Квест</h5>
          <div className={'wsp-navitem' + (view === 'settings' ? ' active' : '')} onClick={() => actions.onSel({ type: 'settings' })}>Настройки и обложка</div>
          <div className={'wsp-navitem' + (view === 'publish' ? ' active' : '')} onClick={() => actions.onSel({ type: 'publish' })}>
            Публикация и версии
            {errN ? <span className="wsp-chip err">{errN}</span> : null}
          </div>
          <h5>Страницы ({steps.length})</h5>
          <div>
            {steps.map((s, i) => (
              <PageRow
                key={s.id}
                step={s}
                index={i}
                active={!!(selStep && selStep.id === s.id)}
                msgs={gates.perPage[s.id]}
                onClick={() => actions.onSel({ type: 'page', id: s.id })}
                drag={{
                  over: dragOver === i && dragFrom !== i,
                  start: (e) => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move'; },
                  overHandler: (e) => { e.preventDefault(); setDragOver(i); },
                  leave: () => setDragOver(null),
                  drop: (e) => {
                    e.preventDefault();
                    if (dragFrom !== null) actions.reorder(dragFrom, i);
                    setDragFrom(null);
                    setDragOver(null);
                  },
                }}
              />
            ))}
          </div>
          <button className="btn btn--secondary btn--sm wsp-addpage" type="button" onClick={() => setPicker(true)}>+ Добавить страницу</button>
          <div className="wsp-vers">
            {live
              ? <span className="wsp-ver"><b>v{live.n}</b>&nbsp;в магазине · {live.attempts} {plural(live.attempts, 'попытка', 'попытки', 'попыток')}</span>
              : <span className="wsp-ver">Ещё не опубликован</span>}
            <span className="wsp-ver">Версии неизменяемы — правки выходят новой публикацией.</span>
          </div>
        </nav>

        <main className="wsp-center">
          {view === 'publish' ? (
            <PublishPanel
              quest={quest}
              gates={gates}
              justPublished={justPublished}
              publishError={publishError}
              publishing={publishing}
              onFix={(pageId, field) => {
                actions.onSel(pageId ? { type: 'page', id: pageId } : { type: 'settings' });
                setHighlight({ pageId, field, nonce: Date.now() });
              }}
              onPublish={actions.publish}
            />
          ) : view === 'settings' ? (
            <QuestSettings quest={quest} onMeta={(meta) => actions.onPatchQuest((q) => ({ ...q, meta }))} />
          ) : (
            <PageEditor
              quest={quest}
              step={selStep!}
              msgs={gates.perPage[selStep!.id]}
              highlight={highlight && highlight.pageId === selStep!.id ? highlight : null}
              onPatch={(patch) => patchStep(selStep!.id, patch)}
              onDelete={() => actions.removeStep(selStep!.id)}
              onDuplicate={() => actions.duplicateStep(selStep!.id)}
              onSettings={() => actions.onSel({ type: 'settings' })}
            />
          )}
        </main>

        <PreviewPanel quest={quest} idx={view === 'page' ? selIdx : 0} onTestFrom={actions.onTest} />
      </div>

      {picker ? (
        <TemplatePickerModal
          onClose={() => setPicker(false)}
          onPick={(key) => { setPicker(false); actions.insertStep(key); }}
        />
      ) : null}
    </>
  );
}
