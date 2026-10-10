import React from 'react';
import Link from 'next/link';
import { fmtRating, ratingPlural, type CityCount, type HeroStat } from '../../lib/storefront';

/**
 * The main banner by city (owner 2026-10-10, «вариант 2»):
 * one title for every city, the city buttons right under it — the busiest
 * first, each with its count — then the picked city's photo with its slogan
 * at the top and its numbers at the bottom, and «Выбрать квест».
 *
 * The photo and slogan are the admin's («Города»); a city without a photo gets
 * a plain navy plate, so another city's landmarks never stand in for it.
 */
export default function CityHero({
  city,
  cities,
  soon,
  onPick,
  image,
  slogan,
  stats,
  proof,
  continueTo,
}: {
  city: string | null;
  /** The buttons; none while the catalog has a single city and nothing «скоро». */
  cities: readonly CityCount[];
  soon: readonly string[];
  onPick: (city: string) => void;
  image: string | null;
  slogan: string;
  stats: readonly HeroStat[];
  /** The city's average rating; null while none of its quests is rated. */
  proof: { avg: number; ratings: number } | null;
  /** The quest in progress, offered under the button. */
  continueTo: { href: string; name: string | null; offline: boolean } | null;
}) {
  const chips = cities.length > 1 || soon.length > 0;
  return (
    <section className="hero3" data-screen-label="Главная — хиро">
      <div className="container hero3__inner">
        <h1 className="hero3__title">Городские квесты в&nbsp;смартфоне</h1>
        {chips && (
          <div className="city-chips hero3__chips" role="group" aria-label="Город">
            {cities.map((c) => (
              <button
                key={c.city}
                type="button"
                className={`city-chip${c.city === city ? ' is-on' : ''}`}
                aria-pressed={c.city === city}
                onClick={() => onPick(c.city)}
              >
                {c.city} <small>{c.count}</small>
              </button>
            ))}
            {soon.map((s) => (
              <a key={s} className="city-chip city-chip--soon" href="#soon">
                {s} <small>скоро</small>
              </a>
            ))}
          </div>
        )}
        <div className={`hero3__photo${image ? '' : ' is-empty'}`}>
          {image && (
            // eslint-disable-next-line @next/next/no-img-element -- the admin's picture, served by the API's media host
            <img src={image} alt={city ?? ''} fetchPriority="high" />
          )}
          <p className="hero3__slogan">{slogan}</p>
          {stats.length > 0 && (
            <ul className="hero3__stats">
              {stats.map((s) => (
                <li key={s.label}>
                  <b>{s.value}</b>{' '}
                  <span>{s.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="hero3__cta">
          <a className="btn" href="#shop">Выбрать квест</a>
          {continueTo && <ContinueLink {...continueTo} />}
        </div>
        <p className="hero3__under">
          {proof && (
            <span className="hero3__proof">
              <span className="ic ic-star" aria-hidden /> <b>{fmtRating(proof.avg)}</b> · {proof.ratings}&nbsp;{ratingPlural(proof.ratings)}
            </span>
          )}
          <Link className="hero3__how" href="/rules">Как играть →</Link>
        </p>
      </div>
    </section>
  );
}

/** Back into the quest in progress. Offline it is a real navigation, so the
 *  service worker serves the cached player page. */
function ContinueLink({ href, name, offline }: { href: string; name: string | null; offline: boolean }) {
  const label = name ? `Продолжить «${name}» →` : 'Продолжить квест →';
  return offline ? (
    <a className="hero3__continue" href={href}>{label}</a>
  ) : (
    <Link className="hero3__continue" href={href}>{label}</Link>
  );
}
