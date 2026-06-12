'use client';

import React, { useState } from 'react';
import AdminHeader from '../AdminHeader';
import TabGroup from '../components/TabGroup';
import Dropzone from '../components/Dropzone';
import ConfirmModal from '../components/ConfirmModal';
import { isAnswerCorrect, validateForPublish, serializeToSnapshot } from '../../lib/shared-model';
import { getSnapshot } from '../../lib/goldens';
import { api } from '../../lib/api';
import { PlayerFrame, StepView, TopBar } from '../player/PlayerComponents';

/**
 * Конструктор квеста. Structure, classes and RU copy ported from
 * design/ctor/screens.jsx (picker A, pages + versions, publish checklist +
 * modal) and design/ctor/editor.jsx (per-step editor blocks, live phone
 * preview). Mini-previews and the phone are rendered by the REAL player
 * components (never screenshots) per the design requirement.
 */

type Template = 'start' | 'video' | 'task_no' | 'task_answer' | 'continue' | 'route_video' | 'congrats';

interface EditorStep {
  id: string;
  position: number;
  template: Template;
  rich_content: { title?: string; main_text?: string; place_text?: string; button_text?: string; question_prompt?: string | null };
  media: { task?: string | null; character?: string | null; hint?: string | null; atmosphere?: string | null };
  completion: { mode: 'physical' | 'answer'; acceptable?: string[] | null; allow_note?: boolean };
  supporting?: {
    gift?: { coins: number; narrative_text: string };
    hint?: { cost_coins: number; reveal_text?: string };
    navigator?: { lat: number; lng: number; label?: string };
    terminal?: boolean;
    is_start?: boolean;
  };
}

interface EditorQuest {
  name: string;
  steps: EditorStep[];
}

interface PublishedVersion {
  version: number;
  publishedAt: string;
  pages: number;
  live: boolean;
  activeAttempts: number;
}

const TEMPLATES: Array<{ tpl: Template; name: string }> = [
  { tpl: 'start', name: 'Первый экран' },
  { tpl: 'video', name: 'Приветственное видео' },
  { tpl: 'task_no', name: 'Задание без ответа' },
  { tpl: 'task_answer', name: 'Задание с ответом' },
  { tpl: 'continue', name: 'Продолжить' },
  { tpl: 'route_video', name: 'Видео маршрута' },
  { tpl: 'congrats', name: 'Поздравление' },
];

const TPL_NAME: Record<Template, string> = Object.fromEntries(TEMPLATES.map(t => [t.tpl, t.name])) as Record<Template, string>;

/** Template presets per SPEC «Template presets (constructor pre-fills)». */
function makeStep(tpl: Template, position: number): EditorStep {
  const base: EditorStep = {
    id: `step-${position}-${TEMPLATES.findIndex(t => t.tpl === tpl)}-${position * 7919}`,
    position,
    template: tpl,
    rich_content: { title: TPL_NAME[tpl], main_text: '', button_text: 'продолжить' },
    media: { task: null, character: null, hint: null, atmosphere: null },
    completion: { mode: 'physical' },
    supporting: {},
  };
  switch (tpl) {
    case 'start':
      base.rich_content.button_text = 'начать квест';
      base.supporting = { is_start: true };
      break;
    case 'task_no':
      base.rich_content.button_text = 'Я на месте';
      base.completion = { mode: 'physical', allow_note: true };
      base.supporting = { navigator: { lat: 45.2551, lng: 19.8451, label: 'Точка' } };
      break;
    case 'task_answer':
      base.rich_content.question_prompt = 'Введите ответ';
      base.completion = { mode: 'answer', acceptable: [] };
      base.supporting = { hint: { cost_coins: 5, reveal_text: '' }, gift: { coins: 5, narrative_text: '' } };
      break;
    case 'route_video':
      base.rich_content.button_text = 'в путь';
      base.supporting = { navigator: { lat: 45.2551, lng: 19.8451, label: 'Точка' } };
      break;
    case 'congrats':
      base.rich_content.title = 'Квест пройден!';
      base.supporting = { terminal: true };
      break;
    default:
      break;
  }
  return base;
}

/** Per-page gate status for the pages list (subset of the publish gates). */
function pageGate(step: EditorStep): string | null {
  if (['task_no', 'task_answer'].includes(step.template) && !step.media?.task && !step.rich_content?.main_text) {
    return 'нет комикса задания';
  }
  if (step.template === 'task_answer' && !(step.completion.acceptable || []).length) {
    return 'пустой список ответов';
  }
  return null;
}

export default function QuestConstructorPage() {
  const sample = getSnapshot('mystery-fortress-v1');
  const [quest, setQuest] = useState<EditorQuest>({
    name: sample?.name || 'Ирония судьбы',
    steps: (sample?.steps || []).map((s, i) => ({ ...(s as unknown as EditorStep), id: `step-${i}` })),
  });

  const [activeTab, setActiveTab] = useState<'tab-constructor' | 'tab-settings'>('tab-constructor');
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [view, setView] = useState<'pages' | 'checklist'>('pages');
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<string | null>(null);
  const [versions, setVersions] = useState<PublishedVersion[]>([
    { version: 3, publishedAt: '02.05.2026', pages: 8, live: true, activeAttempts: 12 },
    { version: 2, publishedAt: '14.03.2026', pages: 7, live: false, activeAttempts: 2 },
  ]);

  const [edPasteOpen, setEdPasteOpen] = useState(false);
  const [edPasteText, setEdPasteText] = useState('');
  const [edTestValue, setEdTestValue] = useState('');
  const [edPreviewHint, setEdPreviewHint] = useState(false);

  // Editor locals reset when entering a page (handler, not effect — react.md 5.8).
  const openEditor = (idx: number | null) => {
    setEdPasteOpen(false); setEdPasteText(''); setEdTestValue(''); setEdPreviewHint(false);
    setEditingIndex(idx);
  };

  const gates = validateForPublish({ steps: quest.steps });
  const nextVersion = (versions[0]?.version || 0) + 1;

  const addStep = (tpl: Template) => {
    setQuest({ ...quest, steps: [...quest.steps, makeStep(tpl, quest.steps.length)] });
  };

  const moveStep = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= quest.steps.length) return;
    const arr = [...quest.steps];
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    arr.forEach((s, i) => (s.position = i));
    setQuest({ ...quest, steps: arr });
  };

  const deleteStep = (idx: number) => {
    const newSteps = quest.steps.filter((_, i) => i !== idx);
    newSteps.forEach((s, i) => { s.position = i; });
    setQuest({ ...quest, steps: newSteps });
    setDeleteTarget(null);
  };

  const dryRun = () => {
    try {
      const snap = serializeToSnapshot({ golden_id: 'current', name: quest.name, snapshot_version: 0, steps: quest.steps });
      setDryRunResult(`Сериализация прошла: ${snap.steps.length} страниц, версия ${snap.snapshot_version}.`);
    } catch (e) {
      setDryRunResult('Сериализация упала: ' + (e as Error).message);
    }
  };

  const confirmPublish = async () => {
    const snapshot = serializeToSnapshot({
      golden_id: 'current',
      name: quest.name,
      snapshot_version: nextVersion - 1, // serializeToSnapshot bumps to nextVersion
      steps: quest.steps,
    });
    try {
      await api.publishQuest({
        quest_id: 'current',
        name: quest.name,
        primary_comic: null,
        template_summary: quest.steps.map(s => s.template).join(', '),
        snapshot_version: snapshot.snapshot_version,
        snapshot_id: `current-v${snapshot.snapshot_version}`,
        snapshot,
      });
      setVersions(v => [
        { version: nextVersion, publishedAt: new Date().toLocaleDateString('ru-RU'), pages: quest.steps.length, live: true, activeAttempts: 0 },
        ...v.map(old => ({ ...old, live: false })),
      ]);
      setPublishModalOpen(false);
      setView('pages');
    } catch (e) {
      alert('Публикация не удалась: ' + (e as Error).message);
    }
  };

  const saveAndTest = () => window.open('/quest?golden=mystery-fortress-v1', '_blank');

  const previewStepFor = (tpl: Template) => ({
    template: tpl,
    title: TPL_NAME[tpl],
    text: tpl === 'congrats' ? 'Финал' : 'Текст шага для превью.',
    kicker: tpl === 'start' ? 'Городской квест' : undefined,
    video: ['video', 'route_video'].includes(tpl) ? { dur: '0:30', label: 'видео' } : undefined,
    prompt: tpl === 'task_answer' ? 'Введите ответ' : undefined,
  });

  return (
    <div className="admin min-h-screen" style={{ background: 'var(--bg-light)' }}>
      <AdminHeader active="kvesty" />

      <main className="container">
        <div className="qe-head">
          <h1>Редактирование квеста</h1>
          <p className="helper">Здесь Вы можете создавать, редактировать и удалять страницы квеста.</p>
        </div>

        <TabGroup
          tabs={[{ id: 'tab-constructor', label: 'Конструктор квеста' }, { id: 'tab-settings', label: 'Настройка квеста в магазине' }]}
          active={activeTab}
          onChange={(id: string) => setActiveTab(id as 'tab-constructor' | 'tab-settings')}
        >
          <div data-tab="tab-constructor" className="tab-panel">
            <div className="qe-row" style={{ marginTop: 8 }}>
              <h2 className="h-label">Название квеста:</h2>
              <div className="qe-name">
                <input className="field-ui" type="text" value={quest.name} onChange={e => setQuest({ ...quest, name: e.target.value })} />
                <button className="adm-btn adm-btn--sm" onClick={saveAndTest}>Открыть как тест-игрок</button>
              </div>
            </div>

            {view === 'pages' && (
              <>
                {/* Пикер шаблонов: живые мини-превью настоящими компонентами плеера */}
                <h2 className="h-label" style={{ marginTop: 28 }}>Выбор шаблона страницы</h2>
                <p className="adm-helper" style={{ textAlign: 'left' }}>Нажмите на шаблон для создания новой страницы квеста</p>
                <div className="tpick-grid">
                  {TEMPLATES.map((t) => (
                    <div className="tpick-cell" key={t.tpl} onClick={() => addStep(t.tpl)}>
                      <span className="name">{t.name}</span>
                      <div className="tpick-frame">
                        <div className="mini">
                          <PlayerFrame tw={{ art: 'paper', layout: 'image', anims: false }}>
                            {t.tpl !== 'start' && <TopBar pos={3} total={8} coins={13} />}
                            <StepView step={previewStepFor(t.tpl)} quest={{ city: 'Нови Сад', duration: '90 минут' }} copy={{}} st={{}} on={{}} />
                          </PlayerFrame>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="adm-helper" style={{ textAlign: 'left', marginTop: 8 }}>Превью отрисованы настоящими компонентами плеера.</p>

                {/* Страницы квеста */}
                <h2 className="h-label pages-title" style={{ marginTop: 40 }}>Страницы квеста</h2>
                <p className="adm-helper" style={{ textAlign: 'left' }}>Публикация заморозит их в неизменяемую версию.</p>
                <div className="adm-card" style={{ marginTop: 12, padding: '4px 0' }}>
                  {quest.steps.map((step, index) => {
                    const err = pageGate(step);
                    return (
                      <div key={step.id} className="pg-row">
                        <span className="grip" title="Перетащить">⠿</span>
                        <span className="num">{index + 1}</span>
                        <span className="nm">{step.rich_content?.title || TPL_NAME[step.template]}</span>
                        <span className="tpl">{TPL_NAME[step.template]}</span>
                        <span className={'gate ' + (err ? 'err' : 'ok')}>{err ? `✗ ${err}` : '✓ готова'}</span>
                        <button className="adm-btn adm-btn--sm adm-btn--outline" onClick={() => moveStep(index, -1)} title="Вверх">↑</button>
                        <button className="adm-btn adm-btn--sm adm-btn--outline" onClick={() => moveStep(index, 1)} title="Вниз">↓</button>
                        <button className="adm-btn adm-btn--sm" onClick={() => openEditor(index)}>Редактировать</button>
                        <button className="adm-btn adm-btn--sm adm-btn--danger" onClick={() => setDeleteTarget(index)}>Удалить</button>
                      </div>
                    );
                  })}
                </div>

                {/* Версии */}
                <h2 className="h-label" style={{ marginTop: 32 }}>Версии</h2>
                <div className="adm-card" style={{ marginTop: 12 }}>
                  <div className="ver-row">
                    <span className="v">Черновик</span>
                    <span className="tag draft">не опубликован</span>
                    <span className="meta">
                      {gates.errors.length === 0
                        ? `все проверки пройдены · ${quest.steps.length} страниц`
                        : `${gates.errors.length} ошибок блокируют публикацию`}
                    </span>
                    <button className="adm-btn adm-btn--sm" style={{ marginLeft: 12 }} onClick={() => setView('checklist')}>Чек-лист публикации</button>
                  </div>
                  {versions.map(v => (
                    <div className="ver-row" key={v.version}>
                      <span className="v">Версия {v.version}</span>
                      <span className={'tag ' + (v.live ? 'live' : 'old')}>{v.live ? 'текущая в магазине' : 'архив'}</span>
                      <span className="meta">
                        опубликована {v.publishedAt} · {v.pages} страниц
                        {!v.live && v.activeAttempts > 0 ? ` · ${v.activeAttempts} активных попыток остаются на ней` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Чек-лист публикации */}
            {view === 'checklist' && (
              <>
                <h2 className="h-label" style={{ marginTop: 28 }}>Публикация квеста</h2>
                <div className="adm-card" style={{ marginTop: 12 }}>
                  <div className="gate-list">
                    <div className={'gate-row ' + (quest.steps[0]?.template === 'start' && quest.steps.some(s => s.template === 'congrats') ? 'ok' : 'err')}>
                      <span className="st">{quest.steps[0]?.template === 'start' && quest.steps.some(s => s.template === 'congrats') ? '✓' : '✗'}</span>
                      <span>Структура: первый экран в начале, поздравление в конце</span>
                    </div>
                    {gates.errors.map((e, i) => (
                      <div className="gate-row err" key={i}>
                        <span className="st">✗</span>
                        <span>{e}</span>
                        <span className="fix"><button className="adm-btn adm-btn--sm adm-btn--outline" onClick={() => setView('pages')}>Исправить</button></span>
                      </div>
                    ))}
                    {gates.errors.length === 0 && (
                      <div className="gate-row ok"><span className="st">✓</span><span>Комикс задания и списки ответов на месте</span></div>
                    )}
                    {gates.warnings.map((w, i) => (
                      <div className="gate-row warn" key={i}><span className="st">!</span><span>{w}</span></div>
                    ))}
                    <div className="gate-row warn">
                      <span className="st">!</span>
                      <span>Оценка бандла приблизительная — реальные размеры появятся с медиа-хранилищем</span>
                    </div>
                  </div>
                  <div className="gate-sum">
                    <span className="est">Оценка бандла: ~{(quest.steps.length * 0.7).toFixed(1)} МБ · {quest.steps.length} страниц · цель ≤ 5 МБ</span>
                    <button className="adm-btn adm-btn--sm adm-btn--outline" onClick={dryRun}>Dry-run сериализации</button>
                    <button className="adm-btn adm-btn--sm adm-btn--outline" onClick={() => setView('pages')}>Назад</button>
                    <button className="adm-btn" disabled={gates.errors.length > 0} onClick={() => setPublishModalOpen(true)}>Опубликовать</button>
                  </div>
                  {dryRunResult && <p className="adm-helper" style={{ textAlign: 'left', marginTop: 10 }}>{dryRunResult}</p>}
                </div>
              </>
            )}

            {/* Редактор страницы */}
            {editingIndex !== null && quest.steps[editingIndex] && (() => {
              const ed = quest.steps[editingIndex];
              const edIdx = editingIndex;
              const update = (mut: (s: EditorStep) => void) => {
                const ns = [...quest.steps];
                mut(ns[edIdx]);
                setQuest({ ...quest, steps: ns });
              };
              const answers: string[] = ed.completion.acceptable || [];
              const setAnswers = (arr: string[]) => update(s => { s.completion.acceptable = arr; });
              const verdict = edTestValue.trim() ? isAnswerCorrect(edTestValue, answers) : null;
              const isAnswerTpl = ed.template === 'task_answer';
              const previewStep = {
                template: ed.template,
                title: ed.rich_content?.title,
                text: ed.rich_content?.main_text,
                prompt: ed.rich_content?.question_prompt,
                acceptable: answers,
                gift: ed.supporting?.gift,
                hint: ed.supporting?.hint ? { cost: ed.supporting.hint.cost_coins, text: ed.supporting.hint.reveal_text } : undefined,
                nav: ed.supporting?.navigator,
              };
              const applyPaste = () => {
                const lines = edPasteText.split('\n').map(s => s.trim()).filter(Boolean);
                if (lines.length) setAnswers(lines);
                setEdPasteOpen(false); setEdPasteText('');
              };
              return (
                <div style={{ marginTop: 28 }}>
                  <div className="ed-crumbs">
                    Квест <b>«{quest.name}»</b> · Страница <b>«{ed.rich_content?.title || TPL_NAME[ed.template]}»</b>
                    <span className="nav">
                      <button className="adm-btn adm-btn--sm adm-btn--outline" onClick={() => openEditor(Math.max(0, edIdx - 1))}>← Пред.</button>
                      <button className="adm-btn adm-btn--sm adm-btn--outline" onClick={() => openEditor(Math.min(quest.steps.length - 1, edIdx + 1))}>След. →</button>
                    </span>
                  </div>

                  <div className="ed-cols">
                    <div className="ed-form">
                      <div className="ed-block">
                        <h4>Шаблон <span className="chip">{TPL_NAME[ed.template]}</span></h4>
                        <div>
                          <label className="adm-label">Название страницы <small>служебное, игрок не видит</small></label>
                          <input className="adm-input adm-input--wide" style={{ height: 52, fontSize: 15 }} value={ed.rich_content.title || ''} onChange={e => update(s => { s.rich_content.title = e.target.value; })} />
                        </div>
                      </div>

                      <div className="ed-block">
                        <h4>Контент</h4>
                        <div>
                          <label className="adm-label">Текст задания</label>
                          <textarea className="adm-textarea" value={ed.rich_content.main_text || ''} onChange={e => update(s => { s.rich_content.main_text = e.target.value; })} />
                        </div>
                        {isAnswerTpl && (
                          <div>
                            <label className="adm-label">Плейсхолдер поля ответа</label>
                            <input className="adm-input adm-input--wide" style={{ height: 52, fontSize: 15 }} value={ed.rich_content.question_prompt || ''} onChange={e => update(s => { s.rich_content.question_prompt = e.target.value; })} />
                          </div>
                        )}
                      </div>

                      <div className="ed-block">
                        <h4>Комикс страницы <span className="opt">4 роли изображений</span></h4>
                        <div className="comic-grid">
                          <div className="comic-zone filled req">
                            {ed.media?.task ? <img src={ed.media.task} alt="" /> : null}
                            <span className="tag">задание</span>
                          </div>
                          <div className="comic-zone"><b>персонаж</b>PNG/JPG до 1 МБ</div>
                          <div className="comic-zone"><b>подсказка</b>откроется за монеты</div>
                          <div className="comic-zone"><b>атмосфера</b>фон страницы</div>
                        </div>
                      </div>

                      {isAnswerTpl && (
                        <div className="ed-block">
                          <h4>Ответы <span className="opt">регистр и пробелы по краям не важны</span></h4>
                          {answers.map((a, i) => (
                            <div className="ans-row" key={i}>
                              <input className="adm-input" value={a} onChange={e => setAnswers(answers.map((x, j) => j === i ? e.target.value : x))} />
                              <button className="del" onClick={() => setAnswers(answers.filter((_, j) => j !== i))}>✕</button>
                            </div>
                          ))}
                          <div className="ans-add">
                            <button className="adm-btn adm-btn--sm adm-btn--outline" onClick={() => setAnswers([...answers, ''])}>+ Добавить ответ</button>
                            <button className="adm-btn adm-btn--sm adm-btn--outline" onClick={() => setEdPasteOpen(!edPasteOpen)}>Вставить строками</button>
                          </div>
                          {edPasteOpen && (
                            <div>
                              <textarea className="adm-textarea" placeholder={"один ответ на строку\n1730\nв 1730"} value={edPasteText} onChange={e => setEdPasteText(e.target.value)} />
                              <button className="adm-btn adm-btn--sm" style={{ marginTop: 8 }} onClick={applyPaste}>Заменить список</button>
                            </div>
                          )}
                          <div className="ans-test">
                            <input className="adm-input" placeholder="Тест: введите ответ как игрок…" value={edTestValue} onChange={e => setEdTestValue(e.target.value)} />
                            {verdict === null
                              ? <span className="ans-verdict">—</span>
                              : verdict
                                ? <span className="ans-verdict ok">✓ зачтено</span>
                                : <span className="ans-verdict no">✗ не зачтено</span>}
                          </div>
                          <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12 }}>Проверяет та же функция, что и в плеере — что зачтено здесь, зачтётся игроку.</p>
                        </div>
                      )}

                      <div className="ed-block">
                        <h4>Подарок за выполнение</h4>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                          <div>
                            <label className="adm-label">Монеты</label>
                            <input type="number" className="adm-input adm-input--sm" value={ed.supporting?.gift?.coins ?? 5} onChange={e => update(s => { s.supporting = { ...(s.supporting || {}), gift: { coins: +e.target.value || 0, narrative_text: s.supporting?.gift?.narrative_text || '' } }; })} />
                          </div>
                          <div style={{ flex: 1, minWidth: 220 }}>
                            <label className="adm-label">Подпись к награде</label>
                            <input className="adm-input adm-input--wide adm-input--sm" value={ed.supporting?.gift?.narrative_text || ''} onChange={e => update(s => { s.supporting = { ...(s.supporting || {}), gift: { coins: s.supporting?.gift?.coins ?? 5, narrative_text: e.target.value } }; })} />
                          </div>
                        </div>
                        <p className="freeze-note">Сумма заморозится в снапшоте при публикации.</p>
                      </div>

                      {isAnswerTpl && (
                        <div className="ed-block">
                          <h4>Подсказка <span className="opt">появится в попапе после 2-й ошибки</span></h4>
                          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                            <div>
                              <label className="adm-label">Стоимость, монет</label>
                              <input type="number" className="adm-input adm-input--sm" value={ed.supporting?.hint?.cost_coins ?? 5} onChange={e => update(s => { s.supporting = { ...(s.supporting || {}), hint: { cost_coins: +e.target.value || 0, reveal_text: s.supporting?.hint?.reveal_text || '' } }; })} />
                            </div>
                            <div style={{ flex: 1, minWidth: 220 }}>
                              <label className="adm-label">Текст подсказки</label>
                              <input className="adm-input adm-input--wide adm-input--sm" value={ed.supporting?.hint?.reveal_text || ''} onChange={e => update(s => { s.supporting = { ...(s.supporting || {}), hint: { cost_coins: s.supporting?.hint?.cost_coins ?? 5, reveal_text: e.target.value } }; })} />
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="ed-block">
                        <h4>Навигатор <span className="opt">обычно для заданий без ответа</span></h4>
                        <button
                          type="button"
                          className={'adm-toggle' + (ed.supporting?.navigator ? ' on' : '')}
                          style={{ background: 'none', border: 'none', padding: 0 }}
                          onClick={() => update(s => { s.supporting = { ...(s.supporting || {}), navigator: s.supporting?.navigator ? undefined : { lat: 45.2551, lng: 19.8451, label: 'Точка' } }; })}
                        >
                          <span className="tk" />Кнопка навигатора на странице
                        </button>
                        {ed.supporting?.navigator && (
                          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                            <div>
                              <label className="adm-label" style={{ fontSize: 13 }}>Широта</label>
                              <input className="adm-input adm-input--sm" value={ed.supporting.navigator.lat} onChange={e => update(s => { s.supporting!.navigator!.lat = parseFloat(e.target.value) || 0; })} />
                            </div>
                            <div>
                              <label className="adm-label" style={{ fontSize: 13 }}>Долгота</label>
                              <input className="adm-input adm-input--sm" value={ed.supporting.navigator.lng} onChange={e => update(s => { s.supporting!.navigator!.lng = parseFloat(e.target.value) || 0; })} />
                            </div>
                            <div style={{ flex: 1, minWidth: 160 }}>
                              <label className="adm-label" style={{ fontSize: 13 }}>Подпись точки</label>
                              <input className="adm-input adm-input--wide adm-input--sm" value={ed.supporting.navigator.label || ''} onChange={e => update(s => { s.supporting!.navigator!.label = e.target.value; })} />
                            </div>
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <button className="adm-btn" onClick={() => openEditor(null)}>Сохранить</button>
                        <button className="adm-btn adm-btn--outline" onClick={saveAndTest}>Открыть как тест-игрок</button>
                        <button className="adm-btn adm-btn--danger" onClick={() => setDeleteTarget(edIdx)}>Удалить страницу</button>
                      </div>
                      <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12 }}>Изменения в черновике — игроки увидят только после публикации новой версии.</p>
                    </div>

                    {/* Живое превью телефона (масштаб 0.889 из дизайна) */}
                    <div className="ed-preview">
                      <p className="cap">Живое превью — настоящие компоненты плеера</p>
                      <div className="ed-phone">
                        <PlayerFrame tw={{ art: 'paper', layout: 'image', anims: false }}>
                          {ed.template !== 'start' && <TopBar pos={edIdx + 1} total={quest.steps.length} coins={13} />}
                          <StepView
                            step={previewStep}
                            quest={{ city: 'Нови Сад', duration: '90 минут' }}
                            copy={{ next: 'продолжить', submit: 'Ответить' }}
                            st={{ hintRevealed: edPreviewHint }}
                            on={{}}
                          />
                        </PlayerFrame>
                      </div>
                      <button
                        type="button"
                        className={'adm-toggle' + (edPreviewHint ? ' on' : '')}
                        style={{ background: 'none', border: 'none', padding: 0, alignSelf: 'center' }}
                        onClick={() => setEdPreviewHint(!edPreviewHint)}
                      >
                        <span className="tk" />Показать с купленной подсказкой
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* SETTINGS TAB */}
          <div data-tab="tab-settings" className="tab-panel">
            <div className="qs-grid">
              <div>
                <div className="qs-field"><label>Введите название локации:</label><input className="field-ui" placeholder="Нови Сад, Сербия" /></div>
                <div className="qs-field"><label>Продолжительность:</label><input className="field-ui" placeholder="1.5 часа" /></div>
                <div className="qs-field"><label>Сложность:</label><select className="field-ui"><option>Средняя</option></select></div>
                <div className="qs-field"><label>Стоимость (0 = бесплатно):</label><input className="field-ui" placeholder="300" /></div>
              </div>
              <div>
                <div className="qs-field"><label>Фото для магазина</label><Dropzone /></div>
                <div className="qs-field"><label>Доп. изображение</label><Dropzone /></div>
              </div>
            </div>
          </div>
        </TabGroup>
      </main>

      {/* Модалка публикации */}
      {publishModalOpen && (
        <div className="adm-overlay">
          <div className="adm-modal">
            <h3>Опубликовать версию {nextVersion}?</h3>
            <ul>
              <li>Тексты, изображения, ответы и суммы заморозятся в неизменяемый снапшот.</li>
              <li>Новые попытки начнутся на версии {nextVersion}; активные остаются на своих версиях.</li>
              <li>Отката нет — ошибки исправляются следующей версией.</li>
            </ul>
            <p className="note">Бандл версии {nextVersion} соберётся автоматически и станет доступен для скачивания.</p>
            <div className="row">
              <button className="adm-btn adm-btn--sm adm-btn--outline" onClick={() => setPublishModalOpen(false)}>Отмена</button>
              <button className="adm-btn adm-btn--sm" onClick={confirmPublish}>Опубликовать v{nextVersion}</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={deleteTarget !== null}
        message={<>Внимание! Вы подтверждаете удаление страницы <b>#{deleteTarget !== null ? deleteTarget + 1 : ''}</b>?</>}
        onConfirm={() => deleteTarget !== null && deleteStep(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
