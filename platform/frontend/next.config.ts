import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
