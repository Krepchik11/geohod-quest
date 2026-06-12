/**
 * Cross-language parity: fold every shared fixture from platform/goldens/parity/
 * and assert the expected projections. The Rust suite runs the SAME files —
 * any one-sided drift in the folds breaks one of the two suites (spec: parity-goldens).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectBalance, projectState, type Fact } from '../shared-model';

interface ParityFixture {
  name: string;
  description: string;
  facts: Fact[];
  expected: { balance: number; completed_steps: number[]; revealed_hints: number[] };
}

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../goldens/parity');
const fixtures: ParityFixture[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(fixturesDir, f), 'utf8')));

describe('parity goldens (shared with cargo test)', () => {
  it('found the shared fixture set', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
  });

  it.each(fixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    expect(projectBalance(fixture.facts)).toBe(fixture.expected.balance);
    const state = projectState(fixture.facts);
    expect(state.balance).toBe(fixture.expected.balance);
    expect(state.completedSteps).toEqual(fixture.expected.completed_steps);
    expect(state.revealedHints).toEqual(fixture.expected.revealed_hints);
  });
});
