'use client';

import React, { useState } from 'react';

interface Props {
  questId: string;
  onBuy: (questId: string, coupon?: number) => void;
  onClose?: () => void;
}

/**
 * Small focused CheckoutForm (per react + design: coupon % state, Buy/GetFree handlers, narrow, explicit, no inside, no barrel).
 * Numeric % input (0-100); 100 treated as free source upstream.
 */
export function CheckoutForm({ questId, onBuy, onClose }: Props) {
  const [coupon, setCoupon] = useState<number>(0);

  return (
    <div className="mt-2 rounded border p-3 text-xs">
      <div className="mb-1">Checkout for {questId} (stub, no real $)</div>
      <div className="flex items-center gap-2">
        <label>Coupon %</label>
        <input
          type="number"
          min={0}
          max={100}
          value={coupon}
          onChange={(e) => setCoupon(Math.max(0, Math.min(100, parseInt(e.target.value || '0', 10))))}
          className="w-16 border p-1 text-xs"
        />
        <button onClick={() => onBuy(questId, coupon)} className="rounded bg-emerald-600 px-2 py-1 text-white">
          Buy / Apply
        </button>
        <button onClick={() => onBuy(questId, 100)} className="rounded border px-2 py-1">
          Get free
        </button>
        {onClose && (
          <button onClick={onClose} className="text-xs underline">
            cancel
          </button>
        )}
      </div>
      <div className="mt-1 text-[10px] text-zinc-500">100% or free → CouponRedemption/FreeQuest source (identical grant/attempt/facts)</div>
    </div>
  );
}