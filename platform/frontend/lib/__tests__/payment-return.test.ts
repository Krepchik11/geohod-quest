import { describe, it, expect, vi, beforeEach } from 'vitest';

const { statusMock } = vi.hoisted(() => ({ statusMock: vi.fn() }));
vi.mock('../api', () => ({ api: { paymentStatus: statusMock } }));

import { pollPaymentSettlement, RETURN_POLL_DELAYS_MS } from '../payment-return';

/**
 * Return-page poll after a ЮKassa redirect: finite backoff, resolves on the
 * first settled status, swallows transient errors, and reports `pending` when
 * the schedule runs out (the UI then offers a manual refresh).
 */
describe('pollPaymentSettlement', () => {
  const sleep = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    statusMock.mockReset();
  });

  it('resolves succeeded on the first settled poll without further attempts', async () => {
    statusMock
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'succeeded' });
    const outcome = await pollPaymentSettlement('p1', { delays: [0, 1, 1, 1], sleep });
    expect(outcome).toBe('succeeded');
    expect(statusMock).toHaveBeenCalledTimes(2);
    expect(statusMock).toHaveBeenCalledWith('p1');
  });

  it('resolves canceled as a terminal outcome', async () => {
    statusMock.mockResolvedValue({ status: 'canceled' });
    expect(await pollPaymentSettlement('p1', { delays: [0], sleep })).toBe('canceled');
  });

  it('keeps polling through transient errors and reports pending when exhausted', async () => {
    statusMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ status: 'pending' });
    const outcome = await pollPaymentSettlement('p1', { delays: [0, 1, 1], sleep });
    expect(outcome).toBe('pending');
    expect(statusMock).toHaveBeenCalledTimes(3);
  });

  it('waits between attempts per the schedule (first attempt immediate)', async () => {
    statusMock.mockResolvedValue({ status: 'pending' });
    const waits: number[] = [];
    await pollPaymentSettlement('p1', {
      delays: [0, 5, 9],
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(waits).toEqual([5, 9]);
  });

  it('ships a finite default schedule', () => {
    expect(RETURN_POLL_DELAYS_MS.length).toBeGreaterThan(2);
    expect(RETURN_POLL_DELAYS_MS[0]).toBe(0);
  });
});
