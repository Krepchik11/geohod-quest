/**
 * Pure presentation model behind the profile «Способы входа» card.
 *
 * `methods` is the server's list of WORKING sign-in methods: "email" appears
 * only when a password is actually set; a linked provider appears as
 * "google"/"telegram". `email` is the account's contact address and may exist
 * without a password (Google-attached) — shown as a passwordless email row.
 *
 * `canUnlink` is the SERVER's unlink-guard verdict (`can_unlink` from
 * /api/users/me) — the rule itself lives in one place, backend `auth.rs`; this
 * module only shapes rows and passes the verdict through.
 */
export interface LoginMethodRow {
  method: string;
  /** Email row only: the address exists but no password is set yet. */
  passwordless?: boolean;
}

/**
 * The soft confirm-email banner: only an account that HAS an email can be
 * asked to confirm one. A Telegram-only account carries no address — nothing
 * was mailed, nothing to confirm.
 */
export function needsEmailConfirmation(
  me: { email: string | null; email_confirmed_at?: number | null } | null,
): boolean {
  return !!me?.email && me.email_confirmed_at == null;
}

export function loginMethodModel(
  methods: string[],
  email: string | null,
  canUnlink: boolean,
): { rows: LoginMethodRow[]; linkedSocial: string[]; canUnlinkSocial: boolean } {
  const linkedSocial = methods.filter((m) => m !== 'email');
  const rows: LoginMethodRow[] = linkedSocial.map((method) => ({ method }));
  if (methods.includes('email')) {
    rows.push({ method: 'email', passwordless: false });
  } else if (email) {
    rows.push({ method: 'email', passwordless: true });
  }
  return { rows, linkedSocial, canUnlinkSocial: canUnlink };
}
