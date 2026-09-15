import type { Metadata } from "next";
import { Geist, Geist_Mono, Jost, Prata } from "next/font/google";
import SwRegister from "./components/SwRegister";
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
  title: "GEOHOD QUEST — авторские квесты",
  description: "GEOHOD QUEST — авторские городские квесты. Откройте город с новой стороны. Магазин квестов, игрок и конструктор.",
  icons: {
    // Logo mark only (no wordmark). SVG for crisp modern browsers; .ico fallback.
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "48x48" },
    ],
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
