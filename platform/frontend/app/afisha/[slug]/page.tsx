import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import SiteShell from '../../components/SiteShell';
import JsonLd from '../../components/JsonLd';
import { AfishaGrid, ChannelNote, QuestsNote } from '../parts';
import {
  ARCHIVE_LIMIT,
  KIND_LABEL,
  cityPath,
  dayLabel,
  eventFacts,
  eventJsonLd,
  eventPath,
  eventSummary,
  fetchAfisha,
  fetchAfishaEvent,
  listJsonLd,
  longWhen,
  postIdOfSlug,
  registerHref,
  type AfishaEventWire,
} from '../../../lib/afisha';

export const revalidate = 300;

type Params = { params: Promise<{ slug: string }> };

/** Past announcements a city page shows; the rest are in the archive. */
const CITY_PAST = 24;

/**
 * /afisha/<slug> — one announcement (the slug ends with its post number:
 * `2026-10-11-vrdnichka-kula-1110`) or one city (`novi-sad`). Both are what a
 * search engine or an AI assistant cites: the event for its date, the city
 * page for «прогулки в Нови-Саде» long after any single walk is over.
 */

interface CityPage {
  name: string;
  slug: string;
  upcoming: AfishaEventWire[];
  past: AfishaEventWire[];
}

/** The city's announcements; `null` for a city the «Афиша» never had. */
async function loadCity(slug: string): Promise<CityPage | null> {
  const [upcoming, past] = await Promise.all([fetchAfisha('upcoming'), fetchAfisha('past', ARCHIVE_LIMIT)]);
  if (!upcoming || !past) return null;
  const mine = (list: AfishaEventWire[]) => list.filter((e) => e.city_slug === slug);
  const [cityUpcoming, cityPast] = [mine(upcoming), mine(past)];
  const name = (cityUpcoming[0] ?? cityPast[0])?.city;
  return name ? { name, slug, upcoming: cityUpcoming, past: cityPast } : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const postId = postIdOfSlug(slug);
  if (postId !== null) {
    const event = await fetchAfishaEvent(postId);
    if (!event) return { title: 'Афиша — GEOHOD' };
    const title = `${event.title} — ${dayLabel(event.date)}, ${event.city}`;
    const description = eventSummary(event);
    return {
      title: `${title} | Афиша GEOHOD`,
      description,
      alternates: { canonical: eventPath(event) },
      openGraph: {
        type: 'website',
        siteName: 'GEOHOD QUEST',
        locale: 'ru_RU',
        title,
        description,
        url: eventPath(event),
        images: event.image ? [{ url: event.image, alt: event.title }] : undefined,
      },
    };
  }
  const city = await loadCity(slug);
  if (!city) return { title: 'Афиша — GEOHOD' };
  return {
    title: `Групповые прогулки и квесты: ${city.name} — Афиша GEOHOD`,
    description:
      `Ближайшие групповые прогулки, походы и квесты с организатором — ${city.name}. ` +
      'Место встречи, время и запись в один клик через Telegram.',
    alternates: { canonical: cityPath(city.slug) },
  };
}

export default async function AfishaSlugPage({ params }: Params) {
  const { slug } = await params;
  const postId = postIdOfSlug(slug);
  if (postId !== null) {
    const event = await fetchAfishaEvent(postId);
    if (!event) notFound();
    // The title — and with it the slug — may have been corrected since a link was shared.
    if (event.slug !== slug) permanentRedirect(eventPath(event));
    return <EventPage event={event} />;
  }
  const city = await loadCity(slug);
  if (!city) notFound();
  return <CityPageView city={city} />;
}

/** «Прогулка уже прошла» / «Групповой квест уже прошёл». */
function pastLine(event: AfishaEventWire): string {
  return event.kind === 'quest' ? 'Групповой квест уже прошёл.' : 'Прогулка уже прошла.';
}

function EventPage({ event }: { event: AfishaEventWire }) {
  const facts = eventFacts(event);
  return (
    <SiteShell>
      <JsonLd data={eventJsonLd(event)} />
      <article className="container afi afi-event" data-screen-label="Анонс">
        <nav className="afi-crumbs" aria-label="Навигация">
          <Link href="/afisha">Афиша</Link>
          <span aria-hidden> / </span>
          <Link href={cityPath(event.city_slug)}>{event.city}</Link>
        </nav>
        <div className="afi-event__grid">
          <div className="afi-event__main">
            <p className="afi-kind">{KIND_LABEL[event.kind]}</p>
            <h1 className="afi-event__title heading">{event.title}</h1>
            <p className="afi-event__when">
              <time dateTime={event.starts_at}>{longWhen(event)}</time> · {event.city}
            </p>
            {event.image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="afi-event__photo" src={event.image} alt={event.title} />
            )}
            {event.description && (
              <div className="afi-event__desc">
                {event.description.split('\n').map((line, i) => (line.trim() ? <p key={i}>{line}</p> : null))}
              </div>
            )}
          </div>
          <aside className="afi-event__side card" aria-label="Подробности">
            <dl className="afi-facts">
              <div>
                <dt>Когда</dt>
                <dd>{longWhen(event)}</dd>
              </div>
              <div>
                <dt>Город</dt>
                <dd>{event.city}</dd>
              </div>
              {facts.map((f) => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
            {event.past ? (
              <p className="afi-event__past">
                {pastLine(event)} <Link href={cityPath(event.city_slug)}>Ближайшие — {event.city}</Link>
              </p>
            ) : (
              event.register_url && (
                <>
                  <a className="btn btn--block" href={registerHref(event)} rel="nofollow">
                    Записаться
                  </a>
                  <p className="afi-event__hint">Запись — в Telegram, в один клик.</p>
                </>
              )
            )}
            <a className="afi-event__post" href={event.post_url} target="_blank" rel="noopener">
              Анонс в Telegram-канале
            </a>
          </aside>
        </div>
        <QuestsNote />
      </article>
    </SiteShell>
  );
}

function CityPageView({ city }: { city: CityPage }) {
  return (
    <SiteShell>
      <JsonLd data={listJsonLd(`Групповые прогулки и квесты: ${city.name}`, city.upcoming)} />
      <div className="container afi" data-screen-label="Афиша города">
        <nav className="afi-crumbs" aria-label="Навигация">
          <Link href="/afisha">Афиша</Link>
        </nav>
        <header className="afi-head">
          <h1 className="afi-title heading">{city.name}: групповые прогулки и квесты</h1>
          <p className="afi-lede">
            Прогулки, походы и квесты с организатором — {city.name}. Место встречи, время и маршрут в каждом
            анонсе, запись в один клик через Telegram.
          </p>
        </header>
        <section className="afi-section" aria-labelledby="afi-city-upcoming">
          <h2 id="afi-city-upcoming" className="afi-section__title">
            Ближайшие
          </h2>
          {city.upcoming.length > 0 ? <AfishaGrid events={city.upcoming} /> : <ChannelNote empty />}
        </section>
        {city.past.length > 0 && (
          <section className="afi-section" aria-labelledby="afi-city-past">
            <h2 id="afi-city-past" className="afi-section__title">
              Уже прошли
            </h2>
            <AfishaGrid events={city.past.slice(0, CITY_PAST)} />
            {city.past.length > CITY_PAST && (
              <Link className="afi-more" href="/afisha/arhiv">
                Все прошедшие прогулки и квесты
              </Link>
            )}
          </section>
        )}
        <QuestsNote />
      </div>
    </SiteShell>
  );
}
