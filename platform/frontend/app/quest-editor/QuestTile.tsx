'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { ConstructorQuestWire, CtorStatus } from '../../lib/api';
import {
  AGE_TARGET_LABEL,
  COMPLEXITY_LABEL,
  type CtorAgeTarget,
  type CtorComplexity,
} from '../../lib/constructor-model';
import { coverSrc, monogram } from '../../lib/cover';
import {
  editedAgo,
  factsLine,
  priceLabel,
  ratingLabel,
  tileAction,
} from '../../lib/quest-tiles';
import { formatNumber, plural } from '../../lib/ru';
import StatusControl from './StatusControl';
import { useEscape } from './controls';

export interface TileActions {
  onEdit: (id: string) => void;
  onRun: (q: ConstructorQuestWire) => void;
  onStatusChange: (q: ConstructorQuestWire, status: CtorStatus) => void;
  /** Публикация и «исправить ошибки» — панель публикации редактора (гейты). */
  onOpenPublish: (q: ConstructorQuestWire) => void;
  onSettings: (q: ConstructorQuestWire) => void;
  onCopyLink: (q: ConstructorQuestWire) => void;
  onDuplicate: (q: ConstructorQuestWire) => void;
  onExport: (q: ConstructorQuestWire) => void;
  /** Только администратору: передача — в настройках квеста в редакторе. */
  onTransfer?: (q: ConstructorQuestWire) => void;
  onDelete: (q: ConstructorQuestWire) => void;
}

/** Детерминированный градиент обложки без картинки — тот же, что в строках. */
function thumbBg(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 42% 60%), hsl(${(h + 38) % 360} 48% 44%))`;
}

/** Обложка или буква на градиенте — и когда картинки нет, и когда она не открылась. */
function TileCover({ name, cover }: { name: string; cover: string | null }) {
  const [broken, setBroken] = useState(false);
  const src = broken ? null : coverSrc(cover);
  return src ? (
    <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
  ) : (
    <span className="qct-mono" style={{ background: thumbBg(name) }}>
      <span>{monogram(name)}</span>
    </span>
  );
}

/** Плашка действия: правки не дошли до игроков, или черновик готов к публикации. */
function ActionBand({ q, onPublish }: { q: ConstructorQuestWire; onPublish: () => void }) {
  const action = tileAction(q);
  if (!action) return null;
  const changes = action.kind === 'changes';
  return (
    <div className={`qct-band ${changes ? 'qct-band--changes' : 'qct-band--ready'}`}>
      <span className="qct-band__dot" aria-hidden />
      <span className="qct-band__text">{changes ? 'Правки не опубликованы' : 'Готов к публикации'}</span>
      <button type="button" onClick={onPublish}>
        {changes ? `Опубликовать v${action.next}` : 'Опубликовать'}
      </button>
    </div>
  );
}

const IconPin = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" stroke="currentColor" strokeWidth="1.9" /><circle cx="12" cy="9.5" r="2.4" stroke="currentColor" strokeWidth="1.9" /></svg>
);
const IconSliders = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M4 7h10M18 7h2M4 17h2M10 17h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="16" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.8" /><circle cx="8" cy="17" r="2.2" stroke="currentColor" strokeWidth="1.8" /></svg>
);
const IconStar = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden><path fill="var(--star)" d="M12 3.2l2.6 5.5 6 .7-4.4 4.1 1.2 5.9L12 16.5l-5.4 2.9 1.2-5.9L3.4 9.4l6-.7z" /></svg>
);
const IconUser = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="12" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.8" /><path d="M5.5 19.5c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
);
const IconPencil = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M4 20h4L19 9l-4-4L4 16v4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>
);
const IconCheck = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const IconPlay = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><path d="M8 5.5v13l10.5-6.5z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>
);
const IconLink = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
);
const IconMore = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden><circle cx="5.5" cy="12" r="1.7" fill="currentColor" /><circle cx="12" cy="12" r="1.7" fill="currentColor" /><circle cx="18.5" cy="12" r="1.7" fill="currentColor" /></svg>
);

/** Индикаторы: магазин — рейтинг и игроки, тест — прохождения, черновик — проверки. */
function Indicators({ q, actions, nowMs }: { q: ConstructorQuestWire; actions: TileActions; nowMs: number }) {
  let left: React.ReactNode = null;
  if (q.status === 'published') {
    left = (
      <>
        {q.rating_count > 0 ? (
          <span className="qct-ind__i" title="Средняя оценка и число оценок — как в магазине">
            <IconStar />
            <b>{ratingLabel(q.rating_avg)}</b>
            <span>({formatNumber(q.rating_count)})</span>
          </span>
        ) : (
          <span className="qct-ind__i">Оценок пока нет</span>
        )}
        <span className="qct-ind__i" title="Игроки — как на странице квеста в магазине">
          <IconUser />
          <b>{formatNumber(q.players)}</b>
        </span>
      </>
    );
  } else if (q.status === 'test') {
    left = (
      <span className="qct-ind__i">
        <IconUser />
        <b>{formatNumber(q.completed)}</b>
        {` ${plural(q.completed, 'прохождение', 'прохождения', 'прохождений')} в тесте`}
      </span>
    );
  } else if (q.gate_errors != null && q.gate_errors > 0) {
    left = (
      <button
        type="button"
        className="qct-ind__i qct-ind__link"
        title="Открыть панель публикации"
        onClick={() => actions.onOpenPublish(q)}
      >
        <span className="qct-ind__bad">
          {q.gate_errors} {plural(q.gate_errors, 'ошибка', 'ошибки', 'ошибок')}
        </span>
        {q.gate_warnings ? (
          <span className="qct-ind__warn">
            {q.gate_warnings} {plural(q.gate_warnings, 'замечание', 'замечания', 'замечаний')}
          </span>
        ) : null}
      </button>
    );
  } else if (q.gate_errors === 0) {
    left = (
      <span className="qct-ind__i qct-ind__ok">
        <IconCheck />
        Проверки пройдены
      </span>
    );
  }
  return (
    <div className="qct-ind">
      {left}
      <span className="qct-ind__when" title="Когда черновик сохраняли последний раз">
        <IconPencil /> {editedAgo(q.updated_at, nowMs)}
      </span>
    </div>
  );
}

/** Меню «⋯»: всё, что нужно реже, чем кнопки на плитке. */
function MoreMenu({ q, actions, onClose }: { q: ConstructorQuestWire; actions: TileActions; onClose: () => void }) {
  useEscape(onClose);
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const inShop = q.status === 'published' && q.published_version != null;
  return (
    <div className="qct-menu" role="menu">
      <button type="button" role="menuitem" className="qct-menu__item" onClick={run(() => actions.onSettings(q))}>
        <b>Быстрые настройки</b>
        <span>город, цена, время, описание, точка старта</span>
      </button>
      {inShop ? (
        <a
          role="menuitem"
          className="qct-menu__item"
          href={`/quest/${encodeURIComponent(q.quest_id)}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onClose}
        >
          <b>Открыть в магазине</b>
          <span>страница квеста, как у покупателя</span>
        </a>
      ) : null}
      <button type="button" role="menuitem" className="qct-menu__item" onClick={run(() => actions.onDuplicate(q))}>
        <b>Дублировать</b>
        <span>копия появится черновиком</span>
      </button>
      <button type="button" role="menuitem" className="qct-menu__item" onClick={run(() => actions.onExport(q))}>
        <b>Экспорт квеста</b>
        <span>архив со всеми страницами и картинками</span>
      </button>
      {actions.onTransfer ? (
        <button
          type="button"
          role="menuitem"
          className="qct-menu__item"
          onClick={run(() => actions.onTransfer?.(q))}
        >
          <b>Передать другому автору…</b>
          <span>в настройках квеста в редакторе</span>
        </button>
      ) : null}
      <div className="qct-menu__sep" />
      <button
        type="button"
        role="menuitem"
        className="qct-menu__item qct-menu__item--danger"
        onClick={run(() => actions.onDelete(q))}
      >
        <b>Удалить…</b>
        <span>с подтверждением, восстановить нельзя</span>
      </button>
    </div>
  );
}

/**
 * Плитка квеста (флаг ctor_tiles): обложка со статусом и плашкой действия,
 * настройки карточки магазина (весь блок — кнопка быстрых настроек), индикаторы
 * и быстрые кнопки. Компактный вид (телефон, «Строки») — та же разметка, его
 * раскладывает CSS: статус и плашка там идут отдельными строками.
 */
export default function QuestTile({
  q,
  actions,
  isAdmin,
  nowMs,
}: {
  q: ConstructorQuestWire;
  actions: TileActions;
  /** Администратор видит деньги: доступ и оплаты через сайт. */
  isAdmin: boolean;
  nowMs: number;
}) {
  const [menu, setMenu] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [menu]);

  const status = (
    <StatusControl
      quest={q}
      showVersion
      onStatusChange={(s) => actions.onStatusChange(q, s)}
      onOpenPublish={() => actions.onOpenPublish(q)}
    />
  );
  const band = <ActionBand q={q} onPublish={() => actions.onOpenPublish(q)} />;
  const chips: string[] = [];
  if (q.complexity !== 'medium') chips.push(COMPLEXITY_LABEL[q.complexity as CtorComplexity] ?? q.complexity);
  if (q.age_target !== 'everyone') chips.push(AGE_TARGET_LABEL[q.age_target as CtorAgeTarget] ?? q.age_target);
  const price = priceLabel(q.price);
  const linkOn = q.status === 'published' && q.published_version != null;

  return (
    <article className="qct-tile" aria-label={q.name}>
      <div className="qct-cover">
        <button
          type="button"
          className="qct-cover__btn"
          aria-label={`Открыть «${q.name}» в редакторе`}
          onClick={() => actions.onEdit(q.quest_id)}
        >
          <TileCover key={q.cover ?? ''} name={q.name} cover={q.cover} />
        </button>
        <div className="qct-cover__status">{status}</div>
        <div className="qct-cover__band">{band}</div>
      </div>

      <div className="qct-body">
        <div className="qct-headrow">{status}</div>
        <h3 className="qct-name">
          <button type="button" onClick={() => actions.onEdit(q.quest_id)}>{q.name}</button>
        </h3>
        <button
          type="button"
          className="qct-set"
          title="Быстрые настройки"
          aria-label={`Быстрые настройки: ${[q.city ?? 'город не задан', price, factsLine(q)].filter(Boolean).join(', ')}`}
          onClick={() => actions.onSettings(q)}
        >
          <span className="qct-set__r1">
            <span className="qct-set__city">
              <IconPin />
              {q.city ?? 'Город не задан'}
            </span>
            {price ? <span className={`qct-set__price${q.price === 0 ? ' is-free' : ''}`}>{price}</span> : null}
            <span className="qct-set__gear"><IconSliders /></span>
          </span>
          <span className="qct-set__r2">{factsLine(q)}</span>
          <span className="qct-set__r3">
            {chips.map((c) => (
              <span key={c} className="qct-chip">{c}</span>
            ))}
            {q.tags.map((t) => (
              <span key={`#${t}`} className="qct-chip qct-chip--tag">{t}</span>
            ))}
          </span>
        </button>
        <Indicators q={q} actions={actions} nowMs={nowMs} />
        {isAdmin && q.revenue != null ? (
          <div className="qct-money" title="Игроки с доступом (покупки и промокоды) · сумма оплат через сайт">
            {q.price ? (
              <>
                Купили <b>{formatNumber(q.buyers)}</b> · <b>{formatNumber(q.revenue)}&nbsp;₽</b>
              </>
            ) : (
              <>
                Получили <b>{formatNumber(q.buyers)}</b>
              </>
            )}
          </div>
        ) : null}
      </div>

      <div className="qct-bandrow">{band}</div>

      <div className="qct-act">
        <button type="button" className="qct-edit" onClick={() => actions.onEdit(q.quest_id)}>
          Редактировать
        </button>
        <button
          type="button"
          className="qct-ic"
          title="Тест-прогон черновика"
          aria-label="Тест-прогон черновика"
          onClick={() => actions.onRun(q)}
        >
          <IconPlay />
        </button>
        <button
          type="button"
          className="qct-ic"
          disabled={!linkOn}
          title={linkOn ? 'Скопировать ссылку на квест' : 'Ссылка появится, когда квест будет в магазине'}
          aria-label="Скопировать ссылку на квест"
          onClick={() => actions.onCopyLink(q)}
        >
          <IconLink />
        </button>
        <div className="qct-more" ref={moreRef}>
          <button
            type="button"
            className="qct-ic"
            title="Ещё"
            aria-label="Ещё действия"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
          >
            <IconMore />
          </button>
          {menu ? <MoreMenu q={q} actions={actions} onClose={() => setMenu(false)} /> : null}
        </div>
      </div>
    </article>
  );
}
