/**
 * «Поделиться квестом» — the public link to a quest's product page, plus the
 * one way the app hands it over.
 *
 * Pure except for `shareQuest`, which is the single side-effecting entry point
 * (platform branching only — no DOM access), mirroring the split in
 * `lib/install.ts`. The link is built locally, so every surface works offline.
 *
 * We share a LINK, never access: a grant is idempotent by (user, quest) and
 * non-transferable, so the recipient buys the quest themselves.
 */

/** Dev/test fallback when neither the env var nor a browser origin is available. */
const DEV_ORIGIN = 'http://localhost:3000';

/**
 * The site's own origin, for absolute URLs that leave the app (share links,
 * Open Graph tags).
 *
 * Deliberately softer than `api.ts`'s `resolveApiBase()`, which throws on a
 * production build: a wrong API base breaks everything, while a wrong site
 * origin only costs an ugly preview. Order: the env var, then the live browser
 * origin, then the dev fallback.
 */
export function siteUrl(): string {
  const explicit = typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_SITE_URL : undefined;
  if (explicit) return explicit.replace(/\/+$/, '');
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return DEV_ORIGIN;
}

/**
 * Absolute URL of a quest's product page — what every share surface hands out.
 * Deliberately clean: no referral ids, no UTM. The path matches `aboutUrl` in
 * QuestCard, so a shared link and an in-app click land on the same page.
 */
export function questShareUrl(questId: string): string {
  return `${siteUrl()}/quest/${encodeURIComponent(questId)}/about`;
}

/**
 * The accompanying message, identical on every surface. The city is the one
 * detail worth carrying — it answers "is this near me?" before the link is
 * even opened.
 */
export function shareText(name: string, city?: string | null): string {
  const place = city?.trim();
  return place ? `Городской квест «${name}» в городе ${place}` : `Городской квест «${name}»`;
}

/** What a share attempt ended up doing — returned so callers (and tests) can assert. */
export type ShareOutcome =
  /** The OS share sheet took it. */
  | 'shared'
  /** No share sheet (or it failed); the URL is on the clipboard. */
  | 'copied'
  /** The user dismissed the share sheet — not a failure, and nothing else to do. */
  | 'dismissed'
  /** Neither path was available. */
  | 'failed';

export interface ShareQuestInput {
  questId: string;
  name: string;
  city?: string | null;
}

/**
 * Hand the quest's link to the OS share sheet, falling back to the clipboard.
 *
 * Call it directly from a click handler: `navigator.share` requires transient
 * user activation, which an `await` before it would spend.
 *
 * Only the URL goes to the clipboard — it is pasted into a message the person
 * has already started writing, where our sentence would be in the way.
 */
export async function shareQuest(quest: ShareQuestInput): Promise<ShareOutcome> {
  const url = questShareUrl(quest.questId);
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;

  if (nav?.share) {
    try {
      await nav.share({ title: quest.name, text: shareText(quest.name, quest.city), url });
      return 'shared';
    } catch (err) {
      // A dismissed sheet is an AbortError. It is a decision, not a failure:
      // silently copying behind the user's back would be the wrong answer.
      if (err instanceof Error && err.name === 'AbortError') return 'dismissed';
      // Anything else (no user activation left, unsupported payload) falls
      // through to the clipboard.
    }
  }

  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(url);
      return 'copied';
    } catch {
      // Clipboard denied (insecure origin, permission) — report honestly.
    }
  }

  return 'failed';
}
