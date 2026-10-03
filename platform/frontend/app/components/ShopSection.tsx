'use client';

import React, { useRef, type ReactNode } from 'react';
import { useStuck } from '../../lib/use-stuck';

/** Height of the pinned site header on a phone (globals.css .site-header): the
 *  shop heads pin right under it. */
export const HEADER_PIN_PX = 64;
/** Height of a pinned shop head on a phone (styles/storefront.css). */
const SHOP_HEAD_PX = 52;

/**
 * One run of the shop — a city of the feed (`store_cities`), or the whole shop
 * without it: the head (title, count, controls) and the cards under it.
 *
 * On a phone the head pins under the site header while its own cards scroll by
 * and the next run's head pushes it out, so the pinned row always names the
 * city the player is looking at. The LAST head slides away whole once its
 * cards end: the page may run out before they have pushed it under the header.
 */
export default function ShopSection({
  head,
  last,
  children,
}: {
  head: ReactNode;
  last: boolean;
  children: ReactNode;
}) {
  const headSentinel = useRef<HTMLDivElement | null>(null);
  const endSentinel = useRef<HTMLDivElement | null>(null);
  const stuck = useStuck(headSentinel, HEADER_PIN_PX);
  // The run's end has reached the head's lower edge: the head is on its way out.
  const ended = useStuck(endSentinel, HEADER_PIN_PX + SHOP_HEAD_PX);
  // Pinned (and shadowed) only while its own cards run under it.
  const pinned = stuck && !ended;

  return (
    <div className="shop-section">
      <div className="sticky-sentinel" ref={headSentinel} aria-hidden />
      <div className={`store__head${pinned ? ' is-stuck' : ''}${last && ended ? ' is-leaving' : ''}`}>{head}</div>
      {children}
      <div className="sticky-sentinel" ref={endSentinel} aria-hidden />
    </div>
  );
}
