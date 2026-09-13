import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Telegram's telegram-login.js completes the OIDC login through a popup
          // and talks to it via window.opener. A `Cross-Origin-Opener-Policy:
          // same-origin` header would sever that channel and break the login;
          // `same-origin-allow-popups` keeps cross-origin isolation for the page
          // while letting the auth popup work. (core.telegram.org/bots/telegram-login
          // — "Using the Telegram Login library".)
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },

          // The session token lives in localStorage — the locked identity
          // decision, and the only shape that works for an anonymous-first
          // offline PWA talking to a separate API origin. So the browser-side
          // guarantees below are the ones that carry weight.
          //
          // The policy is deliberately the part that is PROVABLE for this app
          // rather than the longest one that could be written. The app has no
          // <base>, no <object>/<embed>, and is never framed, so these three
          // directives cost nothing and close clickjacking, base-URL rewriting
          // and plugin injection outright. A `script-src` is NOT here: Next
          // inlines its own bootstrap script (it would need a nonce, hence
          // middleware on every request) and the media host is a backend runtime
          // value the build cannot know — a guessed allowlist would silently
          // break offline media or a sign-in provider instead of protecting
          // anything. See platform/deploy/README.md for what locking scripts down
          // would take.
          {
            key: 'Content-Security-Policy',
            value: "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
          },
          { key: 'X-Frame-Options', value: 'DENY' },

          // Author-uploaded images are served from another origin, but the app's
          // own responses must never be re-typed by a browser's guess either.
          { key: 'X-Content-Type-Options', value: 'nosniff' },

          // Quest URLs identify what someone bought and is playing. Send the
          // path only to our own origin, the bare origin to anyone else.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },

          // None of these APIs is called anywhere in the app (a quest points at
          // a map link; an image comes from a file input). Denying them means a
          // third-party script cannot start asking on the app's behalf.
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },

          // Two years, and NOT includeSubDomains: this pins the app's own origin,
          // which is HTTPS-only, without making a promise for sibling hosts this
          // build knows nothing about. Browsers ignore it over plain HTTP, so it
          // is inert in local development.
          { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
        ],
      },
    ];
  },
  async redirects() {
    return [
      {
        // The editor used to live at /constructor; a route segment named
        // "constructor" collides with Object.prototype in Next's dev
        // segment-explorer trie and crashes every dev render of the page.
        source: "/constructor",
        destination: "/quest-editor",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
