/**
 * LOAD (CLI): emit generated/load.sql (idempotent upsert) + generated/rollback.sql.
 *
 *   npm run load
 *   docker exec -i geohod-postgres psql -U geohod -d geohod < generated/load.sql   # local
 *   psql "$PROD_DATABASE_URL" -f generated/load.sql                                # prod
 *
 * Authors -> users (role=editor, login-disabled). Quests -> constructor_quests
 * (status=draft). quest_id/player_id are bubble-derived so re-runs upsert.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { GEN, GEN_DIR, USER_ID_PREFIX, runAsMain } from './config.ts';
import { buildAllBodies } from './bodies.ts';
import { readRaw } from './io.ts';
import { authorEmail, authorName, userId } from './authors.ts';
import type { BubbleUser } from './types.ts';

/** Disabled credential: not a valid argon2 PHC string, so verify always fails. */
const DISABLED_HASH = '!disabled:bubble-import';
const IMPORT_EPOCH = 1719000000; // fixed fallback so the SQL is stable across regenerations

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
const epoch = (iso: string | undefined): number =>
  iso && Number.isFinite(Date.parse(iso)) ? Math.floor(Date.parse(iso) / 1000) : IMPORT_EPOCH;

async function main(): Promise<void> {
  const { authors } = readRaw();
  const built = buildAllBodies();
  const authorById = new Map(authors.map((u) => [u._id, u]));

  // ---- users (deduped by bubble author id) ----
  const userRows = authors.map((u) => {
    const { email } = authorEmail(u);
    return `  (${[
      sqlStr(userId(u._id)),
      sqlStr(email),
      sqlStr(DISABLED_HASH),
      sqlStr(authorName(u)),
      `'editor'`,
      String(epoch(u['Created Date'])),
    ].join(', ')})`;
  });

  // ---- quests ----
  const questRows = built.map(({ quest, body }) => {
    const creator = quest.creatorUser;
    if (!creator || !authorById.has(creator)) throw new Error(`quest ${quest._id} has no resolvable creatorUser`);
    const name = authorName(authorById.get(creator)!);
    const cols = [
      sqlStr(body.id),
      sqlStr(userId(creator)),
      sqlStr(name),
      sqlStr(body.meta.title),
      `'draft'`,
      body.meta.cover ? sqlStr(body.meta.cover) : 'NULL',
      String(body.steps.length),
      `$qbody$${JSON.stringify(body)}$qbody$::jsonb`,
      String(epoch(quest['Created Date'])),
      String(epoch(quest['Modified Date'])),
    ];
    return `  (${cols.join(', ')})`;
  });

  const loadSql = `-- bubble-import: ${userRows.length} editors + ${questRows.length} draft quests.
-- Idempotent: re-running upserts (quest_id/player_id are bubble-derived). Atomic.
BEGIN;

INSERT INTO users (player_id, email, password_hash, display_name, role, created_at) VALUES
${userRows.join(',\n')}
ON CONFLICT (player_id) DO UPDATE SET
  email = EXCLUDED.email, display_name = EXCLUDED.display_name, role = EXCLUDED.role;

INSERT INTO constructor_quests
  (quest_id, author_id, author_name, name, status, cover, steps_count, body, created_at, updated_at) VALUES
${questRows.join(',\n')}
ON CONFLICT (quest_id) DO UPDATE SET
  author_id = EXCLUDED.author_id, author_name = EXCLUDED.author_name, name = EXCLUDED.name,
  status = EXCLUDED.status, cover = EXCLUDED.cover, steps_count = EXCLUDED.steps_count,
  body = EXCLUDED.body, updated_at = EXCLUDED.updated_at;

COMMIT;
`;

  const rollbackSql = `-- bubble-import rollback: remove every imported draft + editor account.
BEGIN;
DELETE FROM constructor_quests WHERE quest_id LIKE 'bubble-%';
DELETE FROM users WHERE player_id LIKE '${USER_ID_PREFIX}%';
COMMIT;
`;

  await mkdir(GEN_DIR, { recursive: true });
  await writeFile(GEN.load, loadSql, 'utf8');
  await writeFile(GEN.rollback, rollbackSql, 'utf8');
  console.log(`wrote ${GEN.load} (${(loadSql.length / 1024 / 1024).toFixed(1)} MB) and rollback.sql`);
  console.log(`  ${userRows.length} users, ${questRows.length} quests`);
}

runAsMain(import.meta.url, main);
