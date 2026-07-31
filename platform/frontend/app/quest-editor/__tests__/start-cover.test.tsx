// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { PageEditor } from '../PageEditor';
import { newQuest, type CtorQuest } from '../../../lib/constructor-model';

/**
 * «Первый экран» IS the cover: the page shows it, so the author must be able to
 * change and re-crop it without leaving for the settings screen. The block still
 * mirrors quest meta — one field, two edit sites, one contract (QuestCoverZone).
 */
vi.mock('../../../lib/image-authoring', async (orig) =>
  (await import('./crop-mocks')).cropAuthoringMock(
    await orig<typeof import('../../../lib/image-authoring')>(),
  ));

import { beginCropFromValue } from '../../../lib/image-authoring';
import { cropSession, filledImage, installResizeObserver } from './crop-mocks';

installResizeObserver();

const COVER = filledImage('cover');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(beginCropFromValue).mockResolvedValue(cropSession(COVER.origin.rect));
});

function setup(metaPatch: Parameters<typeof newQuest>[0] = {}) {
  const quest: CtorQuest = newQuest({ title: 'X', ...metaPatch });
  const onMeta = vi.fn();
  render(
    <PageEditor
      quest={quest}
      step={quest.steps[0]}
      msgs={[]}
      onMeta={onMeta}
      onPatch={vi.fn()}
      onDelete={vi.fn()}
      onDuplicate={vi.fn()}
      onSettings={vi.fn()}
    />,
  );
  return { quest, onMeta };
}

describe('start page — cover zone', () => {
  it('offers an upload zone when the quest has no cover yet', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Загрузить изображение: обложка' })).toBeTruthy();
  });

  it('tapping the cover reopens its crop on the saved rect', async () => {
    setup({ cover: COVER.url, coverOrigin: COVER.origin });
    fireEvent.click(screen.getByRole('button', { name: 'Изменить кадрирование: обложка' }));
    await waitFor(() => expect(beginCropFromValue).toHaveBeenCalledWith(COVER));
  });

  it('clearing the cover patches quest meta, not the step', () => {
    const { onMeta } = setup({ cover: COVER.url, coverOrigin: COVER.origin });
    fireEvent.click(screen.getByRole('button', { name: 'Убрать изображение' }));
    expect(onMeta).toHaveBeenLastCalledWith(expect.objectContaining({ cover: null, coverOrigin: null }));
  });
});
