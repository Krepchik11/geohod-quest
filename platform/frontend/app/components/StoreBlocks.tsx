'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type ReviewWire } from '../../lib/api';
import { CLUB_CHANNEL, CLUB_CHANNEL_URL } from '../../lib/contacts';
import { SUBSTANTIVE_REVIEW_CHARS } from '../../lib/storefront';

/**
 * The storefront blocks around the shop grid (ТЗ «Дизайн и юзабилити», этап 2):
 * the city chips (`store_cities`), «Вместе веселее», «Скоро в новых городах»
 * (`store_cities`) and one player's quote. Everything they show is real: the
 * cities come from the catalog and the `soon_cities` setting, the quote from the
 * quest's own reviews — a block with nothing real to show renders nothing.
 */

/** One row of city chips: the catalog's cities (one is picked) and the ones
 *  announced as «скоро», which lead to the block that tells about them. */
export function CityChips({
  cities,
  soon,
  active,
  onPick,
}: {
  cities: string[];
  soon: string[];
  active: string | null;
  onPick: (city: string) => void;
}) {
  return (
    <div className="city-chips" role="group" aria-label="Город">
      {cities.map((city) => (
        <button
          key={city}
          type="button"
          className={`city-chip${city === active ? ' is-on' : ''}`}
          aria-pressed={city === active}
          onClick={() => onPick(city)}
        >
          {city}
        </button>
      ))}
      {soon.map((city) => (
        <a key={city} className="city-chip city-chip--soon" href="#soon">
          {city} <small>скоро</small>
        </a>
      ))}
    </div>
  );
}

/** «Вместе веселее»: one quest serves the whole company (the /rules FAQ says
 *  so); the group walks themselves are announced in the club's channel. */
export function TogetherBlock() {
  return (
    <section className="store-block store-block--white" aria-labelledby="together-title">
      <div className="store-block__row">
        <span className="store-block__icon" aria-hidden><span className="ic ic-people" /></span>
        <div>
          <h3 className="store-block__title" id="together-title">Вместе веселее</h3>
          <p className="store-block__text">
            Один квест — на всю компанию: идите с одним телефоном и решайте задания вместе. Групповые
            прогулки с организатором анонсируем в канале {CLUB_CHANNEL}.
          </p>
        </div>
      </div>
      <a className="btn btn--secondary btn--md store-block__cta" href={CLUB_CHANNEL_URL} target="_blank" rel="noopener">
        <span className="ic ic-tg-blue" aria-hidden />
        Все игры в канале
      </a>
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

/** The product payloads already asked for this page load, by quest id. */
const quoteCache = new Map<string, Promise<ReviewWire | null>>();

/** The quest's first review, when it is a substantive one: the backend serves
 *  substantive reviews first, so a short first review means there is none. */
function firstSubstantive(questId: string): Promise<ReviewWire | null> {
  let pending = quoteCache.get(questId);
  if (!pending) {
    // Inside the chain, so even a client that throws on the call stays a «no quote».
    pending = Promise.resolve()
      .then(() => api.getQuestProduct(questId))
      .then((p) => p.reviews.find((r) => r.text.trim().length >= SUBSTANTIVE_REVIEW_CHARS) ?? null)
      .catch(() => null);
    quoteCache.set(questId, pending);
  }
  return pending;
}

/** One player's words about a quest of this city, under the shop. */
export function PlayerQuote({ questId, questName }: { questId: string; questName: string }) {
  const [quote, setQuote] = useState<{ questId: string; review: ReviewWire | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void firstSubstantive(questId).then((review) => {
      if (!cancelled) setQuote({ questId, review });
    });
    return () => { cancelled = true; };
  }, [questId]);

  const review = quote?.questId === questId ? quote.review : null;
  if (!review) return null;
  return (
    <figure className="store-quote">
      <blockquote>«{review.text.trim()}»</blockquote>
      <figcaption>
        {review.author}, квест{' '}
        <Link href={`/quest/${encodeURIComponent(questId)}/about`}>«{questName}»</Link>
      </figcaption>
    </figure>
  );
}
