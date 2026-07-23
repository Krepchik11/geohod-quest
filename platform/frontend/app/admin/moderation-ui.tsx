import React from 'react';
import type { AdminIdentityWire } from '../../lib/api';
import { identityContact } from '../../lib/admin-moderation';

/**
 * Shared render piece for the two moderation tabs (Отзывы + Обратная связь): the
 * single contact row — a `mailto:` / `t.me` link, or a disabled label when the author
 * is unreachable — so a review card and a feedback report render contact identically.
 */
export function ContactRow({
  identity,
  report = false,
}: {
  identity: AdminIdentityWire;
  /** Tighter layout variant used inside a feedback report row. */
  report?: boolean;
}) {
  const contact = identityContact(identity);
  return (
    <div className={report ? 'amod-contact amod-contact--report' : 'amod-contact'}>
      <span className="amod-contact__glyph" aria-hidden>
        {contact.glyph}
      </span>
      {contact.href ? (
        <a className="amod-contact__link" href={contact.href} target="_blank" rel="noreferrer">
          {contact.label}
        </a>
      ) : (
        <span className="amod-contact__off">{contact.label}</span>
      )}
    </div>
  );
}
