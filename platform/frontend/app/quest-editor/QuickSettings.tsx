'use client';

import React, { useEffect, useEffectEvent, useId, useState } from 'react';
import type { ConstructorQuestWire } from '../../lib/api';
import {
  AGE_TARGET_OPTIONS,
  BAD_START_COORDS_TEXT,
  COMPLEXITY_OPTIONS,
  QUEST_DISTANCE_KM_MAX,
  QUEST_DURATION_MIN_MAX,
  parseCoords,
  type CtorQuest,
  type CtorQuestMeta,
} from '../../lib/constructor-model';
import { coverSrc, monogram } from '../../lib/cover';
import { formatNumber } from '../../lib/ru';
import { Button, Input, Textarea } from '../components/ui';
import { useEscape } from './controls';

/** Поля, которые быстрые настройки меняют в черновике. */
export type QuickSettingsPatch = Pick<
  CtorQuestMeta,
  | 'city'
  | 'price'
  | 'durationMin'
  | 'distanceKm'
  | 'complexity'
  | 'ageTarget'
  | 'tags'
  | 'desc'
  | 'startCoords'
  | 'playersBonus'
>;

const PRICE_PRESETS = [0, 500, 1000];

/** «хоррор, юмор , хоррор» → ['хоррор', 'юмор']: trim, без пустых и дублей. */
function parseTags(raw: string): string[] {
  const out: string[] = [];
  for (const t of raw.split(',').map((s) => s.trim())) if (t && !out.includes(t)) out.push(t);
  return out;
}

/**
 * Быстрые настройки квеста с плитки (флаг ctor_tiles): поля «Настройки и обложка»,
 * которые меняют чаще всего, без захода в редактор. Лист сам грузит черновик
 * (описание, точка старта и бонус живут только в нём) и честно говорит, что из
 * изменённого доходит до магазина лишь с новой версией.
 */
export default function QuickSettings({
  row,
  load,
  onSave,
  onClose,
  cities,
  isAdmin,
}: {
  row: ConstructorQuestWire;
  load: () => Promise<CtorQuest>;
  onSave: (patch: QuickSettingsPatch) => Promise<void>;
  onClose: () => void;
  /** Города из списка администратора (флаг ctor_city_list); иначе город вводится. */
  cities?: readonly string[];
  isAdmin: boolean;
}) {
  const [quest, setQuest] = useState<CtorQuest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const titleId = useId();
  useEscape(onClose);

  // Черновик грузится один раз на открытие листа (другой квест — новый лист,
  // см. key у родителя), а не на каждый рендер родителя с новой функцией.
  const loadOnce = useEffectEvent(load);
  useEffect(() => {
    let cancelled = false;
    loadOnce().then(
      (q) => {
        if (!cancelled) setQuest(q);
      },
      () => {
        if (!cancelled) setLoadError('Не удалось открыть настройки квеста — попробуйте ещё раз.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const src = coverSrc(row.cover);
  return (
    <div className="qct-sheet-ovl" onClick={onClose}>
      <div
        className="qct-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="qct-sheet__head">
          <div className="qct-sheet__thumb">
            {src ? <img src={src} alt="" /> : <span>{monogram(row.name)}</span>}
          </div>
          <div className="qct-sheet__titles">
            <h3 id={titleId}>{row.name}</h3>
            <span>Быстрые настройки · остальное — в редакторе</span>
          </div>
        </div>
        {quest ? (
          <QuickSettingsForm
            row={row}
            meta={quest.meta}
            cities={cities}
            isAdmin={isAdmin}
            onSave={onSave}
            onClose={onClose}
          />
        ) : (
          <div className="qct-sheet__body">
            {loadError ? (
              <p className="qct-sheet__error" role="alert">{loadError}</p>
            ) : (
              <p className="qct-sheet__loading">Загружаем настройки…</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function QuickSettingsForm({
  row,
  meta,
  cities,
  isAdmin,
  onSave,
  onClose,
}: {
  row: ConstructorQuestWire;
  meta: CtorQuestMeta;
  cities?: readonly string[];
  isAdmin: boolean;
  onSave: (patch: QuickSettingsPatch) => Promise<void>;
  onClose: () => void;
}) {
  const id = useId();
  const [city, setCity] = useState(meta.city);
  const [price, setPrice] = useState(String(meta.price));
  const [minutes, setMinutes] = useState(String(meta.durationMin));
  const [km, setKm] = useState(String(meta.distanceKm).replace('.', ','));
  const [complexity, setComplexity] = useState(meta.complexity);
  const [ageTarget, setAgeTarget] = useState(meta.ageTarget);
  const [tags, setTags] = useState(meta.tags.join(', '));
  const [desc, setDesc] = useState(meta.desc);
  const [start, setStart] = useState(meta.startCoords);
  const [bonus, setBonus] = useState(String(meta.playersBonus));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const priceN = Number(price);
  const minutesN = Number(minutes);
  const kmN = Number(km.replace(',', '.'));
  const bonusN = Number(bonus);
  const errors = {
    price: !(Number.isInteger(priceN) && priceN >= 0) ? 'Целое число рублей, 0 — бесплатно' : null,
    minutes:
      !(Number.isInteger(minutesN) && minutesN >= 1 && minutesN <= QUEST_DURATION_MIN_MAX)
        ? `Целое число минут, от 1 до ${QUEST_DURATION_MIN_MAX}`
        : null,
    km: !(kmN > 0 && kmN <= QUEST_DISTANCE_KM_MAX) ? `Число километров до ${QUEST_DISTANCE_KM_MAX}` : null,
    start: start.trim() && !parseCoords(start) ? BAD_START_COORDS_TEXT : null,
    bonus: !(Number.isInteger(bonusN) && bonusN >= 0) ? 'Целое число, 0 — без бонуса' : null,
  };
  const invalid = Object.values(errors).some(Boolean);

  // Город из списка администратора: значение черновика, которого в списке нет,
  // остаётся выбранным — иначе первое же сохранение молча сменило бы город.
  const cityOptions = cities ? (city && !cities.includes(city) ? [city, ...cities] : cities) : null;

  const save = async () => {
    if (invalid || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({
        city: city.trim(),
        price: priceN,
        durationMin: minutesN,
        distanceKm: Math.round(kmN * 10) / 10,
        complexity,
        ageTarget,
        tags: parseTags(tags),
        desc,
        startCoords: start.trim(),
        playersBonus: isAdmin ? bonusN : meta.playersBonus,
      });
      onClose();
    } catch (e) {
      setSaveError((e as Error).message || 'Не удалось сохранить — попробуйте ещё раз.');
      setSaving(false);
    }
  };

  const live = row.published_version;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="qct-sheet__body">
        <div className="qct-fld">
          <label htmlFor={`${id}-city`}>Город</label>
          {cityOptions ? (
            <select id={`${id}-city`} className="input" value={city} onChange={(e) => setCity(e.target.value)} autoFocus>
              <option value="">Не выбран</option>
              {cityOptions.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          ) : (
            <Input id={`${id}-city`} value={city} onChange={(e) => setCity(e.target.value)} autoFocus />
          )}
        </div>
        <div className="qct-fld">
          <label htmlFor={`${id}-price`}>Цена, ₽</label>
          <Input
            id={`${id}-price`}
            type="number"
            inputMode="numeric"
            min={0}
            step={50}
            value={price}
            error={!!errors.price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <div className="qct-quick">
            {PRICE_PRESETS.map((p) => (
              <button key={p} type="button" aria-pressed={priceN === p} onClick={() => setPrice(String(p))}>
                {p === 0 ? 'Бесплатно' : formatNumber(p)}
              </button>
            ))}
          </div>
          {errors.price ? <span className="qct-fld__err">{errors.price}</span> : null}
        </div>
        <div className="qct-fld">
          <label htmlFor={`${id}-min`}>Длительность, мин</label>
          <Input
            id={`${id}-min`}
            type="number"
            inputMode="numeric"
            min={1}
            value={minutes}
            error={!!errors.minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
          {errors.minutes ? <span className="qct-fld__err">{errors.minutes}</span> : null}
        </div>
        <div className="qct-fld">
          <label htmlFor={`${id}-km`}>Маршрут, км</label>
          <Input
            id={`${id}-km`}
            inputMode="decimal"
            value={km}
            error={!!errors.km}
            onChange={(e) => setKm(e.target.value)}
          />
          {errors.km ? <span className="qct-fld__err">{errors.km}</span> : null}
        </div>
        <div className="qct-fld qct-fld--full">
          <span className="qct-fld__label" id={`${id}-cx`}>Сложность</span>
          <div className="qct-seg" role="group" aria-labelledby={`${id}-cx`}>
            {COMPLEXITY_OPTIONS.map((o) => (
              <button key={o.key} type="button" aria-pressed={complexity === o.key} onClick={() => setComplexity(o.key)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="qct-fld qct-fld--full">
          <span className="qct-fld__label" id={`${id}-age`}>Возраст</span>
          <div className="qct-seg" role="group" aria-labelledby={`${id}-age`}>
            {AGE_TARGET_OPTIONS.map((o) => (
              <button key={o.key} type="button" aria-pressed={ageTarget === o.key} onClick={() => setAgeTarget(o.key)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="qct-fld qct-fld--full">
          <label htmlFor={`${id}-tags`}>Теги</label>
          <Input id={`${id}-tags`} value={tags} placeholder="через запятую" onChange={(e) => setTags(e.target.value)} />
        </div>
        <div className="qct-fld qct-fld--full">
          <label htmlFor={`${id}-desc`}>Описание для магазина</label>
          <Textarea id={`${id}-desc`} rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} />
        </div>
        <div className="qct-fld qct-fld--full">
          <label htmlFor={`${id}-start`}>Точка старта</label>
          <Input
            id={`${id}-start`}
            value={start}
            placeholder="45.2651, 19.8656 — координаты из Google Maps"
            error={!!errors.start}
            onChange={(e) => setStart(e.target.value)}
          />
          <span className={errors.start ? 'qct-fld__err' : 'qct-fld__hint'}>
            {errors.start ?? 'Пусто — на странице квеста не будет кнопки «Место старта»'}
          </span>
        </div>
        {isAdmin ? (
          <div className="qct-fld qct-fld--full">
            <label htmlFor={`${id}-bonus`}>
              Бонус к счётчику игроков <span className="qct-fld__admin">админ</span>
            </label>
            <Input
              id={`${id}-bonus`}
              type="number"
              inputMode="numeric"
              min={0}
              value={bonus}
              error={!!errors.bonus}
              onChange={(e) => setBonus(e.target.value)}
            />
            <span className={errors.bonus ? 'qct-fld__err' : 'qct-fld__hint'}>
              {errors.bonus ?? 'Прибавляется к числу игроков на карточке в магазине'}
            </span>
          </div>
        ) : null}
      </div>
      <p className="qct-sheet__note">
        {live != null
          ? `Сейчас опубликована версия ${live}. Город, цена, время, маршрут, описание, точка старта и бонус дойдут до игроков после публикации версии ${live + 1} — кнопка появится на плитке. Сложность, возраст и теги меняются в магазине сразу.`
          : 'Квест ещё не опубликован — настройки попадут в магазин вместе с первой версией.'}
      </p>
      {saveError ? <p className="qct-sheet__error" role="alert">{saveError}</p> : null}
      <div className="qct-sheet__foot">
        <Button variant="secondary" size="sm" onClick={onClose}>Отмена</Button>
        <Button size="sm" type="submit" disabled={invalid || saving}>
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </Button>
      </div>
    </form>
  );
}
