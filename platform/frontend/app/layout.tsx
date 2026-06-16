import type { Metadata } from "next";
import { Geist, Geist_Mono, Jost, Prata } from "next/font/google";
import SwRegister from "./components/SwRegister";
import "./globals.css";
import "./styles/player-paper.css";
import "./styles/commerce.css";
import "./styles/myquests.css";
import "./styles/admin-ctor.css";
import "./styles/ctor-workspace.css";
import "./styles/pwa-sync.css";
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
      {/* Design body classes applied by pages (body.site for public, body.admin for ctor/cabinet). 
          Per react.md: RSC shell thin, no shared mutable state, lang=ru from design. */}
      <body className="min-h-full flex flex-col">
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
