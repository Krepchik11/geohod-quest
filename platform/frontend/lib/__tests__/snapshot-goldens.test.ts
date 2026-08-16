/**
 * Shared snapshot goldens: every fixture in platform/goldens/snapshot/ is read
 * by BOTH suites — this one asserts mediaRefs/chips/startPoint/theme, the backend
 * snapshot module asserts chips/start_point/theme on the SAME files. One-sided drift
 * in the snapshot readers breaks one of the two suites (issue #64).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { QuestSnapshot } from '../shared-model';
import { chips, mediaRefs, startPoint, theme } from '../snapshot';

interface SnapshotFixture {
  name: string;
  description: string;
  snapshot: QuestSnapshot;
  expected: {
    media_refs: string[];
    pages: number;
    tasks: number;
    paid_hints: boolean;
    start_point: { lat: number; lng: number } | null;
    theme: { bg: string; ink: string; btn: string } | null;
  };
}

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../goldens/snapshot');
const fixtures: SnapshotFixture[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(fixturesDir, f), 'utf8')));

describe('snapshot goldens (shared with cargo test)', () => {
  it('found the shared fixture set', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(2);
  });

  it.each(fixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    expect(mediaRefs(fixture.snapshot)).toEqual(fixture.expected.media_refs);
    const c = chips(fixture.snapshot);
    expect(c.pages).toBe(fixture.expected.pages);
    expect(c.tasks).toBe(fixture.expected.tasks);
    expect(c.paidHints).toBe(fixture.expected.paid_hints);
    expect(startPoint(fixture.snapshot)).toEqual(fixture.expected.start_point);
    expect(theme(fixture.snapshot)).toEqual(fixture.expected.theme);
  });
});
