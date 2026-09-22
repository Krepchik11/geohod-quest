import type { Metadata } from "next";
import { Geist, Geist_Mono, Jost, Prata } from "next/font/google";
import SwRegister from "./components/SwRegister";
import { siteUrl } from "../lib/share";
import Toaster from "./components/Toaster";
import "./globals.css"; // canonical design system (primitives live here)
// §0 (v2): one token layer + canonical primitives live in globals.css
// (.btn + variants/sizes, .input/.textarea, .link, .panel, .card). The legacy
// duplicate primitive families (.s-*, .adm-*, .btn-ui, .field-ui, .textarea-ui)
// are deleted; `npm run lint:ds` fails if any of them reappears.
import "./styles/player-paper.css";
import "./styles/commerce.css";
import "./styles/store-toolbar.css";
import "./styles/myquests.css";
import "./styles/admin-ctor.css";
import "./styles/ctor-workspace.css";
import "./styles/ctor-dashboard.css";
import "./styles/admin-users.css";
import "./styles/admin-shell.css";
import "./styles/admin-page.css";
import "./styles/admin-coupons.css";
import "./styles/admin-features.css";
import "./styles/admin-stats.css";
import "./styles/admin-moderation.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const jost = Jost({
  variable: "--font-jost",
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  style: ["normal"],
});

const prata = Prata({
  variable: "--font-prata",
  subsets: ["latin"],
  weight: ["400"],
});

export const metadata: Metadata = {
  // Absolute base for every relative metadata URL — notably the per-quest
  // Open Graph image, which crawlers only accept fully qualified.
  metadataBase: new URL(siteUrl()),
  title: "GEOHOD QUEST — авторские квесты",
  description: "GEOHOD QUEST — авторские городские квесты. Откройте город с новой стороны. Магазин квестов, игрок и конструктор.",
  icons: {
    // Logo mark only (no wordmark), on a transparent ground. Transparency costs
    // the white plate that used to lift the navy mark off a dark tab strip, so
    // the scheme-matched pair pays it back: the white mark is served in dark
    // mode.
    //
    // /favicon.ico is deliberately NOT listed here. app/favicon.ico is a file
    // convention — Next emits its <link> ahead of these, which is exactly where
    // a catch-all belongs, because browsers take the LAST matching entry.
    // Repeating it below would have made the .ico win over both SVGs (it
    // matches every scheme) and the dark variant would never be served.
    icon: [
      { url: "/icon.svg", type: "image/svg+xml", media: "(prefers-color-scheme: light)" },
      { url: "/icon-dark.svg", type: "image/svg+xml", media: "(prefers-color-scheme: dark)" },
    ],
    // iOS renders alpha as black and rounds the corners itself, so this one is
    // an opaque square. Without it a home-screen shortcut gets a page
    // screenshot instead of the mark.
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ru"
      className={`${geistSans.variable} ${geistMono.variable} ${jost.variable} ${prata.variable} h-full antialiased`}
    >
      {/* Surface chrome lives in route wrappers: components/SiteShell (.site) for
          the public pages, app/admin/layout.tsx (.ash-root) for the admin space.
          Per react.md: RSC shell thin, no shared mutable state, lang=ru from design. */}
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster />
        <SwRegister />
      </body>
    </html>
  );
}
