'use client';

import React, { useEffect, useState } from 'react';
import {
  COMIC_ROLES,
  TPL_BY_KEY,
  plural,
  type CtorQuest,
  type CtorStep,
  type GateField,
} from '../../lib/constructor-model';
import { isAnswerCorrect } from '../../lib/shared-model';
import { PPlay } from '../player/PlayerComponents';
import { ImageZone, WspBlock, WspDanger, WspToggle } from './controls';

type StepPatch = Partial<CtorStep>;
type Patcher = (patch: StepPatch) => void;

/* ---------- Комикс страницы ---------- */

function ComicBlock({ step, onPatch }: { step: CtorStep; onPatch: Patcher }) {
  const roles = COMIC_ROLES[step.template] || [];
  if (!roles.length) return null;
  const set = (key: string, value: string | null) => onPatch({ images: { ...step.images, [key]: value } });
  const cols = roles.length === 1 ? 'repeat(2, 1fr)' : roles.length === 3 ? 'repeat(3, 1fr)' : 'repeat(4, 1fr)';
  return (
    <WspBlock title="Комикс страницы" gateField="comic" aside={roles.length > 1 ? `${roles.length} роли изображений` : 'изображение'}>
      <div className="comic-grid" style={{ gridTemplateColumns: cols }}>
        {roles.map((r) => (
          <ImageZone
            key={r.key}
            src={step.images[r.key]}
            label={r.label}
            required={r.req}
            onChange={(src) => set(r.key, src)}
          />
        ))}
      </div>
      {step.template === 'task_answer' ? (
        <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12, margin: 0 }}>Роль «подсказка» игрок увидит только после покупки подсказки за монеты.</p>
      ) : null}
    </WspBlock>
  );
}

/* ---------- Видео-блок (метаданные; загрузка видео — вне MVP) ---------- */

function VideoBlock({ step, onPatch }: { step: CtorStep; onPatch: Patcher }) {
  const v = step.video || { dur: '', label: '' };
  const set = (patch: Partial<typeof v>) => onPatch({ video: { ...v, ...patch } });
  return (
    <WspBlock title="Видео" aside="инлайн-блок на странице, не отдельный экран">
      <div className="wsp-vidzone">
        <span className="ic-ring"><PPlay /></span>
        <span>{v.label || 'видео'}</span>
        <span className="dur">{v.dur || '0:00'}</span>
      </div>
      <div className="wsp-trow">
        <div>
          <label className="adm-label">Длительность</label>
          <input className="input input--compact" value={v.dur} onChange={(e) => set({ dur: e.target.value })} />
        </div>
        <div className="wsp-grow">
          <label className="adm-label">Подпись постера</label>
          <input className="input" value={v.label} onChange={(e) => set({ label: e.target.value })} />
        </div>
      </div>
      <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12, margin: 0 }}>Загрузка видео-файлов появится вместе с медиа-хранилищем; в бандле — постер и метаданные.</p>
    </WspBlock>
  );
}

/* ---------- Ответы + живой тест общим матчером ---------- */

function AnswersBlock({ step, onPatch }: { step: CtorStep; onPatch: Patcher }) {
  const answers = step.acceptable;
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [testValue, setTestValue] = useState('');
  const clean = answers.map((a) => a.trim()).filter(Boolean);
  const verdict = testValue.trim() ? isAnswerCorrect(testValue, clean) : null;
  const setAnswers = (arr: string[]) => onPatch({ acceptable: arr });
  const applyPaste = () => {
    const lines = pasteText.split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length) setAnswers(lines);
    setPasteOpen(false);
    setPasteText('');
  };
  return (
    <WspBlock title="Ответы" gateField="answers" aside="регистр и пробелы по краям не важны">
      {answers.map((a, i) => (
        <div className="ans-row" key={i}>
          <input className="input" value={a} onChange={(e) => setAnswers(answers.map((x, j) => (j === i ? e.target.value : x)))} />
          <button className="del" type="button" aria-label="Удалить ответ" onClick={() => setAnswers(answers.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div className="ans-add">
        <button className="btn btn--secondary btn--sm" type="button" onClick={() => setAnswers([...answers, ''])}>+ Добавить ответ</button>
        <button className="btn btn--secondary btn--sm" type="button" onClick={() => setPasteOpen(!pasteOpen)}>Вставить строками</button>
      </div>
      {pasteOpen ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <textarea className="textarea" placeholder={'один ответ на строку\n1730\nв 1730'} value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
          <button className="btn btn--sm" type="button" style={{ alignSelf: 'flex-start' }} onClick={applyPaste}>Заменить список</button>
        </div>
      ) : null}
      <div className="ans-test">
        <input className="input" placeholder="Тест: введите ответ как игрок…" value={testValue} onChange={(e) => setTestValue(e.target.value)} />
        {verdict === null
          ? <span className="ans-verdict" style={{ color: 'var(--muted)' }}>—</span>
          : verdict
            ? <span className="ans-verdict ok">✓ зачтено</span>
            : <span className="ans-verdict no">✗ не зачтено</span>}
      </div>
      <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12, margin: 0 }}>Проверяет та же функция, что и в плеере, — что зачтено здесь, зачтётся игроку.</p>
    </WspBlock>
  );
}

/* ---------- Подарок / Подсказка / Навигатор ---------- */

function GiftBlock({ step, onPatch }: { step: CtorStep; onPatch: Patcher }) {
  const g = step.gift;
  const set = (patch: Partial<typeof g>) => onPatch({ gift: { ...g, ...patch } });
  return (
    <WspBlock title="Подарок монет" aside="начислится при выполнении шага">
      <WspToggle on={g.on} onClick={() => set({ on: !g.on })} label="Дарить монеты за этот шаг" />
      {g.on ? (
        <>
          <div className="wsp-trow">
            <div>
              <label className="adm-label">Монеты</label>
              <input className="input input--compact" type="number" min={0} value={g.coins} onChange={(e) => set({ coins: Math.max(0, +e.target.value || 0) })} />
            </div>
            <div className="wsp-grow">
              <label className="adm-label">Подпись к награде<small>появится в тосте: «+5 монет · Острый глаз!»</small></label>
              <input className="input" value={g.narrative} onChange={(e) => set({ narrative: e.target.value })} />
            </div>
          </div>
          <p className="freeze-note">Сумма заморозится в снапшоте при публикации: игроки на этой версии всегда получат именно столько.</p>
        </>
      ) : null}
    </WspBlock>
  );
}

function HintBlock({ step, onPatch }: { step: CtorStep; onPatch: Patcher }) {
  const h = step.hint;
  const set = (patch: Partial<typeof h>) => onPatch({ hint: { ...h, ...patch } });
  return (
    <WspBlock title="Подсказка" gateField="hint" aside="попап после 2-й ошибки ответа">
      <WspToggle on={h.on} onClick={() => set({ on: !h.on })} label="Платная подсказка на этом шаге" />
      {h.on ? (
        <>
          <div className="wsp-trow">
            <div>
              <label className="adm-label">Стоимость, монет</label>
              <input className="input input--compact" type="number" min={0} value={h.cost} onChange={(e) => set({ cost: Math.max(0, +e.target.value || 0) })} />
            </div>
            <div className="wsp-grow">
              <label className="adm-label">Текст подсказки<small>останется открытым до конца шага вместе с комиксом «подсказка»</small></label>
              <input className="input" value={h.text} onChange={(e) => set({ text: e.target.value })} />
            </div>
          </div>
          <p className="freeze-note">Стоимость заморозится при публикации. Баланс игрока может уйти в минус — покупка никогда не блокируется.</p>
        </>
      ) : null}
    </WspBlock>
  );
}

function NavBlock({ step, onPatch }: { step: CtorStep; onPatch: Patcher }) {
  const n = step.nav;
  const set = (patch: Partial<typeof n>) => onPatch({ nav: { ...n, ...patch } });
  const bad = n.on && (!Number.isFinite(parseFloat(n.lat)) || !Number.isFinite(parseFloat(n.lng)));
  return (
    <WspBlock title="Навигатор" gateField="nav" aside="передача в системные карты, без маршрута в бандле">
      <WspToggle on={n.on} onClick={() => set({ on: !n.on })} label="Кнопка навигатора на странице" />
      {n.on ? (
        <>
          <div className="wsp-trow">
            <div>
              <label className="adm-label">Широта</label>
              <input className="input input--compact" value={n.lat} onChange={(e) => set({ lat: e.target.value })} />
            </div>
            <div>
              <label className="adm-label">Долгота</label>
              <input className="input input--compact" value={n.lng} onChange={(e) => set({ lng: e.target.value })} />
            </div>
            <div className="wsp-grow">
              <label className="adm-label">Подпись точки</label>
              <input className="input" value={n.label} onChange={(e) => set({ label: e.target.value })} />
            </div>
          </div>
          {bad ? <p style={{ margin: 0, fontSize: 12.5, color: 'var(--red)', fontWeight: 600 }}>✗ Координаты не заданы — публикация будет заблокирована.</p> : null}
        </>
      ) : null}
    </WspBlock>
  );
}

/* ---------- Контент-блоки по шаблонам ---------- */

function StartContent({ quest, step, set, onSettings }: { quest: CtorQuest; step: CtorStep; set: Patcher; onSettings: () => void }) {
  const m = quest.meta;
  return (
    <>
      <WspBlock title="Контент обложки">
        <div>
          <label className="adm-label">Надзаголовок<small>например «Городской квест»</small></label>
          <input className="input" value={step.kicker} onChange={(e) => set({ kicker: e.target.value })} />
        </div>
        <div>
          <label className="adm-label">Подзаголовок<small>строка под названием</small></label>
          <input className="input" value={step.text} onChange={(e) => set({ text: e.target.value })} />
        </div>
      </WspBlock>
      <WspBlock title="Из настроек квеста" aside="название, город, длительность, обложка">
        <div className="wsp-metacard">
          {m.cover
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={m.cover} alt="" />
            : <span className="mc-ph">нет обложки</span>}
          <span className="mc-body">
            <b>{m.title}</b><br />
            <span>{[m.city, m.duration].filter(Boolean).join(' · ') || 'город и длительность не заданы'}</span>
          </span>
          <button className="btn btn--secondary btn--sm" type="button" onClick={onSettings}>Открыть настройки</button>
        </div>
        <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12, margin: 0 }}>«Первый экран» собирается из общих настроек квеста — они меняются в одном месте и для магазина, и для плеера.</p>
      </WspBlock>
    </>
  );
}

function TaskNoContent({ step, set }: { step: CtorStep; set: Patcher }) {
  return (
    <WspBlock title="Контент">
      <div>
        <label className="adm-label">Текст задания</label>
        <textarea className="textarea" value={step.text} onChange={(e) => set({ text: e.target.value })} />
      </div>
      <div>
        <label className="adm-label">Адрес и расстояние<small>строка с булавкой, например «ул. Николаевска порта 2 · 400 м отсюда»</small></label>
        <input className="input" value={step.place} onChange={(e) => set({ place: e.target.value })} />
      </div>
      <div>
        <label className="adm-label">Действие на месте<small>необязательно</small></label>
        <input className="input" value={step.action.desc} onChange={(e) => set({ action: { ...step.action, desc: e.target.value } })} />
      </div>
      <div className="wsp-trow">
        <div className="wsp-grow">
          <label className="adm-label">Кнопка подтверждения</label>
          <input className="input" value={step.action.confirmLabel} onChange={(e) => set({ action: { ...step.action, confirmLabel: e.target.value } })} />
        </div>
        <div style={{ paddingBottom: 12 }}>
          <WspToggle on={step.allowNote} onClick={() => set({ allowNote: !step.allowNote })} label="Разрешить заметку" />
        </div>
      </div>
      <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12, margin: 0 }}>Подтверждение — на честность игрока: никакой проверки геолокации нет.</p>
    </WspBlock>
  );
}

/* ---------- Редактор страницы ---------- */

export function PageEditor({ quest, step, msgs, highlight, onPatch, onDelete, onDuplicate, onSettings }: {
  quest: CtorQuest;
  step: CtorStep;
  msgs: Array<{ kind: 'err' | 'warn'; text: string }> | undefined;
  /** §9.2: control to scroll to + flash after an «Исправить →» click. */
  highlight?: { field?: GateField; nonce: number } | null;
  onPatch: Patcher;
  onDelete: () => void;
  onDuplicate: () => void;
  onSettings: () => void;
}) {
  // Scroll to and flash the offending block. DOM query (not refs) keeps the
  // anchor declaration next to each block via WspBlock's gateField prop.
  useEffect(() => {
    if (!highlight?.field) return;
    const el = document.querySelector(`[data-gate-field="${highlight.field}"]`);
    if (!(el instanceof HTMLElement)) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('gate-flash');
    const t = setTimeout(() => el.classList.remove('gate-flash'), 2400);
    return () => clearTimeout(t);
  }, [highlight]);

  const tplMeta = TPL_BY_KEY[step.template];
  const set = onPatch;
  const errs = (msgs || []).filter((m) => m.kind === 'err');
  const tpl = step.template;
  return (
    <div className="ed-form">
      <div className="wsp-edhead">
        <span className="wsp-tplchip">{tplMeta.name}</span>
        {errs.length
          ? <span className="wsp-gatechip err">✗ {errs.length} {plural(errs.length, 'ошибка', 'ошибки', 'ошибок')}</span>
          : <span className="wsp-gatechip ok">✓ готова к публикации</span>}
        <span style={{ flex: 1 }} />
        <button className="btn btn--secondary btn--sm" type="button" onClick={onDuplicate}>Дублировать</button>
        <WspDanger label="Удалить" confirmLabel="Точно удалить?" onConfirm={onDelete} />
      </div>

      {errs.length ? (
        <div className="wsp-pageerrs">
          {errs.map((e, i) => <span key={i}>✗ {e.text}</span>)}
        </div>
      ) : null}

      <WspBlock title="Страница">
        <div>
          <label className="adm-label">Название<small>служебное, игрок не видит</small></label>
          <input className="input" value={step.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
      </WspBlock>

      {tpl === 'start' ? <StartContent quest={quest} step={step} set={set} onSettings={onSettings} /> : null}

      {tpl === 'video' || tpl === 'route_video' ? (
        <>
          <VideoBlock step={step} onPatch={set} />
          <WspBlock title="Контент">
            <div>
              <label className="adm-label">Текст под видео</label>
              <textarea className="textarea" value={step.text} onChange={(e) => set({ text: e.target.value })} />
            </div>
          </WspBlock>
        </>
      ) : null}

      {tpl === 'task_no' ? <TaskNoContent step={step} set={set} /> : null}

      {tpl === 'task_answer' ? (
        <WspBlock title="Контент">
          <div>
            <label className="adm-label">Текст задания</label>
            <textarea className="textarea" value={step.text} onChange={(e) => set({ text: e.target.value })} />
          </div>
          <div>
            <label className="adm-label">Вопрос<small>показывается над полем ответа</small></label>
            <input className="input" value={step.prompt} onChange={(e) => set({ prompt: e.target.value })} />
          </div>
        </WspBlock>
      ) : null}

      {tpl === 'continue' ? (
        <WspBlock title="Контент">
          <div>
            <label className="adm-label">Текст<small>поддерживает абзацы — пустая строка между ними</small></label>
            <textarea className="textarea" style={{ minHeight: 140 }} value={step.text} onChange={(e) => set({ text: e.target.value })} />
          </div>
        </WspBlock>
      ) : null}

      {tpl === 'congrats' ? (
        <>
          <WspBlock title="Контент финала">
            <div>
              <label className="adm-label">Заголовок</label>
              <input className="input" value={step.title} onChange={(e) => set({ title: e.target.value })} />
            </div>
            <div>
              <label className="adm-label">Финальный текст<small>развязка истории</small></label>
              <textarea className="textarea" value={step.text} onChange={(e) => set({ text: e.target.value })} />
            </div>
          </WspBlock>
          <WspBlock title="Встроено в шаблон" aside="настраивается платформой, не квестом">
            <p className="freeze-note" style={{ margin: 0 }}>+5 монет — бонус за первое прохождение (идемпотентно: повторные прохождения бонус не дублируют).</p>
            <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12, margin: 0 }}>Итоги (монеты, время, шаги) и блок оценки ★★★★★ встроены в шаблон — видно в превью справа.</p>
          </WspBlock>
        </>
      ) : null}

      <ComicBlock step={step} onPatch={set} />

      {tpl === 'task_answer' ? <AnswersBlock step={step} onPatch={set} /> : null}
      {tpl === 'task_no' || tpl === 'task_answer' ? <GiftBlock step={step} onPatch={set} /> : null}
      {tpl === 'task_answer' ? <HintBlock step={step} onPatch={set} /> : null}
      {tpl === 'task_no' || tpl === 'task_answer' || tpl === 'route_video' || tpl === 'video' ? <NavBlock step={step} onPatch={set} /> : null}

      <p className="adm-helper" style={{ textAlign: 'left', margin: 0 }}>Автосохранение в черновик. Игроки увидят изменения только после публикации новой версии.</p>
    </div>
  );
}
