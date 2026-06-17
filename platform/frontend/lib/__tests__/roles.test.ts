/**
 * Role capability predicates (admin-roles): the single rule for which roles may
 * author quests (/quest-editor) vs. manage users (/admin). Drives the nav + route
 * guards; the backend enforces independently.
 */
import { describe, expect, it } from 'vitest';
import { canEditQuests, isAdmin } from '../roles';

describe('canEditQuests', () => {
  it('grants editor and admin (admin ⊃ editor)', () => {
    expect(canEditQuests('editor')).toBe(true);
    expect(canEditQuests('admin')).toBe(true);
  });

  it('denies player and any unknown / missing role', () => {
    expect(canEditQuests('player')).toBe(false);
    expect(canEditQuests('superuser')).toBe(false);
    expect(canEditQuests('')).toBe(false);
    expect(canEditQuests(null)).toBe(false);
    expect(canEditQuests(undefined)).toBe(false);
  });

  it('is case-sensitive (mirrors the backend role constants)', () => {
    expect(canEditQuests('Editor')).toBe(false);
    expect(canEditQuests('ADMIN')).toBe(false);
  });
});

describe('isAdmin', () => {
  it('grants only admin', () => {
    expect(isAdmin('admin')).toBe(true);
    expect(isAdmin('editor')).toBe(false);
    expect(isAdmin('player')).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });
});
