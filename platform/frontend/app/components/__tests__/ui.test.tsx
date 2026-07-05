// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { Button, Input } from '../ui';

/**
 * §0 design tokens — shared Button/Input primitives (SPEC v2 §0).
 * Variants map 1:1 to the canonical pill classes in globals.css; sizes map to
 * the 52/48/44 control heights. The component NEVER invents styles — it only
 * composes token classes, so these tests pin the class contract.
 */
describe('Button', () => {
  it('renders a primary pill by default', () => {
    render(<Button>Купить</Button>);
    const btn = screen.getByRole('button', { name: 'Купить' });
    expect(btn.className).toContain('btn');
    expect(btn.className).not.toContain('btn--');
  });

  it('maps variants to canonical classes', () => {
    const { rerender } = render(<Button variant="secondary">x</Button>);
    expect(screen.getByRole('button').className).toContain('btn--secondary');
    rerender(<Button variant="quiet">x</Button>);
    expect(screen.getByRole('button').className).toContain('btn--quiet');
    rerender(<Button variant="destructive">x</Button>);
    expect(screen.getByRole('button').className).toContain('btn--danger');
  });

  it('maps sizes to 48/44 modifier classes (52 is the default)', () => {
    const { rerender } = render(<Button size="md">x</Button>);
    expect(screen.getByRole('button').className).toContain('btn--md');
    rerender(<Button size="sm">x</Button>);
    expect(screen.getByRole('button').className).toContain('btn--sm');
  });

  it('renders an anchor when href is given (link styled as button)', () => {
    render(<Button href="/quest/1">Пройти</Button>);
    const a = screen.getByRole('link', { name: 'Пройти' });
    expect(a.getAttribute('href')).toBe('/quest/1');
    expect(a.className).toContain('btn');
  });

  it('defaults type="button" so forms are not submitted accidentally', () => {
    render(<Button>x</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });

  it('merges a caller className', () => {
    render(<Button className="btn--block">x</Button>);
    expect(screen.getByRole('button').className).toContain('btn--block');
  });
});

describe('Input', () => {
  it('renders the canonical .input control', () => {
    render(<Input aria-label="Почта" />);
    expect(screen.getByLabelText('Почта').className).toContain('input');
  });

  it('adds the error modifier', () => {
    render(<Input aria-label="Пароль" error />);
    expect(screen.getByLabelText('Пароль').className).toContain('input--error');
  });
});
