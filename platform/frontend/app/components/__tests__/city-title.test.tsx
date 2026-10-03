// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import CityTitle from '../CityTitle';

/**
 * The shop's title: the city is the switch while there is another city to pick
 * (`store_cities`), plain text otherwise.
 */
const CITIES = [
  { city: 'Нови Сад', count: 3 },
  { city: 'Стамбул', count: 1 },
];

const optionTexts = () =>
  within(screen.getByRole('dialog', { name: 'Выбор города' }))
    .getAllByRole('button')
    .map((b) => b.textContent?.replace(/\s+/g, ' '));

describe('CityTitle', () => {
  it('drops the cities in the given order with their counts, the current one marked', () => {
    render(<CityTitle city="Нови Сад" cities={CITIES} onPick={vi.fn()} />);
    const title = screen.getByRole('heading', { level: 2 });
    expect(title).toHaveTextContent('Квесты в Нови Саде');
    const city = within(title).getByRole('button', { name: 'Нови Саде' });
    expect(city).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(city);
    expect(city).toHaveAttribute('aria-expanded', 'true');
    expect(optionTexts()).toEqual(['Нови Сад 3 квеста', 'Стамбул 1 квест']);
    const current = screen.getByRole('button', { name: /Нови Сад 3/ });
    expect(current).toHaveAttribute('aria-pressed', 'true');
    expect(current).toHaveFocus();
  });

  it('a pick hands the city over, closes the list and returns focus to the title', () => {
    const onPick = vi.fn();
    render(<CityTitle city="Нови Сад" cities={CITIES} onPick={onPick} />);
    const city = screen.getByRole('button', { name: 'Нови Саде' });
    fireEvent.click(city);
    fireEvent.click(screen.getByRole('button', { name: /Стамбул/ }));
    expect(onPick).toHaveBeenCalledWith('Стамбул');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(city).toHaveFocus();
  });

  it('the current city closes the list without a pick', () => {
    const onPick = vi.fn();
    render(<CityTitle city="Нови Сад" cities={CITIES} onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Нови Саде' }));
    fireEvent.click(screen.getByRole('button', { name: /Нови Сад 3/ }));
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape and a click elsewhere close it untouched; arrows walk the list', () => {
    const onPick = vi.fn();
    render(<CityTitle city="Нови Сад" cities={CITIES} onPick={onPick} />);
    const city = screen.getByRole('button', { name: 'Нови Саде' });
    fireEvent.click(city);
    const list = screen.getByRole('dialog');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: /Стамбул/ })).toHaveFocus();
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: /Нови Сад 3/ })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(city).toHaveFocus();

    fireEvent.click(city);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('stays plain text with one city, without the flag or without a city', () => {
    const { rerender } = render(<CityTitle city="Нови Сад" cities={[CITIES[0]]} onPick={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Квесты в Нови Саде');
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<CityTitle city="Нови Сад" cities={null} onPick={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<CityTitle city={null} cities={CITIES} onPick={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Квесты');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
