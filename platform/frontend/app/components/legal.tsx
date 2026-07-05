import React from 'react';

/**
 * Shared shell for the static legal pages (/privacy, /terms — §2.6).
 * One layout, two documents: DRY without inventing a CMS.
 */
export function LegalArticle({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <main className="container legal">
      <h1 className="display legal__title">{title}</h1>
      <p className="legal__updated">Обновлено: {updated}</p>
      <article className="legal__body">{children}</article>
    </main>
  );
}
