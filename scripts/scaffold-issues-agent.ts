/**
 * Scaffold the headless `issues-agent` agent group.
 *
 * Creates the agent_groups row, ensures container_configs has the
 * copymind-app support MCP wired in, and (re)writes
 * groups/issues-agent/CLAUDE.local.md with the bidirectional-smoke procedure.
 * No chat channel is wired — this group is triggered exclusively by the
 * wake-receiver (POST /wake/<agent_group_id>).
 *
 * Idempotent — re-running merges the support MCP into mcp_servers (preserving
 * any other entries) and overwrites CLAUDE.local.md (the file is template-
 * managed, not user prose). Prints the agent id.
 *
 * After running, paste the printed id into copymind-app's COPYCLAW_AGENT_ID
 * env var. The wake-receiver looks the group up on every POST.
 *
 * Usage:
 *   pnpm exec tsx scripts/scaffold-issues-agent.ts
 *
 * Optional env:
 *   COPYMIND_APP_MCP_URL  — override the support MCP URL (defaults to
 *                          https://app.copymind.com/api/support/streamable-http).
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import type { AdditionalMountConfig } from '../src/container-config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  getContainerConfig,
  updateContainerConfigJson,
} from '../src/db/container-configs.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup } from '../src/types.js';

const FOLDER = 'issues-agent';
const NAME = 'Issues Agent';
const MCP_SERVER_NAME = 'copymind-support';
// mcp-handler's streamable endpoint defaults to `<basePath>/mcp`. The
// copymind-app route is configured with basePath="/api/support", so the
// streamable transport lives at /api/support/mcp.
const DEFAULT_MCP_URL = 'https://app.copymind.com/api/support/mcp';

const CLAUDE_LOCAL = `# Issues Agent

## Hard rule (read this first — it overrides your judgment)

**Every wake MUST result in at least one \`mcp__copymind-support__post_question\`
call BEFORE \`mcp__copymind-support__mark_mentions_processed\`.** No exceptions.

copymind-app posts a server-side *"Let's roll!"* ack to the thread the moment
the wake fires (you don't need to do that yourself). Your job is the
**substantive reply** that follows.

Even if:
- The issue's status is \`closed\` or \`resolved\`
- The question seems casual, off-topic, or non-technical
- You already replied to similar mentions in this thread before
- You think a reply "adds no value"

→ **Post a reply anyway.** The user mentioned the bot. The bot replies. A
silent bot after the "Let's roll!" ack feels broken — that's the worst
outcome. Do not use judgment to skip the reply step.

**Run, don't dump.** When the answer requires data, EXECUTE \`psql\` yourself
and post the RESULT. Never paste a raw SQL query into the thread and tell
the reporter to run it — you have \`$SUPPORT_PG_URL\` and a Bash tool for
exactly that reason. The reporter is not your operator.

## What you are

You handle support issues forwarded from Slack via copymind-app. You do **not**
receive chat messages directly. You're woken by a wake webhook when a new
support mention lands in copymind-app's DB.

Each wake arrives as:

<webhook source="copymind-app" event="support_mention">
{
  "issue_id": "<uuid>",
  "mention_id": "<uuid|null>"
}
</webhook>

You have three resources:

1. **\`copymind-support\` MCP server** (HTTP transport, authenticated by the
   OneCLI gateway):
   - \`mcp__copymind-support__list_pending_mentions\` — fetch your queue.
   - \`mcp__copymind-support__post_question(issue_id, text)\` — reply in the
     issue's Slack thread.
   - \`mcp__copymind-support__mark_mentions_processed(issue_id)\` — ack the
     work so you don't see the same mention twice.

2. **copymind-app source** at \`/workspace/extra/copymind-app\` (read-only,
   pulled to remote HEAD on every wake). Use \`Grep\` and \`Read\` on this
   path to investigate routes, services, schemas, and types whenever a
   question touches the codebase.

3. **Read-only Postgres access** to the copymind-app production DB via your
   Bash tool. The connection string lives in \`$SUPPORT_PG_URL\`:

   \`\`\`bash
   psql "$SUPPORT_PG_URL" -c "SELECT id, status FROM public.support_issues WHERE id = '...';"
   psql "$SUPPORT_PG_URL" -c "\\d public.profile_info"   # introspect a table
   \`\`\`

   You're authenticated as \`support_agent_readonly\`, which has \`SELECT\` on
   every \`public.*\` table (existing and future), \`default_transaction_read_only = on\`,
   \`statement_timeout = '30s'\`, and \`BYPASSRLS\` so you can see any user's
   rows without impersonation. Writes return an error — don't try them.

   \`auth.*\` is **not accessible** (Supabase locks it down). Use public
   tables instead: \`profile_info\`, \`user_full_billing_info\`,
   \`user_therapy_sessions\`, \`user_activities\`, \`user_settings\`, etc.
   When the question is about a specific user, session, or payment,
   prefer the DB over guessing from the code.

## Procedure

On every wake event:

1. Extract \`issue_id\` from the \`<webhook>\` payload.

2. Call \`mcp__copymind-support__list_pending_mentions\` and find the entry
   for this \`issue_id\`. Note \`issue_title\`, \`issue_body\`, and any other
   context fields.

3. **Pull user context proactively.** Almost every support question touches
   a specific user — even when the reporter doesn't say "this user". Before
   you reason or grep code, identify the user(s) and pull their state:

   - Scan \`issue_title\`, \`issue_body\`, and the latest mention for any
     identifier — email, user_id, name, Slack handle, anything.
   - With an identifier, run psql to gather their state. Reasonable first
     pass (adapt to the question):

     \`\`\`bash
     psql "$SUPPORT_PG_URL" -c "SELECT * FROM public.profile_info WHERE id = '<user-id>' OR email = '<email>' LIMIT 1;"
     psql "$SUPPORT_PG_URL" -c "SELECT * FROM public.user_full_billing_info WHERE user_id = '<user-id>';"
     psql "$SUPPORT_PG_URL" -c "SELECT * FROM public.user_therapy_sessions WHERE user_id = '<user-id>' ORDER BY created_at DESC LIMIT 5;"
     psql "$SUPPORT_PG_URL" -c "SELECT * FROM public.user_onboardings WHERE user_id = '<user-id>';"
     \`\`\`

   - No identifier and the question is user-specific → reply via
     \`post_question\` asking for the user id/email. Don't guess.
   - Question genuinely isn't about a user (e.g. "how does feature X
     work?") → skip this step, go to code search.

4. **Code search** (when the question touches the implementation):
   - \`Grep\` \`/workspace/extra/copymind-app/src\` for the symbols, route
     paths, table names, or error strings mentioned.
   - \`Read\` the most relevant 1–3 files (handlers, services, types).
   - Combine with the DB state from step 3 — code shows the contract, the
     row shows what actually happened to this user.

5. **Mandatory.** Call \`mcp__copymind-support__post_question\` with the
   substantive reply containing the **answer** — concrete numbers, dates,
   statuses, file paths. NEVER paste a raw SQL query as your reply (see
   "Run, don't dump" in the Hard rule). Cite file paths
   (e.g. \`src/lib/services/foo.ts:42\`) when they help. Keep it concise —
   Slack thread reply, not a blog post.

   If the question is genuinely casual / off-topic / already-answered, your
   reply is something like *"Already answered above — [one-line restatement]"*
   or *"Casual mention noted; no engineering action needed."* You still
   post it. See "Hard rule" at the top.

6. Call \`mcp__copymind-support__mark_mentions_processed\` with \`issue_id\`.

**Do not** modify, build, or run anything in \`/workspace/extra/copymind-app\`.
It is read-only and exists solely as a knowledge base.
`;

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const now = new Date().toISOString();

  let ag: AgentGroup | undefined = getAgentGroupByFolder(FOLDER);
  let created = false;
  if (!ag) {
    const id = generateId('ag');
    createAgentGroup({
      id,
      name: NAME,
      folder: FOLDER,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(FOLDER)!;
    created = true;
  }

  // Ensure the group's filesystem + container_configs row exist (idempotent).
  initGroupFilesystem(ag, { instructions: CLAUDE_LOCAL.trimEnd() });

  // CLAUDE.local.md is a template, not user prose — force-overwrite on every
  // run so the procedure stays in sync with this script's text.
  const claudeLocalPath = path.join(GROUPS_DIR, ag.folder, 'CLAUDE.local.md');
  fs.writeFileSync(claudeLocalPath, CLAUDE_LOCAL);

  // Merge the support MCP into mcp_servers (preserves any other entries).
  const existing = getContainerConfig(ag.id);
  const currentMcpServers: Record<string, unknown> = existing?.mcp_servers
    ? (JSON.parse(existing.mcp_servers) as Record<string, unknown>)
    : {};
  const mcpUrl = process.env.COPYMIND_APP_MCP_URL || DEFAULT_MCP_URL;
  // No `headers` field on purpose. OneCLI's gateway injects the Authorization
  // header from the vault based on host-pattern match (app.copymind.com →
  // Bearer <SUPPORT_AGENT_API_KEY>). If we set headers here, OneCLI treats
  // them as already-present and refuses to override, so the literal
  // placeholder gets sent and copymind-app responds 401.
  const supportMcp = {
    type: 'http' as const,
    url: mcpUrl,
  };
  const updatedMcpServers = { ...currentMcpServers, [MCP_SERVER_NAME]: supportMcp };
  updateContainerConfigJson(ag.id, 'mcp_servers', updatedMcpServers);

  // Mount the copymind-app source at /workspace/extra/copymind-app (read-only).
  // The wake-receiver pulls this to remote HEAD on every wake event so the
  // agent always greps current code. Path on droplet must be allowlisted in
  // ~/.config/nanoclaw/mount-allowlist.json or container spawn will fail.
  const home = process.env.HOME || '';
  const repoPath =
    process.env.COPYMIND_APP_REPO_PATH || path.join(home, 'repositories', 'copymind-app');
  const desiredMount: AdditionalMountConfig = {
    hostPath: repoPath,
    containerPath: 'copymind-app',
    readonly: true,
  };
  const currentMounts: AdditionalMountConfig[] = existing?.additional_mounts
    ? (JSON.parse(existing.additional_mounts) as AdditionalMountConfig[])
    : [];
  const filteredMounts = currentMounts.filter((m) => m.hostPath !== desiredMount.hostPath);
  const updatedMounts = [...filteredMounts, desiredMount];
  updateContainerConfigJson(ag.id, 'additional_mounts', updatedMounts);

  // psql client for the read-only Postgres role. Installed at image build
  // time via packages_apt; the URL is assembled host-side in container-runner
  // and forwarded into the container as SUPPORT_PG_URL.
  const currentApt: string[] = existing?.packages_apt
    ? (JSON.parse(existing.packages_apt) as string[])
    : [];
  const desiredApt = 'postgresql-client';
  const aptChanged = !currentApt.includes(desiredApt);
  if (aptChanged) {
    updateContainerConfigJson(ag.id, 'packages_apt', [...currentApt, desiredApt]);
  }

  console.log('');
  console.log(`Issues-agent group ${created ? 'created' : 'already exists'}.`);
  console.log(`  id:     ${ag.id}`);
  console.log(`  folder: groups/${FOLDER}`);
  console.log(`  CLAUDE.local.md → rewritten (${CLAUDE_LOCAL.length} chars)`);
  console.log(`  mcp_servers.${MCP_SERVER_NAME} → ${mcpUrl}`);
  console.log(`  additional_mounts.copymind-app → ${repoPath} (ro)`);
  console.log(
    `  packages_apt.postgresql-client → ${aptChanged ? 'added (rebuild required)' : 'already present'}`,
  );
  console.log('');
  console.log('Set this on copymind-app:');
  console.log(`  COPYCLAW_AGENT_ID=${ag.id}`);
  console.log('');
  console.log('OneCLI side (one-time):');
  console.log(`  onecli agents set-secret-mode --id ${ag.id} --mode all`);
  console.log('  (or grant SUPPORT_AGENT_API_KEY explicitly via the OneCLI UI)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
