'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, apiErrorMessage, classify, type AdminCityWire } from '../../../lib/api';
import {
  CITY_NAME_MAX,
  CITY_SLOGAN_MAX,
  cityUsageLabel,
  deleteBlockedText,
  mergeSuggestions,
} from '../../../lib/admin-cities';
import { fileToOriginImage } from '../../../lib/image-file';
import { pluralCount } from '../../../lib/ru';
import { AdminConfirmSheet, AdminPageHead, AdminToast, useToast } from '../ui';

/**
 * Admin · Города: every city quests use plus the ones the admin added ahead
 * of their first quest (the backend assembles the list — cities.rs), each with
 * its quest counter, the picture for the main banner and the slogan.
 *
 * Renaming a city renames it in every quest — drafts and store cards — so a
 * misspelt duplicate is fixed by renaming it into the real one: that is a
 * merge, confirmed in a sheet. A city is deleted only once no quest uses it.
 * Every mutation answers with the fresh list, which the page adopts as is.
 */

/** The picture in the form: the stored URL, a picked file not uploaded yet
 *  (it goes to the media store on save, so a cancelled edit leaves no orphan),
 *  or none. */
type ImageDraft = { kind: 'url'; url: string } | { kind: 'file'; blob: Blob; preview: string } | null;

interface CityDraft {
  name: string;
  slogan: string;
  image: ImageDraft;
}

type Editing = { mode: 'new' } | { mode: 'edit'; name: string } | null;

type Confirm =
  | { kind: 'merge'; from: string; into: string; image: string | null; slogan: string | null }
  | { kind: 'delete'; name: string }
  | null;

/** The name the server will store (cities.rs normalize_name), for the sheet's text. */
const normalizedName = (raw: string) => raw.split(/\s+/).filter(Boolean).join(' ');

/** A picked file goes to the media store; the form keeps its URL from then on. */
async function storedImage(image: ImageDraft): Promise<string | null> {
  if (!image) return null;
  if (image.kind === 'url') return image.url;
  return (await api.uploadMedia(image.blob)).url;
}

export default function AdminCitiesPage() {
  const [cities, setCities] = useState<AdminCityWire[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const { toast, showToast } = useToast();
  const [toastError, setToastError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .adminListCities()
      .then((list) => {
        if (!cancelled) setCities(list);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const suggestions = useMemo(() => mergeSuggestions(cities ?? []), [cities]);

  const notify = (text: string, error = false) => {
    setToastError(error);
    showToast(text);
  };

  /** Run one mutation: adopt the list it returns, or toast the server's reason. */
  const mutate = async (work: () => Promise<AdminCityWire[]>, done: string): Promise<boolean> => {
    setBusy(true);
    try {
      setCities(await work());
      notify(done);
      return true;
    } catch (err) {
      notify(apiErrorMessage(err, 'Не удалось сохранить изменения'), true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async (draft: CityDraft) => {
    setBusy(true);
    let image: string | null;
    try {
      image = await storedImage(draft.image);
    } catch {
      setBusy(false);
      notify('Не удалось загрузить картинку', true);
      return;
    }
    const ok = await mutate(
      () => api.adminCreateCity({ name: draft.name, image, slogan: draft.slogan }),
      `Город «${normalizedName(draft.name)}» добавлен`,
    );
    if (ok) setEditing(null);
  };

  const save = async (from: AdminCityWire, draft: CityDraft) => {
    setBusy(true);
    let image: string | null;
    try {
      image = await storedImage(draft.image);
    } catch {
      setBusy(false);
      notify('Не удалось загрузить картинку', true);
      return;
    }
    const body = { name: from.name, new_name: draft.name, image, slogan: draft.slogan, merge: false };
    try {
      setCities(await api.adminSaveCity(body));
      setEditing(null);
      notify('Сохранено');
    } catch (err) {
      const failure = classify(err);
      if (failure.kind === 'rejected' && failure.status === 409) {
        // The new name is a city already listed: renaming is a merge.
        setConfirm({ kind: 'merge', from: from.name, into: normalizedName(draft.name), image, slogan: draft.slogan });
      } else {
        notify(apiErrorMessage(err, 'Не удалось сохранить изменения'), true);
      }
    } finally {
      setBusy(false);
    }
  };

  const applyConfirm = async () => {
    if (!confirm) return;
    const ok =
      confirm.kind === 'merge'
        ? await mutate(
            () =>
              api.adminSaveCity({
                name: confirm.from,
                new_name: confirm.into,
                image: confirm.image,
                slogan: confirm.slogan,
                merge: true,
              }),
            `«${confirm.from}» объединён с «${confirm.into}»`,
          )
        : await mutate(() => api.adminDeleteCity({ name: confirm.name }), `Город «${confirm.name}» удалён`);
    setConfirm(null);
    if (ok) setEditing(null);
  };

  const askMerge = (city: AdminCityWire, into: string) =>
    setConfirm({ kind: 'merge', from: city.name, into, image: city.image, slogan: city.slogan });

  return (
    <>
      <main className="ap-main ap-main--narrow">
        <AdminPageHead
          eyebrow="УПРАВЛЕНИЕ"
          title="Города"
          lede="Город попадает сюда сам, как только его указали в квесте; новый можно добавить заранее. Картинка — для главного баннера, слоган — подпись к ней. Переименование меняет город во всех его квестах: в конструкторе и в магазине."
        >
          <button
            type="button"
            className="btn btn--sm acity-add"
            disabled={!cities || editing?.mode === 'new'}
            onClick={() => setEditing({ mode: 'new' })}
          >
            Добавить город
          </button>
        </AdminPageHead>

        {editing?.mode === 'new' && (
          <div className="acity-list">
            <CityForm
              title="Новый город"
              initial={{ name: '', slogan: '', image: null }}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSave={(draft) => void create(draft)}
            />
          </div>
        )}

        {loadError ? (
          <div className="acity-list">
            <div className="acity-empty">Не удалось загрузить города. Проверьте соединение и обновите страницу.</div>
          </div>
        ) : !cities ? (
          <div className="acity-list">
            <div className="acity-empty">Загружаем…</div>
          </div>
        ) : cities.length === 0 ? (
          <div className="acity-list">
            <div className="acity-empty">Городов пока нет: ни в одном квесте город не указан.</div>
          </div>
        ) : (
          <div className="acity-list">
            {cities.map((city) =>
              editing?.mode === 'edit' && editing.name === city.name ? (
                <CityForm
                  key={city.name}
                  title={city.name}
                  city={city}
                  initial={{
                    name: city.name,
                    slogan: city.slogan ?? '',
                    image: city.image ? { kind: 'url', url: city.image } : null,
                  }}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSave={(draft) => void save(city, draft)}
                  onDelete={() => setConfirm({ kind: 'delete', name: city.name })}
                />
              ) : (
                <CityRow
                  key={city.name}
                  city={city}
                  mergeInto={suggestions.get(city.name)}
                  disabled={busy || editing !== null}
                  onEdit={() => setEditing({ mode: 'edit', name: city.name })}
                  onMerge={(into) => askMerge(city, into)}
                />
              ),
            )}
          </div>
        )}
      </main>

      {confirm?.kind === 'merge' && (
        <AdminConfirmSheet
          label="Объединить города"
          title="Объединить города?"
          text={
            <>
              «{confirm.into}» уже есть в списке. Квесты города «{confirm.from}» перейдут в «{confirm.into}» — в
              конструкторе и в магазине, а «{confirm.from}» исчезнет из списка. Картинка и слоган «{confirm.into}»
              сохранятся.
            </>
          }
          applyLabel="Объединить"
          busyLabel="Объединяем…"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onApply={() => void applyConfirm()}
        />
      )}
      {confirm?.kind === 'delete' && (
        <AdminConfirmSheet
          label="Удалить город"
          title={`Удалить город «${confirm.name}»?`}
          text="Город пропадёт из списка и из выбора в конструкторе вместе с картинкой и слоганом."
          applyLabel="Удалить"
          busyLabel="Удаляем…"
          busy={busy}
          danger
          onCancel={() => setConfirm(null)}
          onApply={() => void applyConfirm()}
        />
      )}
      {toast && <AdminToast text={toast} error={toastError} />}
    </>
  );
}

/** The picture slot: the stored or picked picture, or a grey placeholder. */
function CityThumb({ src, large = false }: { src: string | null; large?: boolean }) {
  return (
    <div className={`acity-thumb${large ? ' acity-thumb--large' : ''}`}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" />
      ) : (
        <span>нет картинки</span>
      )}
    </div>
  );
}

/** One city in the list: picture, name, counters, slogan; a look-alike gets a merge hint. */
function CityRow({
  city,
  mergeInto,
  disabled,
  onEdit,
  onMerge,
}: {
  city: AdminCityWire;
  mergeInto: string | undefined;
  disabled: boolean;
  onEdit: () => void;
  onMerge: (into: string) => void;
}) {
  return (
    <div className="acity-row">
      <CityThumb src={city.image} />
      <div className="acity-row__info">
        <div className="acity-row__name">{city.name}</div>
        <div className="acity-row__meta">{cityUsageLabel(city)}</div>
        <div className={`acity-row__slogan${city.slogan ? '' : ' is-empty'}`}>{city.slogan ?? 'Без слогана'}</div>
        {mergeInto && (
          <div className="acity-row__note">
            Похоже на «{mergeInto}».{' '}
            <button type="button" className="link" disabled={disabled} onClick={() => onMerge(mergeInto)}>
              Объединить
            </button>
          </div>
        )}
      </div>
      <button type="button" className="btn btn--quiet btn--sm" disabled={disabled} onClick={onEdit}>
        Изменить
      </button>
    </div>
  );
}

/** Add / edit form. `city` is absent for a new one (no delete, no counters). */
function CityForm({
  title,
  city,
  initial,
  busy,
  onCancel,
  onSave,
  onDelete,
}: {
  title: string;
  city?: AdminCityWire;
  initial: CityDraft;
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: CityDraft) => void;
  onDelete?: () => void;
}) {
  const [draft, setDraft] = useState<CityDraft>(initial);
  const [imageError, setImageError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const preview = draft.image ? (draft.image.kind === 'url' ? draft.image.url : draft.image.preview) : null;

  // A picked file's preview is an object URL — released when replaced or unmounted.
  useEffect(() => {
    const image = draft.image;
    return () => {
      if (image?.kind === 'file') URL.revokeObjectURL(image.preview);
    };
  }, [draft.image]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setImageError(null);
    setReading(true);
    try {
      const { blob } = await fileToOriginImage(file);
      setDraft((d) => ({ ...d, image: { kind: 'file', blob, preview: URL.createObjectURL(blob) } }));
    } catch (e) {
      setImageError((e as Error).message);
    } finally {
      setReading(false);
    }
  };

  const renamed = city !== undefined && normalizedName(draft.name) !== city.name;
  const canSave = !busy && !reading && normalizedName(draft.name) !== '';

  return (
    <form
      className="acity-form"
      aria-label={city ? `Город ${city.name}` : 'Новый город'}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) onSave(draft);
      }}
    >
      <div className="acity-form__title">{title}</div>
      <div className="acity-form__body">
        <div className="acity-form__media">
          <CityThumb src={preview} large />
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            aria-label="Файл картинки города"
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <div className="acity-form__media-actions">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={busy || reading}
              onClick={() => fileRef.current?.click()}
            >
              {reading ? 'Читаем файл…' : preview ? 'Заменить картинку' : 'Загрузить картинку'}
            </button>
            {preview && (
              <button
                type="button"
                className="link"
                disabled={busy || reading}
                onClick={() => setDraft((d) => ({ ...d, image: null }))}
              >
                Убрать
              </button>
            )}
          </div>
          <p className="acity-form__hint">
            Для главного баннера. JPG или PNG, лучше горизонтальный снимок; большие уменьшаются до 1280 px.
          </p>
          {imageError && <p className="acity-form__error">{imageError}</p>}
        </div>

        <div className="acity-form__fields">
          <div>
            <label className="adm-label" htmlFor={`${id}-name`}>
              Название
            </label>
            <input
              id={`${id}-name`}
              className="input"
              maxLength={CITY_NAME_MAX}
              value={draft.name}
              autoFocus={!city}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
            {renamed && city.quests > 0 && (
              <p className="acity-form__hint">
                Город поменяется в {pluralCount(city.quests, 'квесте', 'квестах', 'квестах')} — в конструкторе и в
                магазине. Если такой город уже есть, они объединятся.
              </p>
            )}
          </div>
          <div>
            <label className="adm-label" htmlFor={`${id}-slogan`}>
              Слоган
            </label>
            <input
              id={`${id}-slogan`}
              className="input"
              maxLength={CITY_SLOGAN_MAX}
              placeholder="Короткая фраза о городе"
              value={draft.slogan}
              onChange={(e) => setDraft((d) => ({ ...d, slogan: e.target.value }))}
            />
            <div className="acity-form__count">
              {draft.slogan.length}/{CITY_SLOGAN_MAX}
            </div>
          </div>
        </div>
      </div>

      <div className="acity-form__actions">
        {city && onDelete && (
          <div className="acity-form__delete">
            <button
              type="button"
              className="link acity-form__delete-btn"
              disabled={busy || city.quests > 0}
              onClick={onDelete}
            >
              Удалить город
            </button>
            {city.quests > 0 && <span className="acity-form__hint">{deleteBlockedText(city)}</span>}
          </div>
        )}
        <div className="acity-form__buttons">
          <button type="button" className="btn btn--quiet btn--sm" disabled={busy} onClick={onCancel}>
            Отмена
          </button>
          <button type="submit" className="btn btn--sm" disabled={!canSave}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </form>
  );
}
