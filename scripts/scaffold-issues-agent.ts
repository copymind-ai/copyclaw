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

You have two resources:

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

## Procedure

On every wake event:

1. Extract \`issue_id\` from the \`<webhook>\` payload.
2. **Acknowledge immediately.** Call \`mcp__copymind-support__post_question\`
   with \`issue_id\` and the exact text \`Let's roll!\`. Do this **before**
   any other tool call so the user sees the bot is alive even if a later
   step fails.
3. Call \`mcp__copymind-support__list_pending_mentions\` and find the entry
   for this \`issue_id\`. Note \`issue_title\`, \`issue_body\`, and any other
   context fields.
4. If the question touches code (almost always — these come from an
   engineering team's support channel), **search the codebase**:
   - \`Grep\` \`/workspace/extra/copymind-app/src\` for the symbols, route
     paths, table names, or error strings mentioned.
   - \`Read\` the most relevant 1–3 files (handlers, services, types).
   - Trace the code path far enough to answer confidently.
5. Call \`mcp__copymind-support__post_question\` again with \`issue_id\` and a
   substantive reply. Cite file paths (e.g. \`src/lib/services/foo.ts:42\`)
   when they help. Keep it concise — Slack thread reply, not a blog post.
   If the question is genuinely about runtime state/data rather than code,
   say so and ask for the relevant id/timestamp.
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

  console.log('');
  console.log(`Issues-agent group ${created ? 'created' : 'already exists'}.`);
  console.log(`  id:     ${ag.id}`);
  console.log(`  folder: groups/${FOLDER}`);
  console.log(`  CLAUDE.local.md → rewritten (${CLAUDE_LOCAL.length} chars)`);
  console.log(`  mcp_servers.${MCP_SERVER_NAME} → ${mcpUrl}`);
  console.log(`  additional_mounts.copymind-app → ${repoPath} (ro)`);
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
