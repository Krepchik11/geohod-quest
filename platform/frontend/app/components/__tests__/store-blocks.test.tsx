// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

/**
 * «Вместе веселее» under the shop: the channel link always stays; while the
 * «Афиша» is on, the block also leads there.
 */
const { featureMock } = vi.hoisted(() => ({ featureMock: vi.fn() }));
vi.mock('../../../lib/client-features', () => ({ useClientFeature: featureMock }));

import { TogetherBlock } from '../StoreBlocks';

beforeEach(() => featureMock.mockReset());

describe('TogetherBlock', () => {
  it('leads to the «Афиша» and keeps the channel while the «Афиша» is on', () => {
    featureMock.mockImplementation((key: string) => key === 'afisha');
    render(<TogetherBlock />);
    expect(screen.getByRole('link', { name: 'Афиша' }).getAttribute('href')).toBe('/afisha');
    expect(screen.getByRole('link', { name: 'Все игры в канале' }).getAttribute('href')).toBe('https://t.me/serbia_progulki');
    expect(screen.getByText(/в афише, анонсы выходят в канале «Прогулки по Сербии»/)).toBeTruthy();
  });

  it('keeps only the channel while the «Афиша» is off', () => {
    featureMock.mockReturnValue(false);
    render(<TogetherBlock />);
    expect(screen.queryByRole('link', { name: 'Афиша' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Все игры в канале' })).toBeTruthy();
    expect(screen.getByText(/анонсируем в канале «Прогулки по Сербии»/)).toBeTruthy();
  });
});
