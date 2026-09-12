'use client';

import Link from 'next/link';
import { useEffect } from 'react';

/**
 * The last line before a blank screen. Without this file a render error
 * anywhere in the app fell through to Next's built-in page — unstyled, in
 * English, and with no way out but the browser's Back button.
 *
 * «Попробовать снова» is `reset()`, which re-renders the failed subtree: for
 * the common cause, a request that lost the network mid-flight, that IS the
 * fix, and the offline player keeps everything it queued either way.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is the only handle on the server-side cause; without printing
    // it, a production report says nothing a developer can act on.
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
