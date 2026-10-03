'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { questPlural, questsInCity, questsInCityParts, type CityCount } from '../../lib/storefront';

/**
 * The shop's title, «Квесты в Нови Саде». With `store_cities` and more than one
 * city in the catalog the city itself is the switch: a blue word that drops the
 * catalog's cities, the busiest first, each with its count. A pick works as a
 * city chip does; Escape or a click elsewhere closes the list untouched.
 *
 * The list is the title's sibling, not its child: on a phone the title clips
 * its overflow (one line with an ellipsis), the head positions the list.
 */
export default function CityTitle({
  city,
  cities,
  onPick,
}: {
  city: string | null;
  /** The catalog's cities in list order (lib/storefront `citiesByCount`);
   *  null when the city is not the player's to pick. */
  cities: CityCount[] | null;
  onPick: (city: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const { lead, place } = questsInCityParts(city);
  const switchable = place !== null && cities !== null && cities.length > 1;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const options = listRef.current?.querySelectorAll<HTMLButtonElement>('.city-opt');
    (listRef.current?.querySelector<HTMLButtonElement>('.city-opt.is-on') ?? options?.[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || listRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open, close]);

  if (!switchable) return <h2 className="store__title">{questsInCity(city)}</h2>;

  /** ↑/↓ walk the list round. */
  const walk = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const options = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.city-opt') ?? []);
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    options[(at + step + options.length) % options.length]?.focus();
  };

  return (
    <>
      <h2 className="store__title">
        {lead}
        <button
          ref={buttonRef}
          type="button"
          className={`store__city${open ? ' is-open' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => (open ? close(false) : setOpen(true))}
        >
          {place}
          <span className="ic store__city-caret" aria-hidden />
        </button>
      </h2>
      {open && (
        <div className="city-pop" role="dialog" aria-label="Выбор города" ref={listRef} onKeyDown={walk}>
          {cities.map(({ city: name, count }) => (
            <button
              key={name}
              type="button"
              className={`city-opt${name === city ? ' is-on' : ''}`}
              aria-pressed={name === city}
              onClick={() => {
                close(true);
                if (name !== city) onPick(name);
              }}
            >
              {/* The space keeps «Нови Сад 3 квеста» apart for a screen reader;
                  between flex items it takes no room. */}
              <span>{name}</span>{' '}
              <span className="city-opt__count">
                {count}&nbsp;{questPlural(count)}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
