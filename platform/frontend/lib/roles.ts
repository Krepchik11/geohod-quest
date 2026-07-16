/**
 * Access roles & capabilities (admin-roles). One source of truth for "what may
 * this role do", shared by the nav (SiteHeader) and the route guards so the rule
 * lives in exactly one place.
 *
 * Capability ladder — admin ⊃ editor ⊃ player:
 *   • player — plays quests, buys/owns them, sees their own profile & quests;
 *   • editor — everything a player can, PLUS authoring (the /quest-editor surface
 *     and publishing quests);
 *   • admin  — everything, including user-role management (/admin).
 *
 * These predicates only drive what the UI offers. The backend is the real
 * enforcer: every gated endpoint re-checks the session's role (require_editor for
 * publish, require_admin_actor for user management), so a briefly-stale client
 * role can never grant real access — at worst it shows a link whose action 403s.
 */

export type Role = 'admin' | 'editor' | 'player';

/** Can author quests — open the constructor (/quest-editor) and publish. Editor or admin. */
export function canEditQuests(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'editor';
}

/** Can manage users / reach the admin surface (/admin). Admin only. */
export function isAdmin(role: string | null | undefined): boolean {
  return role === 'admin';
}

/** Human (Russian) word for a role — the profile menu's subtitle. */
export function roleWord(role: string | null | undefined): string {
  if (role === 'admin') return 'администратор';
  if (role === 'editor') return 'редактор';
  return 'игрок';
}
