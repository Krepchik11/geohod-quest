import { describe, expect, it } from 'vitest';
import { authHref, buyAgainPath, safeNext } from '../auth-return';

describe('auth return (ТЗ, задача 5)', () => {
  it('keeps an in-site path', () => {
    expect(safeNext('/quest/q1/about?buy=1')).toBe('/quest/q1/about?buy=1');
  });

  it('refuses anything that would leave the site', () => {
    for (const raw of [null, '', 'https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      expect(safeNext(raw)).toBe('/');
    }
  });

  it('sends a purchase back to the quest with the sheet reopened', () => {
    expect(buyAgainPath('q 1')).toBe('/quest/q%201/about?buy=1');
    expect(authHref(buyAgainPath('q1'))).toBe('/auth?next=%2Fquest%2Fq1%2Fabout%3Fbuy%3D1');
  });
});
