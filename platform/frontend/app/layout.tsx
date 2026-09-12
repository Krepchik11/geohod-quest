import type { Metadata } from "next";
import { Geist, Geist_Mono, Jost, Prata } from "next/font/google";
import SwRegister from "./components/SwRegister";
import { SITE_URL } from "../lib/site";
import TabBar from "./components/TabBar";
import Toaster from "./components/Toaster";
import "./globals.css"; // canonical design system (primitives live here)
// §0 (v2): one token layer + canonical primitives live in globals.css
// (.btn + variants/sizes, .input/.textarea, .link, .panel, .card). The legacy
// duplicate primitive families (.s-*, .adm-*, .btn-ui, .field-ui, .textarea-ui)
// are deleted; `npm run lint:ds` fails if any of them reappears.
//
// ONLY the sheets every visitor actually needs are imported here. A stylesheet
// imported in the root layout is downloaded by everyone, on the first paint of
// every route — so the admin desk, the constructor and the player paper are
// imported by the layout of the subtree that owns them instead (see
// `npm run lint:css-scope`, which fails if a class escapes its subtree).
import "./styles/commerce.css";
import "./styles/store-toolbar.css";
import "./styles/myquests.css";

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
  // Absolute base for every relative URL in a page's metadata (share cards,
  // canonical links). Null when the deployment was never told its own address —
  // absolute URLs still work, relative ones are simply omitted.
  ...(SITE_URL ? { metadataBase: new URL(SITE_URL) } : {}),
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
        {/* §1.2: mobile bottom tab bar — self-gates to the three top-level pages */}
        <TabBar />
        <Toaster />
        <SwRegister />
      </body>
    </html>
  );
}
