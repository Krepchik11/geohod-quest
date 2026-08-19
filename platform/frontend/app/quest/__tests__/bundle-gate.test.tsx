// @vitest-environment jsdom
/**
 * The gate asks the server what this quest has already paid the player and
 * hands the answer to the player (issue #117). It never waits for it: a
 * downloaded quest must open without the network, so an answer that is slow,
 * refused, or offline simply never arrives and withholds nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { QuestSnapshot } from '../../../lib/shared-model';

vi.mock('../QuestPlayerClient', () => ({
  default: ({ paidBonuses }: { paidBonuses: readonly string[] }) => (
    <div data-testid="player">{JSON.stringify(paidBonuses)}</div>
  ),
}));

vi.mock('../../../lib/bundle-resolver', () => ({
  resolveGate: vi.fn(async () => ({
    kind: 'ready',
    snapshot: {} as QuestSnapshot,
    snapshotId: 'snap-1',
  })),
}));

vi.mock('../../../lib/identity', () => ({ currentUserId: () => 'player-1' }));

const questBonuses = vi.fn();
vi.mock('../../../lib/api', () => ({ api: { questBonuses: () => questBonuses() } }));

import BundleGate from '../BundleGate';

const paid = async () => JSON.parse((await screen.findByTestId('player')).textContent || '[]');

beforeEach(() => {
  questBonuses.mockReset();
});

describe('BundleGate — what the server already paid (#117)', () => {
  it('hands the player the kinds it understands, dropping the ones it does not', async () => {
    questBonuses.mockResolvedValue({ kinds: ['completion_bonus', 'gift_claimed'] });
    render(<BundleGate questId="q1" />);
    await waitFor(async () => expect(await paid()).toEqual(['completion_bonus']));
  });

  it('opens the quest with nothing withheld when the answer never comes', async () => {
    questBonuses.mockRejectedValue(new Error('offline'));
    render(<BundleGate questId="q1" />);
    expect(await paid()).toEqual([]);
  });

  it('asks nothing at all when the device is offline', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<BundleGate questId="q1" />);
    expect(await paid()).toEqual([]);
    expect(questBonuses).not.toHaveBeenCalled();
    online.mockRestore();
  });
});
