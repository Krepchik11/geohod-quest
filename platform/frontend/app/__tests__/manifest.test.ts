import { describe, expect, it } from 'vitest';
import manifest from '../manifest';

/**
 * The GLOBAL app manifest: installing the site must open the MAIN page.
 * `id` is frozen to the ORIGINAL implicit identity (the old start_url,
 * /my-quests) so existing installs update in place instead of becoming a
 * "different app"; start_url is free to move.
 */
describe('global manifest', () => {
  it('starts the installed app on the main page, keeping the original identity', () => {
    const m = manifest();
    expect(m.start_url).toBe('/');
    expect(m.id).toBe('/my-quests');
  });
});
