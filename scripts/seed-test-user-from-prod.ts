/**
 * Reproduce a prod user's state in the local dev DB under a fresh throwaway user.
 *
 * Reads the prod user's per-user rows (every public BASE TABLE that has a
 * `user_id` column) via the read-only role on $SUPPORT_PG_URL, mints a brand
 * new local auth user, and overlays the prod rows onto it (user_id rewritten)
 * in the local Supabase DB at $LOCAL_DEV_PG_URL.
 *
 * Prod is only ever READ (the role is read-only). All writes go to local.
 *
 * Usage:
 *   pnpm exec tsx scripts/seed-test-user-from-prod.ts <prod-user-uuid> [--dry-run]
 *
 * Output (last stdout line is JSON, so callers can parse it):
 *   {"email":"…","password":"test","user_id":"…","tables_overlaid":[…],"tables_skipped":[…]}
 *
 * Env:
 *   SUPPORT_PG_URL   read-only prod Postgres (support_agent_readonly)
 *   LOCAL_DEV_PG_URL local Supabase Postgres (superuser; needs auth.* write)
 *
 * Design notes:
 *   - No `pg` dependency — drives the `psql` client (present in agent images).
 *   - Connections are passed to psql via PG* env vars, never as a URL argv, so
 *     the password never appears in `ps` output or in error messages.
 *   - Throwaway user's password is always `test` (reuses the dev seed's bcrypt
 *     hash, so no runtime bcrypt needed).
 *   - Each table is overlaid best-effort in its own transaction with
 *     session_replication_role=replica (FK/trigger order is irrelevant).
 *     Prod/local schema drift (a missing table or unknown enum value) skips
 *     that one table and is reported in `tables_skipped` — never fatal.
 */
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

// bcrypt hash of "test" — lifted verbatim from copymind-app/supabase/seeds/users.sql
const TEST_PASSWORD = 'test';
const TEST_PWD_HASH = '$2a$10$n.I6pqV3pe13cdVPpbX49OIH5LruBVDATqRLxJtymWO10W98rNJtS';

function die(msg: string): never {
  console.error(`[seed] ${msg}`);
  process.exit(1);
}

/** Parse a postgres URL into PG* env vars so no secret ever lands in argv. */
function connEnv(url: string): Record<string, string> {
  const u = new URL(url);
  const env: Record<string, string> = {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, '') || 'postgres',
  };
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

/** Redact any stray password/URL before logging (defense in depth). */
function redact(text: string, secrets: string[]): string {
  let out = text.replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://***@');
  for (const s of secrets) {
    if (s) out = out.split(s).join('***');
  }
  return out;
}

type PgResult = { ok: true; stdout: string } | { ok: false; stderr: string };

function psql(env: Record<string, string>, args: string[]): PgResult {
  try {
    const stdout = execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (err: unknown) {
    // err.stderr holds psql's own error (the ERROR: line, no connection info);
    // never surface err.message (it contains the full argv).
    const e = err as { stderr?: string };
    return { ok: false, stderr: (e.stderr ?? 'psql failed').toString().trim() };
  }
}

function dq(): string {
  return `$seed_${randomUUID().slice(0, 8)}$`;
}

/** Pull the meaningful `ERROR:`/`DETAIL:` line out of psql stderr for a skip reason. */
function errLine(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim());
  return lines.find((l) => l.startsWith('ERROR:')) || lines.find(Boolean) || 'failed';
}

function main(): void {
  const prodUserId = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');

  if (!prodUserId || !/^[0-9a-f-]{36}$/i.test(prodUserId)) {
    die('usage: seed-test-user-from-prod.ts <prod-user-uuid> [--dry-run]');
  }
  if (!process.env.SUPPORT_PG_URL) die('SUPPORT_PG_URL is not set');
  if (!process.env.LOCAL_DEV_PG_URL) die('LOCAL_DEV_PG_URL is not set');

  const prod = connEnv(process.env.SUPPORT_PG_URL);
  const local = connEnv(process.env.LOCAL_DEV_PG_URL);
  const secrets = [prod.PGPASSWORD, local.PGPASSWORD];

  const newUserId = randomUUID();
  const email = `repro-${newUserId.slice(0, 8)}@copymind.me`;

  // 1. Per-user tables present in the LOCAL schema (the write target is authoritative).
  const tablesRes = psql(local, [
    '-tAc',
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.column_name = 'user_id'
      ORDER BY c.table_name`,
  ]);
  if (!tablesRes.ok) die(`could not introspect local schema: ${redact(tablesRes.stderr, secrets)}`);
  const candidateTables = tablesRes.stdout ? tablesRes.stdout.split('\n').filter(Boolean) : [];

  const overlaid: string[] = [];
  const skipped: { table: string; reason: string }[] = [];

  // 2. Mint the local auth user first (must succeed) — synthetic row mirroring
  //    the dev seed (no admin perms). Skipped on dry-run.
  const identityId = randomUUID();
  const mintSql = `
BEGIN;
SET session_replication_role = replica;
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at, last_sign_in_at,
  is_super_admin, is_sso_user, is_anonymous,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  phone_change, phone_change_token, email_change_token_current, reauthentication_token,
  email_change_confirm_status
) VALUES (
  '00000000-0000-0000-0000-000000000000', '${newUserId}', 'authenticated', 'authenticated',
  '${email}', '${TEST_PWD_HASH}', now(),
  '{"provider":"email","providers":["email"]}', '{"email_verified":true}', now(), now(), now(),
  null, false, false, '', '', '', '', '', '', '', '', 0
) ON CONFLICT (id) DO NOTHING;
INSERT INTO auth.identities (
  provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at, id
) VALUES (
  '${newUserId}', '${newUserId}',
  '{"sub":"${newUserId}","email":"${email}","email_verified":true,"phone_verified":false}',
  'email', now(), now(), now(), '${identityId}'
) ON CONFLICT DO NOTHING;
COMMIT;`;

  if (!dryRun) {
    const mint = psql(local, ['-c', mintSql]);
    if (!mint.ok) die(`failed to mint local auth user: ${redact(mint.stderr, secrets)}`);
  }

  // 3. Per-table overlay, best-effort. Read prod rows as jsonb (user_id
  //    rewritten), write to local in an isolated transaction.
  for (const table of candidateTables) {
    const read = psql(prod, [
      '-tAc',
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) || jsonb_build_object('user_id','${newUserId}')), '[]')
         FROM public."${table}" t WHERE t.user_id = '${prodUserId}'`,
    ]);
    if (!read.ok) {
      skipped.push({ table, reason: `prod read: ${errLine(redact(read.stderr, secrets))}` });
      continue;
    }
    if (!read.stdout || read.stdout === '[]') continue; // no rows for this user

    if (dryRun) {
      overlaid.push(table);
      continue;
    }

    const tag = dq();
    const writeSql = `BEGIN; SET session_replication_role = replica;
INSERT INTO public."${table}" SELECT * FROM jsonb_populate_recordset(NULL::public."${table}", ${tag}${read.stdout}${tag});
COMMIT;`;
    const write = psql(local, ['-c', writeSql]);
    if (!write.ok) {
      skipped.push({ table, reason: `local write: ${errLine(redact(write.stderr, secrets))}` });
      continue;
    }
    overlaid.push(table);
  }

  console.error(
    `[seed] ${dryRun ? 'DRY RUN — ' : ''}${email} (${newUserId}); overlaid ${overlaid.length}, skipped ${skipped.length}`,
  );
  if (skipped.length) {
    for (const s of skipped) console.error(`  skip ${s.table}: ${s.reason}`);
  }
  console.log(
    JSON.stringify({
      email,
      password: TEST_PASSWORD,
      user_id: newUserId,
      tables_overlaid: overlaid,
      tables_skipped: skipped.map((s) => s.table),
      ...(dryRun ? { dry_run: true } : {}),
    }),
  );
}

main();
