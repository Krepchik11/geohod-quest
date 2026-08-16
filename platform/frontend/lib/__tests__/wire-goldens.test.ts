// @vitest-environment node
/**
 * Shared wire goldens (platform/goldens/wire/) — the SAME files the Rust suite
 * runs (auth.rs, facts.rs, features.rs tests). A one-sided rule change breaks
 * one of the two suites instead of production (issue #66).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emailValid, normalizeEmail, passwordValid } from '../credentials';
import { factNaturalKey } from '../queue';
import type { Fact } from '../shared-model';
import { FEATURE_KEYS } from '../admin-features';
import { CLIENT_FEATURE_KEYS } from '../client-features';

const wire = (name: string, sections: string[]) => {
  const fx = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../goldens/wire', name), 'utf8'),
  ) as Record<string, unknown>;
  // A new fixture section must be wired here AND in the Rust reader.
  expect(Object.keys(fx).sort()).toEqual(['description', 'name', ...sections].sort());
  return fx;
};

describe('credentials golden (shared with cargo test)', () => {
  it('normalize + validate agree with the server byte for byte', () => {
    const fx = wire('credentials.json', ['emails', 'passwords']) as {
      emails: Array<{ raw: string; normalized: string; valid: boolean }>;
      passwords: Array<{ password: string; valid: boolean }>;
    };
    expect(fx.emails.length).toBeGreaterThan(0);
    expect(fx.passwords.length).toBeGreaterThan(0);
    for (const c of fx.emails) {
      const normalized = normalizeEmail(c.raw);
      expect(normalized, `normalize(${JSON.stringify(c.raw)})`).toBe(c.normalized);
      expect(emailValid(normalized), `email verdict for ${JSON.stringify(c.raw)}`).toBe(c.valid);
    }
    for (const c of fx.passwords) {
      expect(passwordValid(c.password), `password verdict for ${JSON.stringify(c.password)}`).toBe(c.valid);
    }
  });
});

describe('natural-key golden (shared with cargo test)', () => {
  it('factNaturalKey is byte-identical to the backend serialization', () => {
    const fx = wire('natural-key.json', ['cases']) as { cases: Array<{ fact: Fact; key: string }> };
    expect(fx.cases.length).toBeGreaterThan(0);
    for (const c of fx.cases) {
      expect(factNaturalKey(c.fact), c.fact.type).toBe(c.key);
    }
  });
});

describe('features-registry golden (shared with cargo test)', () => {
  const fx = wire('features-registry.json', ['keys', 'client_visible']) as { keys: string[]; client_visible: string[] };

  it('admin META covers exactly the registry', () => {
    expect([...FEATURE_KEYS]).toEqual(fx.keys);
  });

  it('the client-visible union covers exactly the served flags', () => {
    expect([...CLIENT_FEATURE_KEYS]).toEqual(fx.client_visible);
  });
});
