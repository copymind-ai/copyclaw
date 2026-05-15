/**
 * Scaffold the headless `bug-triage` agent group.
 *
 * Used by Phase B.2.2: creates the agent_groups row + container_configs row
 * + groups/bug-triage/CLAUDE.local.md with a minimal acknowledgement-only
 * procedure. No chat channel is wired — this group is triggered exclusively
 * by the wake-receiver (POST /wake/<agent_group_id>).
 *
 * Idempotent — re-running prints the existing group's id.
 *
 * After running, paste the printed id into copymind-app's COPYCLAW_AGENT_ID
 * env var. The wake-receiver looks the group up on every POST.
 *
 * Usage:
 *   pnpm exec tsx scripts/scaffold-bug-triage-group.ts
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup } from '../src/types.js';

const FOLDER = 'bug-triage';
const NAME = 'Bug Triage';

const CLAUDE_LOCAL = `# Bug Triage

You are a bug-triage agent for the support-issue pipeline. You do **not** receive
chat messages. You're woken by a wake event when a new support mention lands in
copymind-app's DB.

Your inbound message will be a \`system\` message whose \`content\` (JSON string)
has shape: \`{"kind":"wake","issue_id":"<uuid>","mention_id":"<uuid|null>"}\`.

For this initial deployment, your only job is:
1. Log the wake payload (issue_id, mention_id) — print it as plain text.
2. Exit.

You do **not** yet have access to the support MCP or Slack MCP. A future
revision of this CLAUDE.local.md will give you tools and a real triage
procedure.
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

  // Writes groups/bug-triage/CLAUDE.local.md (only on first init) and
  // ensures the container_configs row exists with defaults.
  initGroupFilesystem(ag, { instructions: CLAUDE_LOCAL.trimEnd() });

  console.log('');
  console.log(`Bug-triage group ${created ? 'created' : 'already exists'}.`);
  console.log(`  id:     ${ag.id}`);
  console.log(`  folder: groups/${FOLDER}`);
  console.log('');
  console.log('Set this on copymind-app:');
  console.log(`  COPYCLAW_AGENT_ID=${ag.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
