import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    // Telegram's telegram-login.js completes the OIDC login through a popup and
    // talks to it via window.opener. A `Cross-Origin-Opener-Policy: same-origin`
    // header would sever that channel and break the login; `same-origin-allow-popups`
    // keeps cross-origin isolation for the page while letting the auth popup work.
    // (core.telegram.org/bots/telegram-login — "Using the Telegram Login library".)
    return [
      {
        source: '/:path*',
        headers: [{ key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' }],
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
