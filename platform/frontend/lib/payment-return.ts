import { api } from './api';

/**
 * Return-page poll after a ЮKassa redirect (§3.3 results screen). The payer
 * lands back on the quest page with `?payment={id}`; each poll lets the backend
 * lazily settle the payment against ЮKassa, so no webhook is required for the
 * happy path. The schedule is finite: a payment still pending after it (payer
 * closed the bank page, SBP lag) resolves as `pending` and the UI offers a
 * manual refresh instead of spinning forever.
 */
export const RETURN_POLL_DELAYS_MS = [0, 1500, 3000, 5000, 8000, 12000];

export type PaymentOutcome = 'succeeded' | 'canceled' | 'pending';

export async function pollPaymentSettlement(
  paymentId: string,
  {
    delays = RETURN_POLL_DELAYS_MS,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    delays?: number[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<PaymentOutcome> {
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    try {
      const r = await api.paymentStatus(paymentId);
      if (r.status !== 'pending') return r.status;
    } catch {
      // Transient (offline right after returning, cold backend) — the schedule
      // itself bounds the retries, so just move to the next attempt.
    }
  }
  return 'pending';
}
