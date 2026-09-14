import type { Metadata } from 'next';
import SiteShell from '../components/SiteShell';

export const metadata: Metadata = { title: 'Правила игры — GEOHOD QUEST' };

/** Was §2.4 on the landing — full-phrase headlines, four DISTINCT photo slots.
 *  Real photos are pending — labeled placeholders ship until the assets exist. */
const FEATURES = [
  { label: 'фото: экран квеста в руке', title: 'Все задания — в смартфоне', text: 'Начать и продолжить можно в любое время, число попыток не ограничено.' },
  { label: 'фото: компания на прогулке', title: 'Любое число участников', text: 'Проходите в одиночку или дружной компанией — вместе веселее.' },
  { label: 'фото: деталь старого города', title: 'Игра со смыслом', text: 'Квест знакомит с городскими легендами и историческими персонажами.' },
  { label: 'фото: скрытый двор / место', title: 'Маршруты к необычным местам', text: 'Ведём туда, мимо чего проходят даже местные.' },
];

export default function RulesPage() {
  return (
    <SiteShell>
      <section className="container" style={{ paddingTop: 48 }} data-screen-label="Правила игры">
        <h1 className="section-title display">правила игры</h1>
        <p style={{ maxWidth: 700, margin: '48px auto 0', textAlign: 'center' }}>
          GEOquest&nbsp;— это игра-экскурсия: участники выполняют задания в&nbsp;городе&nbsp;—
          находят на&nbsp;местности ответ на&nbsp;вопрос или отгадывают логическую загадку.
        </p>
        <div className="features" style={{ marginTop: 48 }}>
          {FEATURES.map((f) => (
            <article className="feature card" key={f.title}>
              <span className="feature__photo-slot" role="img" aria-label={f.label}>
                <span>{f.label}</span>
              </span>
              <div>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </SiteShell>
  );
}
