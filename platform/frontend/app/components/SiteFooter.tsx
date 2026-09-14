import React from 'react';
import Link from 'next/link';

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
          <div className="site-footer__col">
            <a className="contact" href="mailto:geoquest@gmail.com">
              <span className="contact__tile"><span className="ic ic-mail"><span className="b" /><span className="f" /></span></span>
              <span className="contact__value">geoquest@gmail.com</span>
            </a>
            <a className="contact" href="tel:+381628888888">
              <span className="contact__tile"><span className="ic ic-phone" /></span>
              <span className="contact__value">+381 (062) 888 88 88 · мессенджеры</span>
            </a>
          </div>
          <div className="site-footer__col">
            <a className="contact" href="https://geohod.ru" target="_blank" rel="noopener">
              <span className="contact__tile"><span className="ic ic-globe"><span className="r" /><span className="s" /></span></span>
              <span className="contact__value">geohod.ru</span>
            </a>
            <a className="contact" href="https://t.me/serbia_progulki" target="_blank" rel="noopener">
              <span className="contact__tile"><span className="ic ic-tg" /></span>
              <span className="contact__value">t.me/serbia_progulki</span>
            </a>
          </div>
          <div className="site-footer__links">
            {/* The header nav is hidden below 768px, so the footer is how a phone reaches this page. */}
            <Link href="/rules">Правила игры</Link>
            <Link href="/privacy">Политика конфиденциальности</Link>
            <Link href="/terms">Пользовательское соглашение</Link>
            <span className="site-footer__copy">© 2026 GEOHOD QUEST</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
