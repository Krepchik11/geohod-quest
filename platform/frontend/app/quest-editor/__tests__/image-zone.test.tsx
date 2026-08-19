// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { ImageZone } from '../controls';
import { COVER_IMAGE_MAX_BYTES, STEP_IMAGE_MAX_BYTES } from '../../../lib/image-crop';

/**
 * Every constructor image is a 4:3 crop of an uncropped source: the source and
 * the chosen rect are kept next to the published URL, so clicking a filled zone
 * REOPENS the crop instead of forcing a re-upload. What the ZONE owes the
 * pipeline (lib/image-authoring, mocked here — it is browser-only):
 * - picking a file opens the crop, and only a confirm commits it;
 * - clicking a filled zone re-crops the stored value, byte budget included;
 * - clearing drops the crop and its source together.
 */
vi.mock('../../../lib/image-authoring', async (orig) =>
  (await import('./crop-mocks')).cropAuthoringMock(
    await orig<typeof import('../../../lib/image-authoring')>(),
  ));

import { beginCropFromFile, beginCropFromValue, commitCrop } from '../../../lib/image-authoring';
import { cropSession, filledImage, installResizeObserver } from './crop-mocks';

const COMMITTED = { url: '/media/crop.jpg', origin: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(beginCropFromFile).mockResolvedValue(cropSession());
  vi.mocked(beginCropFromValue).mockResolvedValue(cropSession());
  vi.mocked(commitCrop).mockResolvedValue(COMMITTED);
});

installResizeObserver();

const FILLED = filledImage('crop');

function setup(props: Partial<React.ComponentProps<typeof ImageZone>> = {}) {
  const onChange = vi.fn();
  const { container } = render(
    <ImageZone
      value={{ url: null, origin: null }}
      label="изображение"
      maxBytes={STEP_IMAGE_MAX_BYTES}
      onChange={onChange}
      {...props}
    />,
  );
  const pickFile = () => fireEvent.change(container.querySelector('input[type=file]')!, {
    target: { files: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] },
  });
  const confirmCrop = async () =>
    fireEvent.click(await screen.findByRole('button', { name: 'Обрезать и загрузить' }));
  return { onChange, pickFile, confirmCrop };
}

describe('ImageZone — upload', () => {
  it('a picked file opens the crop, and confirming commits it with the zone’s budget', async () => {
    const { onChange, pickFile, confirmCrop } = setup();
    pickFile();
    await waitFor(() => expect(beginCropFromFile).toHaveBeenCalled());
    await confirmCrop();

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(COMMITTED));
    // The default 4:3 rect of a 1000×600 source, and the page-image budget.
    expect(vi.mocked(commitCrop).mock.calls[0][1]).toEqual({ x: 100, y: 0, width: 800, height: 600 });
    expect(vi.mocked(commitCrop).mock.calls[0][2]).toBe(STEP_IMAGE_MAX_BYTES);
  });

  it('honours the cover byte budget — same crop pipeline, bigger picture', async () => {
    const { pickFile, confirmCrop } = setup({ maxBytes: COVER_IMAGE_MAX_BYTES });
    pickFile();
    await confirmCrop();
    await waitFor(() => expect(commitCrop).toHaveBeenCalled());
    expect(vi.mocked(commitCrop).mock.calls[0][2]).toBe(COVER_IMAGE_MAX_BYTES);
  });

  // Both ways out of the crop owe the same thing: nothing uploaded, nothing
  // committed. One body, so the contract has one place to change.
  it.each([
    ['кнопка «Отмена»', async () => fireEvent.click(await screen.findByRole('button', { name: 'Отмена' }))],
    // Нажатие повторяется, пока не подействует: подписку на Escape вешает
    // эффект наложения, а диалог виден в DOM уже до него — на медленной машине
    // одиночное нажатие уходило в пустоту и роняло гейт релиза.
    ['Escape', async () => {
      await screen.findByRole('dialog');
      await waitFor(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    }],
  ])('commits nothing when the author dismisses the crop with %s', async (_name, dismiss) => {
    const { onChange, pickFile } = setup();
    pickFile();
    await dismiss();

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commitCrop).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ImageZone — re-crop', () => {
  it('clicking the image reopens the crop on the saved rect', async () => {
    vi.mocked(beginCropFromValue).mockResolvedValue(cropSession(FILLED.origin.rect));
    const { onChange, confirmCrop } = setup({ value: FILLED });
    fireEvent.click(screen.getByRole('button', { name: 'Изменить кадрирование: изображение' }));

    await waitFor(() => expect(beginCropFromValue).toHaveBeenCalledWith(FILLED));
    await confirmCrop();

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(COMMITTED));
    expect(vi.mocked(commitCrop).mock.calls[0][1]).toEqual(FILLED.origin.rect);
  });

  it('a legacy image with no stored source still opens the crop (from itself)', async () => {
    // Images uploaded before crop origins existed must not be a dead end — the
    // zone asks the pipeline to re-crop the value, source or no source.
    const legacy = { url: '/media/old.jpg', origin: null };
    setup({ value: legacy });
    fireEvent.click(screen.getByRole('button', { name: 'Изменить кадрирование: изображение' }));
    await waitFor(() => expect(beginCropFromValue).toHaveBeenCalledWith(legacy));
  });

  it('the remove button clears both the crop and its source', () => {
    const { onChange } = setup({ value: FILLED });
    fireEvent.click(screen.getByRole('button', { name: 'Убрать изображение' }));
    expect(onChange).toHaveBeenLastCalledWith({ url: null, origin: null });
  });

  // The zone itself announces what a click does — a block that forgets to say so
  // in prose still cannot hide the affordance.
  it('announces the click affordance as a tooltip, not only to screen readers', () => {
    setup({ value: FILLED });
    const zone = screen.getByRole('button', { name: 'Изменить кадрирование: изображение' });
    expect(zone.getAttribute('title')).toBe('Изменить кадрирование: изображение');
  });
});
