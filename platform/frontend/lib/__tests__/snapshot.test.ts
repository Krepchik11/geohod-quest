/**
 * lib/snapshot — the ONE owning module for reading a published QuestSnapshot:
 * media walking, product-page chips, start point, step clamping, size stats.
 * chips/startPoint MUST mirror the backend snapshot module (shared goldens
 * in platform/goldens/snapshot/ pin the parity; these tests pin the edges).
 */
import { describe, expect, it } from 'vitest';
import { SKIP_COST_DEFAULT, type QuestSnapshot } from '../shared-model';
import { chips, mediaRefs, mediaStats, skipCost, startPoint, stepAt } from '../snapshot';

const snap = (data: unknown): QuestSnapshot => data as QuestSnapshot;

const MB = 1024 * 1024;

describe('mediaRefs', () => {
  it('walks every media-bearing field in step order', () => {
    const s = snap({
      steps: [
        {
          media: {
            task: 't1', character: 'c1', hint: 'h1', atmosphere: 'a1',
            video: { ref: 'v1' },
          },
          supporting: {
            media_video: 'mv1',
            bonus_animation: { asset_ref: 'ba1', voice_ref: 'bv1' },
          },
        },
      ],
    });
    expect(mediaRefs(s)).toEqual(['t1', 'c1', 'h1', 'a1', 'v1', 'mv1', 'ba1', 'bv1']);
  });

  it('dedups preserving first-seen order and skips null/empty refs', () => {
    const s = snap({
      steps: [
        { media: { task: 'x', character: null, hint: '' } },
        { media: { task: 'y' }, supporting: { media_video: 'x' } },
      ],
    });
    expect(mediaRefs(s)).toEqual(['x', 'y']);
  });

  it('is empty for a snapshot without media', () => {
    expect(mediaRefs(snap({ steps: [{ media: {} }, {}] }))).toEqual([]);
  });
});

describe('chips (mirror of backend snapshot_chips)', () => {
  it('pages = step count, tasks = task templates, paidHints = any non-null hint', () => {
    const s = snap({
      steps: [
        { template: 'start' },
        { template: 'task_no', supporting: { hint: null } },
        { template: 'task_answer', supporting: { hint: { cost_coins: 5 } } },
        { template: 'congrats' },
      ],
    });
    expect(chips(s)).toEqual({ pages: 4, tasks: 2, paidHints: true });
  });

  it('an explicit null hint is not a paid hint', () => {
    const s = snap({ steps: [{ template: 'task_answer', supporting: { hint: null } }] });
    expect(chips(s)).toEqual({ pages: 1, tasks: 1, paidHints: false });
  });
});

describe('startPoint (mirror of backend snapshot_start_point)', () => {
  it('the explicit quest-level start_point wins over navigators', () => {
    const s = snap({
      start_point: { lat: 44.8, lng: 20.4 },
      steps: [{ supporting: { navigator: { lat: 1, lng: 2 } } }],
    });
    expect(startPoint(s)).toEqual({ lat: 44.8, lng: 20.4 });
  });

  it('a PRESENT null start_point hides the point despite navigators (author said none)', () => {
    const s = snap({
      start_point: null,
      steps: [{ supporting: { navigator: { lat: 1, lng: 2 } } }],
    });
    expect(startPoint(s)).toBeNull();
  });

  it('a present-but-malformed start_point yields null, never a guess', () => {
    const s = snap({
      start_point: { lat: '45' },
      steps: [{ supporting: { navigator: { lat: 1, lng: 2 } } }],
    });
    expect(startPoint(s)).toBeNull();
  });

  it('legacy snapshot (key ABSENT) falls back to the first valid step navigator', () => {
    const s = snap({
      steps: [
        { template: 'start' },
        { supporting: { navigator: { lng: 19.8 } } }, // malformed → skipped
        { supporting: { navigator: { lat: 45.25, lng: 19.84 } } },
        { supporting: { navigator: { lat: 1, lng: 2 } } },
      ],
    });
    expect(startPoint(s)).toEqual({ lat: 45.25, lng: 19.84 });
  });

  it('legacy snapshot without any navigator has no point', () => {
    expect(startPoint(snap({ steps: [{ template: 'start' }] }))).toBeNull();
  });
});

describe('skipCost (frontend-only reader)', () => {
  it('reads the frozen price, zero included', () => {
    expect(skipCost(snap({ skip_cost: 3, steps: [] }))).toBe(3);
    expect(skipCost(snap({ skip_cost: 0, steps: [] }))).toBe(0);
    expect(skipCost(snap({ skip_cost: 99, steps: [] }))).toBe(99);
  });

  it('a snapshot older than the field plays at the default price', () => {
    expect(SKIP_COST_DEFAULT).toBe(10);
    expect(skipCost(snap({ steps: [] }))).toBe(SKIP_COST_DEFAULT);
  });

  it('anything but a whole 0…99 is the default, never a guess', () => {
    for (const bad of [-1, 100, 2.5, Number.NaN, '5', null]) {
      expect(skipCost(snap({ skip_cost: bad, steps: [] }))).toBe(SKIP_COST_DEFAULT);
    }
  });
});

describe('stepAt', () => {
  const s = snap({ steps: [{ template: 'start' }, { template: 'continue' }, { template: 'congrats' }] });

  it('returns the step at a valid index', () => {
    expect(stepAt(s, 1).template).toBe('continue');
  });

  it('clamps an overflowing index to the last step', () => {
    expect(stepAt(s, 99).template).toBe('congrats');
  });

  it('clamps a negative index to the first step', () => {
    expect(stepAt(s, -5).template).toBe('start');
  });
});

describe('mediaStats', () => {
  it('counts images and videos across every role — video blocks, media_video, atmosphere', () => {
    const s = snap({
      steps: [
        { media: { task: '/t.jpg', atmosphere: '/a.jpg', video: { ref: '/v.mp4' } } },
        { media: {}, supporting: { media_video: '/mv.mp4' } },
      ],
    });
    const st = mediaStats(s);
    expect(st.images).toBe(2);
    expect(st.videos).toBe(2);
    expect(st.estimatedBytes).toBeCloseTo(2 * 0.15 * MB + 2 * 1.6 * MB, 0);
  });

  it('a video block without a ref still counts as a video (constructor drafts carry none)', () => {
    const s = snap({ steps: [{ media: { video: { duration_label: '2 мин' } } }] });
    const st = mediaStats(s);
    expect(st.videos).toBe(1);
    expect(st.images).toBe(0);
    expect(st.estimatedBytes).toBeCloseTo(1.6 * MB, 0);
  });

  it('measures data: URLs by their base64 length', () => {
    const data = 'data:image/jpeg;base64,' + 'A'.repeat(4 * MB);
    const s = snap({ steps: [{ media: { task: data } }] });
    expect(mediaStats(s).estimatedBytes).toBeCloseTo((data.length * 3) / 4, 0);
  });

  it('bonus animation refs count as images unless the data URL says video', () => {
    const s = snap({
      steps: [{
        supporting: {
          bonus_animation: { asset_ref: 'data:video/mp4;base64,AAAA', voice_ref: '/voice.mp3' },
        },
      }],
    });
    const st = mediaStats(s);
    expect(st.videos).toBe(1);
    expect(st.images).toBe(1);
  });

  it('dedups repeated refs — one cached copy, one count', () => {
    const s = snap({
      steps: [
        { media: { task: '/same.jpg' } },
        { media: { hint: '/same.jpg' } },
      ],
    });
    const st = mediaStats(s);
    expect(st.images).toBe(1);
    expect(st.estimatedBytes).toBeCloseTo(0.15 * MB, 0);
  });

  it('an empty snapshot weighs nothing', () => {
    expect(mediaStats(snap({ steps: [] }))).toEqual({ images: 0, videos: 0, estimatedBytes: 0 });
  });
});
