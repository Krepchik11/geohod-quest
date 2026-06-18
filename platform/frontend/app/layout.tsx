import type { Metadata } from "next";
import { Geist, Geist_Mono, Jost, Prata } from "next/font/google";
import SwRegister from "./components/SwRegister";
import "./globals.css"; // canonical design system (primitives live here)
// DEPRECATION GUARD — harmonization Phase 1 Option A (frontend-harmonization-guide.md §3).
// Every stylesheet below is imported globally, so any route can reach any class; that global
// reach is the structural enabler of UI drift. The duplicate primitives in commerce.css (.s-*)
// and admin-ctor.css (.adm-*) are DEPRECATED — use the canonical primitives in globals.css
// (.btn/.btn--outline/.btn--block, .input/.input--error/.input-error-text, .link, .btn-ui/--sm,
// .field-ui/--sm/--wide, .textarea-ui, .panel) instead. `npm run lint:ds` fails on any new
// .s-*/.adm-* className. Do NOT delete the duplicate CSS blocks yet (Phase 1 Option B) — only
// after every route migrates and lint:ds is green. .p-* (player), .au-* (admin-users) and the
// unique layout classes are intentional systems, NOT deprecated.
import "./styles/player-paper.css";
import "./styles/commerce.css";
import "./styles/myquests.css";
import "./styles/admin-ctor.css";
import "./styles/ctor-workspace.css";
import "./styles/admin-users.css";
import "./styles/responsive.css"; // mobile/tablet adaptation — must stay LAST so its media-query overrides win by source order

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
    icon: "/favicon.ico",
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
      {/* Design body classes applied by pages (body.site for public, body.admin for the editor).
          Per react.md: RSC shell thin, no shared mutable state, lang=ru from design. */}
      <body className="min-h-full flex flex-col">
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
