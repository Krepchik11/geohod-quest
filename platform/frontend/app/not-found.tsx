import Link from 'next/link';
import SiteShell from './components/SiteShell';

/** Next's built-in 404 is unstyled, English, and offers no way back. */
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
