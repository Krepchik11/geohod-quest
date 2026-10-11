import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import SiteShell from '../../components/SiteShell';
import { AfishaGrid, ChannelNote } from '../parts';
import { ARCHIVE_LIMIT, fetchAfisha, monthLabel, type AfishaEventWire } from '../../../lib/afisha';

export const revalidate = 300;

export const metadata: Metadata = {
  title: 'Архив прогулок и квестов — Афиша GEOHOD',
  description: 'Прошедшие групповые прогулки, походы и квесты с организатором — по месяцам.',
  alternates: { canonical: '/afisha/arhiv' },
};

/** Past announcements by month, newest first. */
function byMonth(events: readonly AfishaEventWire[]): { label: string; events: AfishaEventWire[] }[] {
  const groups: { label: string; events: AfishaEventWire[] }[] = [];
  for (const e of events) {
    const label = monthLabel(e.date);
    const last = groups.at(-1);
    if (last?.label === label) last.events.push(e);
    else groups.push({ label, events: [e] });
  }
  return groups;
}

/**
 * /afisha/arhiv — every past announcement. An archive shows walks happen
 * week after week, which is what a reader (and an AI assistant) checks before
 * trusting a schedule.
 */
export default async function AfishaArchivePage() {
  const past = await fetchAfisha('past', ARCHIVE_LIMIT);
  if (!past) notFound();
  return (
    <SiteShell>
      <div className="container afi" data-screen-label="Архив афиши">
        <nav className="afi-crumbs" aria-label="Навигация">
          <Link href="/afisha">Афиша</Link>
        </nav>
        <header className="afi-head">
          <h1 className="afi-title heading">Архив</h1>
          <p className="afi-lede">Прогулки и квесты, которые уже прошли.</p>
        </header>
        {past.length === 0 && <ChannelNote />}
        {byMonth(past).map((group) => (
          <section className="afi-section" key={group.label} aria-label={group.label}>
            <h2 className="afi-section__title">{group.label}</h2>
            <AfishaGrid events={group.events} />
          </section>
        ))}
      </div>
    </SiteShell>
  );
}
