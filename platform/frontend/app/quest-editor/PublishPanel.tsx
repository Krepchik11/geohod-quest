'use client';

import React, { useState } from 'react';
import {
  nextVersionNumber,
  parseCoords,
  plural,
  serializeDraft,
  type CtorQuest,
  type GateField,
  type Gates,
} from '../../lib/constructor-model';

interface ChecklistRow {
  st: 'ok' | 'err' | 'warn';
  text: string;
  pageId?: string | null;
  field?: GateField;
}

/** Чек-лист: зелёные строки за пройденные группы гейтов + все ошибки/предупреждения. */
function buildChecklist(quest: CtorQuest, gates: Gates): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  const structErr = gates.errors.some((e) => !e.pageId);
  if (!structErr) rows.push({ st: 'ok', text: 'Структура: «Первый экран» в начале, есть терминальное «Поздравление»' });
  const tasks = quest.steps.filter((s) => s.template === 'task_no' || s.template === 'task_answer');
  if (tasks.length && tasks.every((s) => s.image)) {
    rows.push({ st: 'ok', text: `Комикс «задание» загружен у всех страниц-заданий (${tasks.length} из ${tasks.length})` });
  }
  const answers = quest.steps.filter((s) => s.template === 'task_answer');
  if (answers.length && answers.every((s) => s.acceptable.some((a) => a.trim()))) {
    rows.push({ st: 'ok', text: 'Списки ответов заполнены у всех «Заданий с ответом»' });
  }
  const addresses = quest.steps.filter((s) => s.address.on);
  if (addresses.length && addresses.every((s) => s.address.name.trim() && parseCoords(s.address.coords))) {
    rows.push({ st: 'ok', text: `Адреса: название и координаты заданы у всех включённых точек (${addresses.length})` });
  }
  gates.errors.forEach((e) => rows.push({ st: 'err', text: e.text, pageId: e.pageId, field: e.field }));
  gates.warnings.forEach((w) => rows.push({ st: 'warn', text: w.text, pageId: w.pageId, field: w.field }));
  try {
    serializeDraft(quest);
    rows.push({ st: 'ok', text: 'Dry-run сериализации: снапшот собирается без ошибок' });
  } catch (e) {
    rows.push({ st: 'err', text: `Dry-run сериализации упал: ${(e as Error).message}` });
  }
  return rows;
}

function PublishModal({ nextN, size, onCancel, onConfirm }: {
  nextN: number;
  size: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="wsp-ovl" onClick={onCancel}>
      <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Опубликовать версию {nextN}?</h3>
        <ul>
          <li>Создаётся <b>неизменяемый снапшот</b>: тексты, комиксы, списки ответов, суммы монет и стоимость подсказок замораживаются.</li>
          <li>Новые попытки игроков начнутся на версии {nextN}. Активные попытки останутся на своих версиях.</li>
          <li>Откатить нельзя — исправления выходят следующей версией.</li>
        </ul>
        <p className="note">Бандл версии {nextN} (~{size}) соберётся и станет доступен для скачивания сразу после публикации.</p>
        <div className="row">
          <button className="btn btn--secondary btn--sm" type="button" onClick={onCancel}>Отмена</button>
          <button className="btn btn--md" type="button" onClick={onConfirm}>Опубликовать v{nextN}</button>
        </div>
      </div>
    </div>
  );
}

export function PublishPanel({ quest, gates, justPublished, publishError, publishing, onFix, onPublish }: {
  quest: CtorQuest;
  gates: Gates;
  justPublished: number | null;
  publishError: string | null;
  publishing: boolean;
  /** §9.2: navigate to the page (or settings for pageId null) and focus `field`. */
  onFix: (pageId: string | null, field?: GateField) => void;
  onPublish: () => void;
}) {
  const rows = buildChecklist(quest, gates);
  // «Стр. 4 · …» prefix: the page's 1-based position; structural rows say where they lead.
  const pageNo = (pageId: string | null | undefined): string | null => {
    if (!pageId) return null;
    const i = quest.steps.findIndex((st) => st.id === pageId);
    return i >= 0 ? `Стр. ${i + 1}` : null;
  };
  const errN = gates.errors.length;
  const [modal, setModal] = useState(false);
  const nextN = nextVersionNumber(quest);
  return (
    <div className="ed-form">
      <div className="wsp-edhead">
        <span className="wsp-tplchip">Публикация и версии</span>
        {errN
          ? <span className="wsp-gatechip err">✗ {errN} {plural(errN, 'ошибка блокирует', 'ошибки блокируют', 'ошибок блокируют')} публикацию</span>
          : <span className="wsp-gatechip ok">✓ гейты пройдены</span>}
      </div>

      {justPublished ? (
        <div className="wsp-banner">✓ Версия {justPublished} опубликована. Новые попытки игроков начнутся на ней; активные останутся на своих версиях.</div>
      ) : null}
      {publishError ? (
        <div className="wsp-error">✗ Публикация не удалась: {publishError}</div>
      ) : null}

      <div className="ed-block">
        <h4>Чек-лист публикации <span className="opt">ошибки блокируют, предупреждения — нет</span></h4>
        <div className="gate-list">
          {rows.map((g, i) => {
            const fixable = g.st !== 'ok' && (g.pageId || g.field);
            if (!fixable) {
              return (
                <div className={'gate-row ' + g.st} key={i}>
                  <span className="st">{g.st === 'ok' ? '✓' : g.st === 'err' ? '✗' : '!'}</span>
                  <span>{g.text}</span>
                </div>
              );
            }
            const no = pageNo(g.pageId) ?? (g.field === 'cover' ? 'Настройки' : 'Структура');
            return (
              <button
                type="button"
                className={'gate-row gate-row--fix ' + g.st}
                key={i}
                onClick={() => onFix(g.pageId ?? null, g.field)}
              >
                <span className="st">{g.st === 'err' ? '✗' : '!'}</span>
                <span><b className="gate-row__no">{no}</b> · {g.text}</span>
                <span className="gate-row__go">Исправить →</span>
              </button>
            );
          })}
        </div>
        <div className="gate-sum">
          <span className="est">Оценка бандла: ~{gates.sizeLabel} · {quest.steps.length} {plural(quest.steps.length, 'страница', 'страницы', 'страниц')} · {gates.imgs} изобр. · {gates.vids} видео · цель ≤ 5 МБ</span>
          <button className="btn btn--md" type="button" disabled={errN > 0 || publishing} onClick={() => setModal(true)}>
            {publishing
              ? 'Публикуем…'
              : errN > 0
                ? `Опубликовать (${errN} ${plural(errN, 'ошибка', 'ошибки', 'ошибок')})`
                : `Опубликовать v${nextN}`}
          </button>
        </div>
      </div>

      <div className="ed-block">
        <h4>Версии</h4>
        <div className="ver-row">
          <span className="v">Черновик</span>
          <span className={'tag ' + (errN ? 'draft' : 'live')}>{errN ? `${errN} ${plural(errN, 'ошибка', 'ошибки', 'ошибок')} гейтов` : 'готов к публикации'}</span>
          <span className="meta">{quest.steps.length} страниц · ~{gates.sizeLabel}</span>
        </div>
        {quest.versions.map((v) => (
          <div className="ver-row" key={v.n}>
            <span className="v">Версия {v.n}</span>
            {v.live ? <span className="tag live">текущая в магазине</span> : <span className="tag old">архив</span>}
            <span className="meta">{v.date} · {v.pages} страниц · {v.size}{v.attempts ? ` · ${v.attempts} ${plural(v.attempts, 'активная попытка', 'активные попытки', 'активных попыток')}` : ''}</span>
          </div>
        ))}
        <p className="adm-helper" style={{ textAlign: 'left', margin: '8px 0 0' }}>Версии неизменяемы: исправление = новая публикация. Игроки на старых версиях продолжают со своими правилами и суммами.</p>
      </div>

      {modal ? (
        <PublishModal
          nextN={nextN}
          size={gates.sizeLabel}
          onCancel={() => setModal(false)}
          onConfirm={() => { setModal(false); onPublish(); }}
        />
      ) : null}
    </div>
  );
}
