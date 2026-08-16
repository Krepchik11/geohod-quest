import { describe, expect, it } from 'vitest';
import { loginMethodModel } from '../../../lib/login-methods';

describe('loginMethodModel', () => {
  it('registered email account: one email row, password set', () => {
    const m = loginMethodModel(['email'], 'u@example.com', false);
    expect(m.rows).toEqual([{ method: 'email', passwordless: false }]);
    expect(m.canUnlinkSocial).toBe(false);
    expect(m.linkedSocial).toEqual([]);
  });

  it('google account with contact email but no password: email row is passwordless', () => {
    // The server still allows unlinking google (reachable via email reset) and
    // says so via can_unlink — the model passes that verdict through.
    const m = loginMethodModel(['google'], 'g@x.io', true);
    expect(m.rows).toEqual([
      { method: 'google' },
      { method: 'email', passwordless: true },
    ]);
    expect(m.canUnlinkSocial).toBe(true);
    expect(m.linkedSocial).toEqual(['google']);
  });

  it('telegram-only account: single method row, no email row', () => {
    const m = loginMethodModel(['telegram'], null, false);
    expect(m.rows).toEqual([{ method: 'telegram' }]);
    expect(m.canUnlinkSocial).toBe(false);
  });

  it('email + telegram: social row listed apart from the email row', () => {
    const m = loginMethodModel(['email', 'telegram'], 'u@example.com', true);
    expect(m.linkedSocial).toEqual(['telegram']);
    expect(m.rows).toEqual([
      { method: 'telegram' },
      { method: 'email', passwordless: false },
    ]);
  });

  it('email present but not a method (no password, e.g. after unlinking google): passwordless row', () => {
    const m = loginMethodModel([], 'u@example.com', false);
    expect(m.rows).toEqual([{ method: 'email', passwordless: true }]);
    expect(m.canUnlinkSocial).toBe(false);
  });
});
