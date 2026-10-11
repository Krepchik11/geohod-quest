import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import SiteShell from '../components/SiteShell';
import JsonLd from '../components/JsonLd';
import { AfishaGrid, ChannelNote, QuestsNote } from './parts';
import { citiesOf, cityPath, fetchAfisha, listJsonLd } from '../../lib/afisha';
import { CLUB_CHANNEL } from '../../lib/contacts';

/** Rendered on the server and refreshed every five minutes (lib/afisha REVALIDATE_SECONDS). */
export const revalidate = 300;

export const metadata: Metadata = {
  title: 'Афиша: групповые прогулки и квесты в Сербии — GEOHOD',
  description:
    'Ближайшие групповые прогулки, походы и квесты с организатором в городах Сербии. ' +
    'Место встречи, время, маршрут и запись в один клик через Telegram.',
  alternates: { canonical: '/afisha' },
};

/** How many past announcements the hub shows under the upcoming ones. */
const RECENT_PAST = 6;

/**
 * /afisha — the hub: upcoming group walks and quests soonest first, the
 * cities they happen in, and the latest past ones. Off (404) until the admin
 * switches the «Афиша» on.
 */
export default async function AfishaPage() {
  const [upcoming, past] = await Promise.all([fetchAfisha('upcoming'), fetchAfisha('past', RECENT_PAST)]);
  if (!upcoming || !past) notFound();
  const cities = citiesOf([...upcoming, ...past]);
  return (
    <SiteShell>
      <JsonLd data={listJsonLd('Ближайшие групповые прогулки и квесты', upcoming)} />
      <div className="container afi" data-screen-label="Афиша">
        <header className="afi-head">
          <p className="overline">{CLUB_CHANNEL}</p>
          <h1 className="afi-title heading">Афиша</h1>
          <p className="afi-lede">
            Групповые прогулки, походы и квесты с организатором. Записаться можно в один клик — через Telegram.
          </p>
          {cities.length > 0 && (
            <nav className="afi-cities" aria-label="Города">
              {cities.map((c) => (
                <Link key={c.slug} className="afi-chip" href={cityPath(c.slug)}>
                  {c.name}
                </Link>
              ))}
            </nav>
          )}
        </header>

        <section className="afi-section" aria-labelledby="afi-upcoming">
          <h2 id="afi-upcoming" className="afi-section__title">
            Ближайшие
          </h2>
          {upcoming.length > 0 ? <AfishaGrid events={upcoming} /> : <ChannelNote empty />}
        </section>

        {past.length > 0 && (
          <section className="afi-section" aria-labelledby="afi-past">
            <h2 id="afi-past" className="afi-section__title">
              Недавно прошли
            </h2>
            <AfishaGrid events={past} />
            <Link className="afi-more" href="/afisha/arhiv">
              Все прошедшие прогулки и квесты
            </Link>
          </section>
        )}

        {upcoming.length > 0 && <ChannelNote />}
        <QuestsNote />
      </div>
    </SiteShell>
  );
}
