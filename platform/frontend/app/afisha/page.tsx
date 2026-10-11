import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import SiteShell from '../components/SiteShell';
import JsonLd from '../components/JsonLd';
import { AfishaGrid, ChannelNote } from './parts';
import { PartnerInvite, QUESTS_LEDE, QUESTS_SLOGAN, WALKS_LEDE, WALKS_SLOGAN, WalkRules } from './walks';
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
 * /afisha — the hub: upcoming walks and group quests soonest first, each kind
 * in its own section — the walks with how they work, the quests with what a
 * group game is — then the latest past ones and the invitation for
 * organizers. Off (404) until the admin switches the «Афиша» on.
 */
export default async function AfishaPage() {
  const [upcoming, past] = await Promise.all([fetchAfisha('upcoming'), fetchAfisha('past', RECENT_PAST)]);
  if (!upcoming || !past) notFound();
  const cities = citiesOf([...upcoming, ...past]);
  const walks = upcoming.filter((e) => e.kind === 'hiking');
  const quests = upcoming.filter((e) => e.kind === 'quest');
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

        <section className="afi-section" aria-labelledby="afi-walks">
          <h2 id="afi-walks" className="afi-section__title">
            Прогулки
          </h2>
          <p className="afi-slogan">{WALKS_SLOGAN}</p>
          <p className="afi-section__lede">{WALKS_LEDE}</p>
          {walks.length > 0 ? (
            <AfishaGrid events={walks} />
          ) : (
            <ChannelNote empty="Ближайших прогулок пока нет." />
          )}
          <WalkRules />
        </section>

        <section className="afi-section" aria-labelledby="afi-quests">
          <h2 id="afi-quests" className="afi-section__title">
            Групповые квесты
          </h2>
          <p className="afi-slogan">{QUESTS_SLOGAN}</p>
          <p className="afi-section__lede">
            {QUESTS_LEDE} Квест можно пройти и самостоятельно, в любой день: <Link href="/#shop">выбрать квест</Link>.
          </p>
          {quests.length > 0 ? (
            <AfishaGrid events={quests} />
          ) : (
            <ChannelNote empty="Ближайших групповых квестов пока нет." />
          )}
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

        <PartnerInvite />
      </div>
    </SiteShell>
  );
}
