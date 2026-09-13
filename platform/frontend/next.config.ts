import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Bare same-origin would sever window.opener and break Telegram login.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },

          {
            // No script-src: Next inlines its bootstrap (needs a nonce, so
            // middleware) and the media host is a backend runtime value.
            key: 'Content-Security-Policy',
            value: "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },

          // No includeSubDomains: this origin does not speak for its siblings.
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
