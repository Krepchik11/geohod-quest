/**
 * The ONE owning module for reading a published QuestSnapshot (issue #64).
 *
 * Every consumer that walks the frozen snapshot — offline media precache,
 * publish-time size estimate, the player's step access, the store's chips and
 * start point — derives from here, so a new media role or snapshot field is
 * added in exactly one place. `chips`, `startPoint` and `theme` MUST mirror the backend
 * `snapshot` module; the shared goldens in platform/goldens/snapshot/ pin the
 * parity from both suites.
 *
 * Pure and total: no IO, no view/draft types — only the snapshot wire types.
 */
import type { GameStep, QuestSnapshot } from './shared-model';
import { parseTheme, type QuestTheme } from './quest-theme';

export interface SnapshotChips {
  pages: number;
  tasks: number;
  paidHints: boolean;
}

export interface StartPoint {
  lat: number;
  lng: number;
}

export interface MediaStats {
  images: number;
  videos: number;
  estimatedBytes: number;
}

type MediaKind = 'image' | 'video';

/** One media occurrence in the snapshot. `ref` is null only for a video block
 *  that carries no source (constructor drafts freeze duration/caption only). */
interface MediaEntry {
  ref: string | null;
  kind: MediaKind;
}

/** Video weight when the ref cannot be measured (external URL or absent). */
const VIDEO_FALLBACK_BYTES = 1.6 * 1024 * 1024;
/** Image weight for external refs: the upload pipeline caps images at ~100 KB,
 *  so 0.15 MB is an honest ceiling (data: URLs are measured, not estimated). */
const IMAGE_FALLBACK_BYTES = 0.15 * 1024 * 1024;

/** Bonus animation assets are images unless the inline data URL says video. */
const bonusKind = (ref: string): MediaKind =>
  ref.startsWith('data:video/') ? 'video' : 'image';

/**
 * Every media occurrence of one step, in field order. This is the single list
 * of media-bearing snapshot fields — mediaRefs and mediaStats both fold it.
 */
function mediaEntries(step: GameStep): MediaEntry[] {
  const out: MediaEntry[] = [];
  const image = (ref?: string | null) => {
    if (ref) out.push({ ref, kind: 'image' });
  };
  const m = step.media;
  image(m?.task);
  image(m?.character);
  image(m?.hint);
  image(m?.atmosphere);
  if (m?.video) out.push({ ref: m.video.ref || null, kind: 'video' });
  const sup = step.supporting;
  if (sup?.media_video) out.push({ ref: sup.media_video, kind: 'video' });
  const bonus = sup?.bonus_animation;
  if (bonus?.asset_ref) out.push({ ref: bonus.asset_ref, kind: bonusKind(bonus.asset_ref) });
  if (bonus?.voice_ref) out.push({ ref: bonus.voice_ref, kind: bonusKind(bonus.voice_ref) });
  return out;
}

/**
 * Every media ref the snapshot carries — image roles, video, inline
 * media_video, bonus animation + voice — deduped preserving first-seen order.
 * Nothing the player can render is missing from this list.
 */
export function mediaRefs(snapshot: QuestSnapshot): string[] {
  const refs = new Set<string>();
  for (const step of snapshot.steps) {
    for (const e of mediaEntries(step)) {
      if (e.ref) refs.add(e.ref);
    }
  }
  return [...refs];
}

/**
 * Content chips for the product page: page count, task count (task_no /
 * task_answer templates), whether any step sells a paid hint. Mirrors the
 * backend `snapshot::snapshot_chips` (shared goldens enforce).
 */
export function chips(snapshot: QuestSnapshot): SnapshotChips {
  const steps = snapshot.steps;
  return {
    pages: steps.length,
    tasks: steps.filter((s) => s.template === 'task_no' || s.template === 'task_answer').length,
    paidHints: steps.some((s) => s.supporting?.hint != null),
  };
}

/** `{ lat, lng }` out of an untrusted value; null for any other shape. */
function pointOf(v: unknown): StartPoint | null {
  if (typeof v !== 'object' || v === null) return null;
  const { lat, lng } = v as { lat?: unknown; lng?: unknown };
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return null;
  if (typeof lng !== 'number' || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/**
 * The quest's start point («Место старта»). PRESENCE of the `start_point` key
 * — not its value — decides who answers, since the constructor always writes
 * it: present ⇒ the author's word is final (null/malformed = no point); absent
 * ⇒ pre-field snapshot, and the first valid step navigator stands in. Mirrors
 * the backend `snapshot::snapshot_start_point` (shared goldens enforce).
 */
export function startPoint(snapshot: QuestSnapshot): StartPoint | null {
  if ('start_point' in snapshot) return pointOf(snapshot.start_point);
  for (const step of snapshot.steps) {
    const p = pointOf(step.supporting?.navigator);
    if (p) return p;
  }
  return null;
}

/**
 * The quest's own colours, frozen at publish. Absent, null or malformed all mean
 * the same thing: the quest plays in the default palette. Mirrors the backend
 * `snapshot::snapshot_theme` (shared goldens enforce).
 */
export function theme(snapshot: QuestSnapshot): QuestTheme | null {
  return parseTheme(snapshot.theme);
}

/** The step at `idx`, index clamped to [0, steps.length - 1]. */
export function stepAt(snapshot: QuestSnapshot, idx: number): GameStep {
  const steps = snapshot.steps;
  return steps[Math.min(Math.max(idx, 0), steps.length - 1)];
}

/** data: URLs are measured by their base64 payload; anything else falls back. */
const refBytes = (ref: string, fallback: number): number =>
  ref.startsWith('data:') ? (ref.length * 3) / 4 : fallback;

/**
 * Honest size/count stats over EVERY media occurrence — videos, atmosphere and
 * bonus animations included, so the author's «размер квеста» stops lying
 * (issue #64). Repeated refs are one cached copy, so they count once; a video
 * block without a ref still weighs a video.
 */
export function mediaStats(snapshot: QuestSnapshot): MediaStats {
  const seen = new Set<string>();
  let images = 0;
  let videos = 0;
  let estimatedBytes = 0;
  for (const step of snapshot.steps) {
    for (const e of mediaEntries(step)) {
      if (e.ref) {
        if (seen.has(e.ref)) continue;
        seen.add(e.ref);
      }
      if (e.kind === 'video') {
        videos += 1;
        estimatedBytes += e.ref ? refBytes(e.ref, VIDEO_FALLBACK_BYTES) : VIDEO_FALLBACK_BYTES;
      } else if (e.ref) {
        images += 1;
        estimatedBytes += refBytes(e.ref, IMAGE_FALLBACK_BYTES);
      }
    }
  }
  return { images, videos, estimatedBytes };
}
