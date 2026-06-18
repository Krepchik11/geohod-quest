'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  computeGates,
  plural,
  type CtorQuest,
  type CtorQuestMeta,
} from '../../lib/constructor-model';
import { ImageZone } from './controls';

/** Шапка workspace: бренд, хлебные крошки, действия справа. */
export function WspHeader({ crumbs, children }: { crumbs: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="wsp-top">
      <Link href="/" aria-label="На главную"><span className="brand" style={{ display: 'block' }} /></Link>
      <span className="wsp-crumbs">{crumbs}</span>
      <span className="sp" />
      {children}
    </header>
  );
}

function QuestRow({ quest, onOpen }: { quest: CtorQuest; onOpen: () => void }) {
  const gates = computeGates(quest);
  const live = quest.versions.find((v) => v.live);
  const m = quest.meta;
  const metaLine = [m.city, m.duration, m.price > 0 ? `${m.price} ₽` : 'бесплатно'].filter(Boolean).join(' · ');
  const errN = gates.errors.length;
  return (
    <div className="wsp-qrow" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      {m.cover
        // eslint-disable-next-line @next/next/no-img-element
        ? <img className="cover" src={m.cover} alt="" />
        : <span className="cover-ph">нет обложки</span>}
      <span className="body">
        <span className="ttl">{m.title}</span>
        <div className="meta">{metaLine}</div>
      </span>
      <span className="chips">
        <span className="wsp-chip mut">черновик · {quest.steps.length} {plural(quest.steps.length, 'страница', 'страницы', 'страниц')}</span>
        {errN ? <span className="wsp-chip err">{errN} {plural(errN, 'ошибка', 'ошибки', 'ошибок')} гейтов</span> : null}
        {live
          ? <span className="wsp-chip live">v{live.n} в магазине</span>
          : <span className="wsp-chip draft">не опубликован</span>}
      </span>
      <button className="btn-ui btn-ui--outline btn-ui--sm" type="button">Открыть</button>
    </div>
  );
}

function CreateQuestModal({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (meta: Partial<CtorQuestMeta>) => void;
}) {
  const [m, setM] = useState({ title: '', city: '', duration: '', price: '', desc: '', cover: null as string | null });
  const set = (patch: Partial<typeof m>) => setM({ ...m, ...patch });
  return (
    <div className="wsp-ovl" onClick={onClose}>
      <div className="adm-modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        <h3>Новый квест</h3>
        <div>
          <label className="adm-label">Название<small>видно игроку на первом экране и в магазине</small></label>
          <input autoFocus className="field-ui" value={m.title} onChange={(e) => set({ title: e.target.value })} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <div>
            <label className="adm-label">Город</label>
            <input className="field-ui" placeholder="Нови Сад" value={m.city} onChange={(e) => set({ city: e.target.value })} />
          </div>
          <div>
            <label className="adm-label">Длительность</label>
            <input className="field-ui" placeholder="2–3 часа" value={m.duration} onChange={(e) => set({ duration: e.target.value })} />
          </div>
          <div>
            <label className="adm-label">Цена, ₽</label>
            <input className="field-ui" type="number" min={0} placeholder="0" value={m.price} onChange={(e) => set({ price: e.target.value })} />
          </div>
        </div>
        <div>
          <label className="adm-label">Описание для магазина</label>
          <textarea className="textarea-ui" placeholder="Пара абзацев: о чём квест, что увидит игрок" value={m.desc} onChange={(e) => set({ desc: e.target.value })} />
        </div>
        <div>
          <label className="adm-label">Обложка</label>
          <ImageZone src={m.cover} label="обложка" hint="PNG/JPG — будет ужата до 1280px" width={220} onChange={(cover) => set({ cover })} />
        </div>
        <p className="note">Квест создастся с двумя обязательными страницами — «Первый экран» и «Поздравление». Цена 0 ₽ — бесплатный квест; оплата, купоны и выдача доступов живут в магазине.</p>
        <div className="row">
          <button className="btn-ui btn-ui--outline" type="button" onClick={onClose}>Отмена</button>
          <button
            className="btn-ui"
            type="button"
            disabled={!m.title.trim()}
            onClick={() => onCreate({ ...m, cover: m.cover, price: +m.price || 0 })}
          >Создать квест</button>
        </div>
      </div>
    </div>
  );
}

export function QuestListScreen({ quests, onOpen, onCreate }: {
  quests: CtorQuest[];
  onOpen: (id: string) => void;
  onCreate: (meta: Partial<CtorQuestMeta>) => void;
}) {
  const [modal, setModal] = useState(false);
  return (
    <>
      <WspHeader crumbs={<b>Конструктор квестов</b>}>
        <button className="btn-ui" type="button" onClick={() => setModal(true)}>+ Новый квест</button>
      </WspHeader>
      <div className="wsp-list">
        <div className="wsp-listhead">
          <h2>Квесты</h2>
          <span className="cnt">{quests.length} {plural(quests.length, 'квест', 'квеста', 'квестов')}</span>
        </div>
        {quests.map((q) => (
          <QuestRow key={q.id} quest={q} onOpen={() => onOpen(q.id)} />
        ))}
        {!quests.length ? (
          <div className="wsp-empty">
            <span>Квестов пока нет. Создайте первый — он сразу получит «Первый экран» и «Поздравление».</span>
            <button className="btn-ui" type="button" onClick={() => setModal(true)}>+ Новый квест</button>
          </div>
        ) : null}
      </div>
      {modal ? (
        <CreateQuestModal
          onClose={() => setModal(false)}
          onCreate={(meta) => { setModal(false); onCreate(meta); }}
        />
      ) : null}
    </>
  );
}
