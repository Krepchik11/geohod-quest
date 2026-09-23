'use client';

import React, { useState } from 'react';
import {
  GIFT_COINS,
  IMAGE_TEMPLATES,
  TPL_BY_KEY,
  parseCoords,
  type CtorQuest,
  type CtorQuestMeta,
  type CtorStep,
  type GateField,
} from '../../lib/constructor-model';
import { plural } from '../../lib/ru';
import { byteBudgetLabel, STEP_IMAGE_MAX_BYTES } from '../../lib/image-crop';
import { isAnswerCorrect } from '../../lib/shared-model';
import { PPlay } from '../player/PlayerComponents';
import { GateNote, ImageZone, QuestCoverZone, WspBlock, WspDanger, WspToggle, useGateHighlight } from './controls';

type StepPatch = Partial<CtorStep>;
type Patcher = (patch: StepPatch) => void;

/* ---------- Изображение страницы ---------- */

function StepImageBlock({ step, onPatch }: { step: CtorStep; onPatch: Patcher }) {
  const slot = IMAGE_TEMPLATES[step.template];
  if (!slot) return null;
  return (
    <WspBlock title="Изображение страницы" gateField="image" aside={`4:3, до ${byteBudgetLabel(STEP_IMAGE_MAX_BYTES)}`}>
      <div className="comic-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <ImageZone
          value={{ url: step.image, origin: step.imageOrigin }}
          label={slot.label}
          required={slot.req}
          maxBytes={STEP_IMAGE_MAX_BYTES}
          onChange={(v) => onPatch({ image: v.url, imageOrigin: v.origin })}
        />
      </div>
      <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12, margin: 0 }}>Кадр 4:3 выбирается при загрузке — клик по изображению открывает его снова; больше {byteBudgetLabel(STEP_IMAGE_MAX_BYTES)} сожмём автоматически.</p>
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

function AnswersBlock({ step, universalAnswer, onPatch }: { step: CtorStep; universalAnswer: string; onPatch: Patcher }) {
  const answers = step.acceptable;
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [testValue, setTestValue] = useState('');
  const clean = answers.map((a) => a.trim()).filter(Boolean);
  // Вердикт плеера: список шага + универсальный ответ квеста. Платформенный
  // универсальный ответ здесь сознательно не участвует — тест черновика не
  // должен зависеть от рантайм-настройки админа.
  const inList = isAnswerCorrect(testValue, clean);
  const viaUniversal = !inList && isAnswerCorrect(testValue, [universalAnswer]);
  const verdict = testValue.trim() ? inList || viaUniversal : null;
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
            ? <span className="ans-verdict ok">{viaUniversal ? '✓ зачтено (универсальный ответ)' : '✓ зачтено'}</span>
            : <span className="ans-verdict no">✗ не зачтено</span>}
      </div>
      <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12, margin: 0 }}>Проверяет та же функция, что и в плеере, — что зачтено здесь, зачтётся игроку.</p>
    </WspBlock>
  );
}

/* ---------- Подарок / Подсказка / Навигатор ---------- */

function GiftBlock({ step, onPatch }: { step: CtorStep; onPatch: Patcher }) {
  return (
    <WspBlock title="Подарок монет" aside="начислится при выполнении шага">
      <div className="wsp-trow">
        <div>
          <label className="adm-label">Монеты<small>фиксировано платформой</small></label>
          <input className="input input--compact" value={GIFT_COINS} disabled />
        </div>
        <div className="wsp-grow">
          <label className="adm-label">Подпись к награде<small>появится в тосте: «+{GIFT_COINS} монет · Острый глаз!»</small></label>
          <input className="input" value={step.gift.narrative} onChange={(e) => onPatch({ gift: { narrative: e.target.value } })} />
        </div>
      </div>
      <p className="freeze-note">Каждый шаг-задание дарит {GIFT_COINS} монет — всегда, сумма едина для всех квестов.</p>
    </WspBlock>
  );
}

function HintBlock({ step, onPatch }: { step: CtorStep; onPatch: Patcher }) {
  const h = step.hint;
  const set = (patch: Partial<typeof h>) => onPatch({ hint: { ...h, ...patch } });
  return (
    <WspBlock title="Подсказка" gateField="hint" aside="попап после каждой ошибки ответа">
      <WspToggle on={h.on} onClick={() => set({ on: !h.on })} label="Подсказка на этом шаге" />
      {h.on ? (
        <>
          <div className="wsp-trow">
            <div>
              <label className="adm-label">Стоимость, монет</label>
              <input className="input input--compact" type="number" min={0} value={h.cost} onChange={(e) => set({ cost: Math.max(0, +e.target.value || 0) })} />
            </div>
            <div className="wsp-grow">
              <label className="adm-label">Текст подсказки<small>останется открытым до конца шага</small></label>
              <input className="input" value={h.text} onChange={(e) => set({ text: e.target.value })} />
            </div>
          </div>
          <div className="comic-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <ImageZone
              value={{ url: h.image, origin: h.imageOrigin }}
              label="изображение подсказки"
              maxBytes={STEP_IMAGE_MAX_BYTES}
              onChange={(v) => set({ image: v.url, imageOrigin: v.origin })}
            />
          </div>
          <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12, margin: 0 }}>Подсказка может быть текстом, изображением или обоими сразу; игрок увидит её попапом и под вопросом. Без текста и изображения подсказка не продаётся.</p>
          <p className="freeze-note">Стоимость заморозится при публикации. Баланс игрока может уйти в минус — покупка никогда не блокируется.</p>
        </>
      ) : (
        <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12, margin: 0 }}>Подсказка выключена — игрок решает задание без покупки помощи.</p>
      )}
    </WspBlock>
  );
}

function AddressBlock({ step, onPatch }: { step: CtorStep; onPatch: Patcher }) {
  const a = step.address;
  const set = (patch: Partial<typeof a>) => onPatch({ address: { ...a, ...patch } });
  const badCoords = a.on && !parseCoords(a.coords);
  const badName = a.on && !a.name.trim();
  return (
    <WspBlock title="Адрес и расстояние" gateField="address" aside="строка с булавкой; клик открывает системные карты">
      <WspToggle on={a.on} onClick={() => set({ on: !a.on })} label="Адрес на странице" />
      {a.on ? (
        <>
          <div className="wsp-trow">
            <div className="wsp-grow">
              <label className="adm-label">Название<small>например «ул. Николаевска порта 2»; оно же — подпись точки на карте</small></label>
              <input className="input" value={a.name} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div>
              <label className="adm-label">Расстояние<small>необязательно</small></label>
              <input className="input input--compact" placeholder="400 м отсюда" value={a.distance} onChange={(e) => set({ distance: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="adm-label">Координаты<small>вставьте из Google Maps: правый клик по точке → первая строка</small></label>
            <input className="input" placeholder="45.2651377918879, 19.865664144668212" value={a.coords} onChange={(e) => set({ coords: e.target.value })} />
          </div>
          {badName ? <GateNote>Название не задано</GateNote> : null}
          {badCoords ? <GateNote>Координаты не заданы</GateNote> : null}
          <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12, margin: 0 }}>Игрок увидит «название · расстояние»; нажатие на строку передаёт координаты в системные карты — маршрута в бандле нет.</p>
        </>
      ) : null}
    </WspBlock>
  );
}

/* ---------- Контент-блоки по шаблонам ---------- */

function StartContent({ quest, step, set, onMeta, onSettings }: {
  quest: CtorQuest;
  step: CtorStep;
  set: Patcher;
  onMeta: (meta: CtorQuestMeta) => void;
  onSettings: () => void;
}) {
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
          {/* Обложка — содержимое этой страницы, поэтому она здесь не картинка-
              напоминание, а тот же контрол, что и в настройках: клик кадрирует. */}
          <QuestCoverZone meta={m} onMeta={onMeta} compact />
          <span className="mc-body">
            <b>{m.title}</b><br />
            <span>{[m.city, m.duration].filter(Boolean).join(' · ') || 'город и длительность не заданы'}</span>
          </span>
          <button className="btn btn--secondary btn--sm" type="button" onClick={onSettings}>Открыть настройки</button>
        </div>
        <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12, margin: 0 }}>«Первый экран» собирается из общих настроек квеста — они меняются в одном месте и для магазина, и для плеера. Обложка правится и отсюда: это то же поле, что в настройках.</p>
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
        <label className="adm-label">Действие на месте<small>необязательно</small></label>
        <input className="input" value={step.action.desc} onChange={(e) => set({ action: { ...step.action, desc: e.target.value } })} />
      </div>
      <div>
        <label className="adm-label">Кнопка подтверждения</label>
        <input className="input" value={step.action.confirmLabel} onChange={(e) => set({ action: { ...step.action, confirmLabel: e.target.value } })} />
      </div>
      <p className="adm-helper" style={{ textAlign: 'left', fontSize: 12, margin: 0 }}>Подтверждение — на честность игрока: никакой проверки геолокации нет.</p>
    </WspBlock>
  );
}

/* ---------- Редактор страницы ---------- */

export function PageEditor({ quest, step, msgs, highlight, onMeta, onPatch, onDelete, onDuplicate, onSettings }: {
  quest: CtorQuest;
  step: CtorStep;
  msgs: Array<{ kind: 'err' | 'warn'; text: string }> | undefined;
  /** §9.2: control to scroll to + flash after an «Исправить →» click. */
  highlight?: { field?: GateField; nonce: number } | null;
  /** «Первый экран» правит обложку — общее поле квеста, не поле шага. */
  onMeta: (meta: CtorQuestMeta) => void;
  onPatch: Patcher;
  onDelete: () => void;
  onDuplicate: () => void;
  onSettings: () => void;
}) {
  useGateHighlight(highlight);

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

      <StepImageBlock step={step} onPatch={set} />

      {tpl === 'start' ? <StartContent quest={quest} step={step} set={set} onMeta={onMeta} onSettings={onSettings} /> : null}

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
          <div>
            <label className="adm-label">Текст кнопки<small>необязательно</small></label>
            <input className="input" placeholder="продолжить" value={step.buttonLabel} onChange={(e) => set({ buttonLabel: e.target.value })} />
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

      {tpl === 'task_answer' ? <AnswersBlock step={step} universalAnswer={quest.meta.universalAnswer} onPatch={set} /> : null}
      {tpl === 'task_no' || tpl === 'task_answer' ? <GiftBlock step={step} onPatch={set} /> : null}
      {tpl === 'task_answer' ? <HintBlock step={step} onPatch={set} /> : null}
      {tpl === 'task_no' || tpl === 'task_answer' || tpl === 'route_video' || tpl === 'video' ? <AddressBlock step={step} onPatch={set} /> : null}

      <p className="adm-helper" style={{ textAlign: 'left', margin: 0 }}>Автосохранение в черновик. Игроки увидят изменения только после публикации новой версии.</p>
    </div>
  );
}
