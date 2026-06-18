'use client';

import React from 'react';
import Link from 'next/link';

/**
 * Шапка билдера (рабочего места одного квеста): бренд, хлебные крошки, действия
 * справа. Главная страница конструктора (список созданных квестов) живёт в
 * Dashboard — этот файл оставлен ради общей шапки, которую использует Builder.
 */
export function WspHeader({ crumbs, children }: { crumbs: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="wsp-top">
      <Link href="/" aria-label="На главную"><span className="brand" style={{ display: 'block' }} /></Link>
      <span className="wsp-crumbs">{crumbs}</span>
      <span className="sp" />
      {children}
    </header>
  );
}
