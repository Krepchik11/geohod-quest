import Link from 'next/link';
import SiteShell from './components/SiteShell';

/**
 * A wrong address used to land on Next's built-in 404: an unstyled English
 * page with no header, no way back and no sign it belonged to this site. This
 * is the same page as every other, in the same language, with the two links
 * someone who mistyped a quest address actually wants.
 */
export default function NotFound() {
  return (
    <SiteShell>
      <main className="container" style={{ padding: '72px 0 96px', textAlign: 'center' }}>
        <h1 className="display" style={{ fontSize: 28, marginBottom: 12 }}>
          Страница не найдена
        </h1>
        <p style={{ color: 'var(--muted-2)', marginBottom: 28 }}>
          Возможно, квест сняли с продажи или в адресе опечатка.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link className="btn btn--md" href="/#shop">
            В магазин квестов
          </Link>
          <Link className="btn btn--quiet btn--md" href="/my-quests">
            Мои квесты
          </Link>
        </div>
      </main>
    </SiteShell>
  );
}
