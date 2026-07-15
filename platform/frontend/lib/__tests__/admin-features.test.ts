import { describe, expect, it } from 'vitest';
import {
  availabilityNote,
  stateLabel,
  toAdminFeature,
  type AdminFeatureWire,
} from '../admin-features';

const wire = (over: Partial<AdminFeatureWire> = {}): AdminFeatureWire => ({
  key: 'payments_mock',
  default_enabled: true,
  override: null,
  effective: true,
  available: true,
  ...over,
});

describe('toAdminFeature', () => {
  it('maps known keys to Russian labels', () => {
    const f = toAdminFeature(wire());
    expect(f.label).toBe('Тестовая оплата');
    expect(f.description).not.toBe('');
    expect(f.effective).toBe(true);
    expect(f.override).toBeNull();
  });

  it('falls back to the raw key for a flag the client does not know yet', () => {
    const f = toAdminFeature(wire({ key: 'quests_ai_hints' }));
    expect(f.label).toBe('quests_ai_hints');
    expect(f.description).toBe('');
  });
});

describe('stateLabel', () => {
  it('reports the code default when no override is stored', () => {
    expect(stateLabel(toAdminFeature(wire()))).toBe('по умолчанию · вкл');
    expect(
      stateLabel(toAdminFeature(wire({ default_enabled: false, effective: false }))),
    ).toBe('по умолчанию · выкл');
  });

  it('reports an admin override when one is stored', () => {
    expect(stateLabel(toAdminFeature(wire({ override: false, effective: false })))).toBe(
      'переопределено · выкл',
    );
    expect(stateLabel(toAdminFeature(wire({ override: true, effective: true })))).toBe(
      'переопределено · вкл',
    );
  });
});

describe('availabilityNote', () => {
  it('is silent for a configured feature and warns for an unconfigured one', () => {
    expect(availabilityNote(toAdminFeature(wire()))).toBeNull();
    expect(availabilityNote(toAdminFeature(wire({ available: false })))).toMatch(/Не настроено/);
  });
});
