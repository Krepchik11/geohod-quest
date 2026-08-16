import { describe, expect, it } from 'vitest';
import manifest from '../manifest';

/**
 * The GLOBAL app manifest: installing the site must open the MAIN page.
 * `id` pins the app identity so a later start_url change updates the same
 * installed app instead of minting a new one (without id, identity defaults
 * to start_url).
 */
describe('global manifest', () => {
  it('starts the installed app on the main page with a stable id', () => {
    const m = manifest();
    expect(m.start_url).toBe('/');
    expect(m.id).toBe('/');
    expect(m.display).toBe('standalone');
  });
});
