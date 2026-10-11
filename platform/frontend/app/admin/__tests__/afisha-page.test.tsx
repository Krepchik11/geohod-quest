// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { adminEvent } from '../../../lib/__tests__/afisha-fixtures';

/**
 * Admin · Афиша. Pinned behaviors: the list shows each announcement's status
 * and what a draft lacks, the filters narrow it; «Проверить канал» reads the
 * channel and toasts what changed; «Скрыть» takes one off; the edit form sends
 * the corrected fields; «Загрузить архив» pages until there is no next page;
 * the settings save the channel and the mail.
 */
const mocks = vi.hoisted(() => ({
  page: vi.fn(),
  sync: vi.fn(),
  visibility: vi.fn(),
  save: vi.fn(),
  importPost: vi.fn(),
  archive: vi.fn(),
  setSetting: vi.fn(),
  setFeature: vi.fn(),
}));
vi.mock('../../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: {
    adminAfisha: mocks.page,
    adminAfishaSync: mocks.sync,
    adminAfishaVisibility: mocks.visibility,
    adminAfishaSave: mocks.save,
    adminAfishaImport: mocks.importPost,
    adminAfishaArchive: mocks.archive,
    adminSetSetting: mocks.setSetting,
    adminSetFeature: mocks.setFeature,
  },
}));

import AdminAfishaPage from '../afisha/page';
import type { AdminAfishaResponse } from '../../../lib/api';

const DRAFT = adminEvent({
  post_id: 1109,
  status: 'draft',
  problem: 'нет даты',
  fields: { ...adminEvent().fields, title: 'Вечерний лес', date: null },
});

const PAGE: AdminAfishaResponse = {
  channel: 'serbia_progulki',
  admin_email: 'geohod@proton.me',
  enabled: false,
  running: false,
  last_run: null,
  last_error: null,
  events: [adminEvent(), DRAFT],
  report: null,
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.page.mockResolvedValue(PAGE);
  mocks.sync.mockResolvedValue({ ...PAGE, report: { read: 20, created: 2, updated: 1, removed: 0, next_before: null } });
  mocks.visibility.mockResolvedValue(PAGE);
  mocks.save.mockResolvedValue(PAGE);
  mocks.setSetting.mockResolvedValue({ key: 'afisha_channel', value: 'serbia_progulki' });
});

const rowOf = async (title: string) =>
  (await screen.findByText(title, { selector: '.aaf-row__title' })).closest('.aaf-row') as HTMLElement;

describe('AdminAfishaPage', () => {
  it('lists announcements with their status, and what a draft lacks', async () => {
    render(<AdminAfishaPage />);
    const published = await rowOf('Врдничка кула');
    expect(within(published).getByText('На сайте')).toBeTruthy();
    expect(within(published).getByText('11.10.2026, 12:45 · Нови Сад')).toBeTruthy();
    const draft = await rowOf('Вечерний лес');
    expect(within(draft).getByText('Не хватает: даты')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Черновик/ }));
    expect(screen.queryByText('Врдничка кула')).toBeNull();
    expect(screen.getByText('Вечерний лес')).toBeTruthy();
  });

  it('reads the channel on demand and reports what changed', async () => {
    render(<AdminAfishaPage />);
    await rowOf('Врдничка кула');
    fireEvent.click(screen.getByRole('button', { name: 'Проверить канал' }));
    expect(await screen.findByText('Прочитано 20 постов: новых 2, обновлено 1, снято 0')).toBeTruthy();
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  });

  it('hides an announcement', async () => {
    render(<AdminAfishaPage />);
    fireEvent.click(within(await rowOf('Врдничка кула')).getByRole('button', { name: 'Скрыть' }));
    await waitFor(() => expect(mocks.visibility).toHaveBeenCalledWith({ post_id: 1110, hidden: true }));
  });

  it('saves the corrected fields', async () => {
    render(<AdminAfishaPage />);
    fireEvent.click(within(await rowOf('Вечерний лес')).getByRole('button', { name: 'Править' }));
    const form = screen.getByRole('form', { name: 'Анонс 1109' });
    fireEvent.change(within(form).getByLabelText('Дата'), { target: { value: '2026-10-10' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const body = mocks.save.mock.calls[0][0];
    expect(body).toMatchObject({ post_id: 1109, kind: 'hiking' });
    expect(body.fields).toMatchObject({ title: 'Вечерний лес', date: '2026-10-10', time: '12:45' });
  });

  it('loads the archive page by page until there is no next page', async () => {
    const report = (created: number, next: number | null) => ({
      ...PAGE,
      report: { read: 20, created, updated: 0, removed: 0, next_before: next },
    });
    mocks.archive.mockResolvedValueOnce(report(20, 1050)).mockResolvedValueOnce(report(5, null));
    render(<AdminAfishaPage />);
    await rowOf('Врдничка кула');
    fireEvent.click(screen.getByRole('button', { name: 'Загрузить архив' }));
    expect(await screen.findByText('Архив загружен: 25 новых анонсов')).toBeTruthy();
    expect(mocks.archive.mock.calls.map((c) => c[0])).toEqual([{ before: null }, { before: 1050 }]);
  });

  it('saves the channel and the mail', async () => {
    render(<AdminAfishaPage />);
    await rowOf('Врдничка кула');
    fireEvent.change(screen.getByLabelText('Канал'), { target: { value: '@serbia_progulki' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Сохранить' })[0]);
    await waitFor(() => expect(mocks.setSetting).toHaveBeenCalledTimes(2));
    expect(mocks.setSetting.mock.calls).toEqual([
      ['afisha_channel', '@serbia_progulki'],
      ['afisha_admin_email', 'geohod@proton.me'],
    ]);
  });
});
