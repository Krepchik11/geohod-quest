import React from 'react';
import Link from 'next/link';
import { CLUB_CHANNEL, CLUB_CHANNEL_URL, SUPPORT_TG, SUPPORT_TG_URL } from '../../lib/contacts';

/**
 * §1.3 / §2.6 — one shared storefront footer, rendered on ALL storefront pages.
 * Honest by construction: no payment icons until a real PSP exists; the policy
 * links point at real /privacy and /terms pages (no href="#" anywhere).
 */
export default function SiteFooter() {
  return (
    <footer className="site-footer" id="contacts">
      <div className="site-footer__inner container">
        <div className="site-footer__brand">
          <Link className="logo logo--white" href="/" aria-label="GEOHOD QUEST — на главную">
            <span className="ic logo-mark" />
            <span className="ic logo-text" />
          </Link>
          <p className="site-footer__tagline">авторские квесты</p>
        </div>
        <div className="site-footer__grid">
          {/* Contacts are Telegram only (lib/contacts): support first, then the club's channel. */}
          <div className="site-footer__col">
            <a className="contact" href={SUPPORT_TG_URL} target="_blank" rel="noopener">
              <span className="contact__tile"><span className="ic ic-tg" /></span>
              <span className="contact__value">{SUPPORT_TG} · поддержка</span>
            </a>
          </div>
          <div className="site-footer__col">
            <a className="contact" href={CLUB_CHANNEL_URL} target="_blank" rel="noopener">
              <span className="contact__tile"><span className="ic ic-tg" /></span>
              <span className="contact__value">{CLUB_CHANNEL} · канал</span>
            </a>
          </div>
          <div className="site-footer__links">
            {/* The header nav is hidden below 768px, so the footer is how a phone reaches this page. */}
            <Link href="/rules">Как играть</Link>
            <Link href="/privacy">Политика конфиденциальности</Link>
            <Link href="/terms">Пользовательское соглашение</Link>
            <span className="site-footer__copy">© 2026 GEOHOD QUEST</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
