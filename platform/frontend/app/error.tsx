'use client';

import Link from 'next/link';
import { useEffect } from 'react';

/**
 * Root error boundary — it also catches /admin and /quest-editor, so the chrome
 * here is deliberately bare. `reset()` re-renders the failed subtree.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is the only handle on the server-side cause.
    console.error('Необработанная ошибка на странице', error.digest ?? '', error);
  }, [error]);

  return (
    <main
      className="container"
      style={{ padding: '72px 0 96px', textAlign: 'center' }}
      role="alert"
    >
      <h1 className="display" style={{ fontSize: 26, marginBottom: 12 }}>
        Что-то пошло не так
      </h1>
      <p style={{ color: 'var(--muted-2)', marginBottom: 28 }}>
        Страница не открылась. Прогресс квестов хранится на устройстве и никуда не делся.
      </p>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn--md" type="button" onClick={reset}>
          Попробовать снова
        </button>
        <Link className="btn btn--quiet btn--md" href="/">
          На главную
        </Link>
      </div>
    </main>
  );
}
