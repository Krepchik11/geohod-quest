// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * Admin · Города. Pinned behaviors: the list shows each city's counters and
 * slogan and hints a merge for a look-alike spelling; saving sends the whole
 * form; a rename onto a listed city (409) asks before merging and then
 * re-sends with `merge: true`; a city with quests cannot be deleted, an empty
 * one is deleted after a confirm; a new city is added from the head button.
 */
const { listMock, createMock, saveMock, deleteMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  createMock: vi.fn(),
  saveMock: vi.fn(),
  deleteMock: vi.fn(),
}));
vi.mock('../../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: {
    adminListCities: listMock,
    adminCreateCity: createMock,
    adminSaveCity: saveMock,
    adminDeleteCity: deleteMock,
    uploadMedia: vi.fn(),
  },
}));

import AdminCitiesPage from '../cities/page';
import { ApiError, type AdminCityWire } from '../../../lib/api';

const city = (name: string, over: Partial<AdminCityWire> = {}): AdminCityWire => ({
  name,
  image: null,
  slogan: null,
  quests: 0,
  in_store: 0,
  ...over,
});

const LIST = [
  city('Нови Сад', { quests: 5, in_store: 4, slogan: 'Город у Дуная', image: 'https://api/media/ns' }),
  city('Белград', { quests: 1, in_store: 1 }),
  city('Нови-Сад', { quests: 1, in_store: 1 }),
  city('Москва'),
];

beforeEach(() => {
  for (const m of [listMock, createMock, saveMock, deleteMock]) m.mockReset();
  listMock.mockResolvedValue(LIST);
  createMock.mockResolvedValue(LIST);
  saveMock.mockResolvedValue(LIST);
  deleteMock.mockResolvedValue(LIST);
});

/** The list row (or the open form) of one city. */
async function rowOf(name: string): Promise<HTMLElement> {
  const label = await screen.findByText(name, { selector: '.acity-row__name, .acity-form__title' });
  return label.closest('.acity-row, .acity-form') as HTMLElement;
}

describe('AdminCitiesPage', () => {
  it('lists cities with counters, slogans and a merge hint for a look-alike', async () => {
    render(<AdminCitiesPage />);
    const novi = await rowOf('Нови Сад');
    expect(within(novi).getByText('5 квестов · 4 в магазине')).toBeTruthy();
    expect(within(novi).getByText('Город у Дуная')).toBeTruthy();
    expect(within(await rowOf('Москва')).getByText('Нет квестов')).toBeTruthy();
    expect(within(await rowOf('Белград')).getByText('Без слогана')).toBeTruthy();
    expect(within(await rowOf('Нови-Сад')).getByText(/Похоже на «Нови Сад»/)).toBeTruthy();
    expect(within(novi).queryByText(/Похоже на/)).toBeNull();
  });

  it('saves the edited slogan with the rest of the form', async () => {
    render(<AdminCitiesPage />);
    fireEvent.click(within(await rowOf('Белград')).getByRole('button', { name: 'Изменить' }));
    const form = await rowOf('Белград');
    fireEvent.change(within(form).getByLabelText('Слоган'), { target: { value: 'Белый город' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({
        name: 'Белград',
        new_name: 'Белград',
        image: null,
        slogan: 'Белый город',
        merge: false,
      }),
    );
  });

  it('asks before a rename onto a listed city, then merges', async () => {
    saveMock.mockRejectedValueOnce(
      new ApiError(409, '/api/admin/cities/save', '{"error":"город «Нови Сад» уже есть в списке"}'),
    );
    render(<AdminCitiesPage />);
    fireEvent.click(within(await rowOf('Нови-Сад')).getByRole('button', { name: 'Изменить' }));
    const form = await rowOf('Нови-Сад');
    fireEvent.change(within(form).getByLabelText('Название'), { target: { value: ' Нови  Сад ' } });
    expect(within(form).getByText(/Город поменяется в 1 квесте/)).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Сохранить' }));

    const sheet = await screen.findByRole('dialog', { name: 'Объединить города' });
    expect(within(sheet).getByText(/Квесты города «Нови-Сад» перейдут в «Нови Сад»/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Объединить' }));
    await waitFor(() =>
      expect(saveMock).toHaveBeenLastCalledWith({
        name: 'Нови-Сад',
        new_name: 'Нови Сад',
        image: null,
        slogan: '',
        merge: true,
      }),
    );
  });

  it('merges straight from the look-alike hint', async () => {
    render(<AdminCitiesPage />);
    fireEvent.click(within(await rowOf('Нови-Сад')).getByRole('button', { name: 'Объединить' }));
    const sheet = await screen.findByRole('dialog', { name: 'Объединить города' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Объединить' }));
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Нови-Сад', new_name: 'Нови Сад', merge: true }),
      ),
    );
  });

  it('refuses to delete a city with quests and deletes an empty one after a confirm', async () => {
    render(<AdminCitiesPage />);
    fireEvent.click(within(await rowOf('Белград')).getByRole('button', { name: 'Изменить' }));
    let form = await rowOf('Белград');
    expect((within(form).getByRole('button', { name: 'Удалить город' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(form).getByText(/Удалить нельзя: в городе 1 квест/)).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Отмена' }));

    fireEvent.click(within(await rowOf('Москва')).getByRole('button', { name: 'Изменить' }));
    form = await rowOf('Москва');
    fireEvent.click(within(form).getByRole('button', { name: 'Удалить город' }));
    const sheet = await screen.findByRole('dialog', { name: 'Удалить город' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith({ name: 'Москва' }));
  });

  it('adds a new city from the head button', async () => {
    render(<AdminCitiesPage />);
    await rowOf('Москва');
    fireEvent.click(screen.getByRole('button', { name: 'Добавить город' }));
    const form = screen.getByRole('form', { name: 'Новый город' });
    fireEvent.change(within(form).getByLabelText('Название'), { target: { value: 'Стамбул' } });
    fireEvent.change(within(form).getByLabelText('Слоган'), { target: { value: 'Два континента' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({ name: 'Стамбул', image: null, slogan: 'Два континента' }),
    );
  });

  it('shows the server reason when a save is refused', async () => {
    createMock.mockRejectedValueOnce(
      new ApiError(409, '/api/admin/cities', '{"error":"город «Москва» уже есть в списке"}'),
    );
    render(<AdminCitiesPage />);
    await rowOf('Москва');
    fireEvent.click(screen.getByRole('button', { name: 'Добавить город' }));
    const form = screen.getByRole('form', { name: 'Новый город' });
    fireEvent.change(within(form).getByLabelText('Название'), { target: { value: 'Москва' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('город «Москва» уже есть в списке')).toBeTruthy();
  });
});
