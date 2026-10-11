import React from 'react';
import Link from 'next/link';
import { KIND_LABEL, eventPath, shortWhen, type AfishaEventWire } from '../../lib/afisha';
import { CLUB_CHANNEL, CLUB_CHANNEL_URL } from '../../lib/contacts';
import { monogram } from '../../lib/cover';

/**
 * The pieces the «Афиша» pages share. Server components: every page renders
 * on the server, so a crawler reads the announcements without JavaScript.
 */

/** One announcement in a list: the whole card links to its page. */
export function AfishaCard({ event }: { event: AfishaEventWire }) {
  return (
    <article className={`afi-card card${event.past ? ' is-past' : ''}`}>
      <Link className="afi-card__link" href={eventPath(event)}>
        <div className="afi-card__photo">
          {event.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={event.image} alt="" loading="lazy" />
          ) : (
            <span className="afi-card__mark" aria-hidden>
              {monogram(event.title)}
            </span>
          )}
        </div>
        <div className="afi-card__body">
          <p className="afi-kind">{KIND_LABEL[event.kind]}</p>
          <h3 className="afi-card__title">{event.title}</h3>
          <p className="afi-card__when">{shortWhen(event)}</p>
          <p className="afi-card__where">{event.place ? `${event.city}, ${event.place}` : event.city}</p>
          {event.price && <p className="afi-card__price">{event.price}</p>}
        </div>
      </Link>
    </article>
  );
}

export function AfishaGrid({ events }: { events: readonly AfishaEventWire[] }) {
  return (
    <div className="afi-grid">
      {events.map((e) => (
        <AfishaCard key={e.post_id} event={e} />
      ))}
    </div>
  );
}

/**
 * Where the announcements come from, and where to follow them; `empty` is
 * the sentence saying a list has nothing upcoming (`true` for the generic one).
 */
export function ChannelNote({ empty = false }: { empty?: boolean | string }) {
  const lead = empty === true ? 'Ближайших анонсов пока нет.' : empty || '';
  return (
    <p className="afi-note">
      {lead ? `${lead} ` : ''}
      Новые прогулки и квесты сначала появляются в Telegram-канале{' '}
      <a href={CLUB_CHANNEL_URL} target="_blank" rel="noopener">
        {CLUB_CHANNEL}
      </a>
      .
    </p>
  );
}

/** The quests one can play any day, without a group. */
export function QuestsNote() {
  return (
    <section className="afi-quests card">
      <h2 className="afi-quests__title">Не совпали даты?</h2>
      <p>
        Городские квесты GEOHOD можно пройти в любой день: задания в смартфоне, гид не нужен.{' '}
        <Link href="/#shop">Выбрать квест</Link>
      </p>
    </section>
  );
}
