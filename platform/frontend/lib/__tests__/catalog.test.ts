/**
 * Post-finale catalog selection: pick the next quests to invite the player into,
 * excluding the one just completed. Pure + order-preserving (spec: the redesign's
 * «Продолжите путешествие» screen).
 */
import { describe, expect, it } from 'vitest';
import { nextQuestsForCatalog } from '../catalog';
import type { PublishedQuestWire } from '../api';

const wire = (
  quest_id: string,
  name: string,
  primary_comic: string | null = null,
): PublishedQuestWire => ({
  quest_id,
  name,
  primary_comic,
  template_summary: '',
  snapshot_version: 1,
  snapshot_id: `${quest_id}-v1`,
  city: null,
  duration: null,
  price: null,
  rating_avg: 0,
  rating_count: 0,
});

describe('nextQuestsForCatalog (post-finale catalog selection)', () => {
  const published = [
    wire('amber', 'Янтарный код', '/c/amber.png'),
    wire('forts', 'Кольцо фортов'),
    wire('current', 'Тайны Старого города'),
  ];

  it('excludes the just-finished quest', () => {
    expect(nextQuestsForCatalog(published, 'current').map((c) => c.id)).toEqual(['amber', 'forts']);
  });

  it('maps title, cover, and an uppercased monogram from the name', () => {
    const [amber, forts] = nextQuestsForCatalog(published, 'current');
    expect(amber).toEqual({ id: 'amber', title: 'Янтарный код', mark: 'Я', cover: '/c/amber.png' });
    expect(forts.cover).toBeNull();
    expect(forts.mark).toBe('К');
  });

  it('preserves server order and tolerates an empty / no-match list', () => {
    expect(nextQuestsForCatalog([], 'current')).toEqual([]);
    expect(nextQuestsForCatalog(published, 'zzz').map((c) => c.id)).toEqual([
      'amber',
      'forts',
      'current',
    ]);
  });

  it('falls back to "?" for a blank name', () => {
    expect(nextQuestsForCatalog([wire('x', '   ')], 'current')[0].mark).toBe('?');
  });

  it('blanks a non-URL id-token cover so the card draws its monogram, not a broken <img>', () => {
    const [c] = nextQuestsForCatalog([wire('t', 'Тест', 'comic-fortress')], 'current');
    expect(c.cover).toBeNull();
  });
});
