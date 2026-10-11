'use client';

import React from 'react';
import Link from 'next/link';
import { useClientFeature } from '../../lib/client-features';
import { CLUB_CHANNEL, CLUB_CHANNEL_URL } from '../../lib/contacts';

/**
 * The storefront blocks under the shop grid (ТЗ «Дизайн и юзабилити», этап 2):
 * «Вместе веселее» and «Скоро в новых городах» (`store_cities`). Everything
 * they show is real: the cities come from the `soon_cities` setting — a block
 * with nothing real to show renders nothing.
 */

/** «Вместе веселее»: one quest serves the whole company (the /rules FAQ says
 *  so); the group walks and games are on the «Афиша» (`afisha`) and announced
 *  in the club's channel. */
export function TogetherBlock() {
  const afishaOn = useClientFeature('afisha');
  return (
    <section className="store-block store-block--white" aria-labelledby="together-title">
      <div className="store-block__row">
        <span className="store-block__icon" aria-hidden><span className="ic ic-people" /></span>
        <div>
          <h3 className="store-block__title" id="together-title">Вместе веселее</h3>
          <p className="store-block__text">
            Один квест — на всю компанию: идите с одним телефоном и решайте задания вместе.{' '}
            {afishaOn
              ? `Групповые прогулки и квесты с организатором — в афише, анонсы выходят в канале ${CLUB_CHANNEL}.`
              : `Групповые прогулки с организатором анонсируем в канале ${CLUB_CHANNEL}.`}
          </p>
        </div>
      </div>
      <div className="store-block__actions">
        {afishaOn && (
          <Link className="btn btn--md store-block__cta" href="/afisha">
            Афиша
          </Link>
        )}
        <a className="btn btn--secondary btn--md store-block__cta" href={CLUB_CHANNEL_URL} target="_blank" rel="noopener">
          <span className="ic ic-tg-blue" aria-hidden />
          Все игры в канале
        </a>
      </div>
    </section>
  );
}

/** «Скоро в новых городах» (`store_cities` + the `soon_cities` setting). */
export function SoonBlock({ cities }: { cities: string[] }) {
  return (
    <section className="store-block store-block--navy" id="soon" aria-labelledby="soon-title">
      <h3 className="store-block__title" id="soon-title">Скоро в новых городах</h3>
      <p className="store-block__text">Напишем в Telegram, как только откроем квесты в вашем городе.</p>
      <ul className="store-block__cities">
        {cities.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <a className="btn btn--white btn--md store-block__cta" href={CLUB_CHANNEL_URL} target="_blank" rel="noopener">
        <span className="ic ic-tg-blue" aria-hidden />
        Узнать о запуске
      </a>
    </section>
  );
}
