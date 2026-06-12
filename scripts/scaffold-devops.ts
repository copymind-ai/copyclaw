/**
 * Scaffold the headless `devops` agent group.
 *
 * DevOps owns the local environment lifecycle on the HOST (not in Docker): it
 * brings up the shared DB + web app for a given branch via the `dev` scripts,
 * so verifiers can drive that environment. Its power is fenced by a Bash
 * allowlist (Stage 2) — it can run only `dev`, a few read-only git verbs, and
 * docker/supabase status commands; everything else is blocked by the PreToolUse
 * hook. It holds NO GH_TOKEN and must never push git (that's Fixer's job).
 *
 * Runtime = host so it can reach the host Docker daemon + dev tooling.
 * cwd is pinned to the copymind-app primary worktree so `dev wt up <branch>`
 * runs in place (the script requires being inside an existing worktree, and the
 * allowlist forbids `cd … &&` chaining).
 *
 * Idempotent — re-running overwrites CLAUDE.local.md and the config scalars,
 * and re-wires the fixer↔devops destinations.
 *
 * Usage:
 *   pnpm exec tsx scripts/scaffold-devops.ts
 *
 * Optional env (defaults target the copyclaw-mac layout):
 *   DEVOPS_DEV_SCRIPT     — abs path to dotfiles dev.sh
 *                           (default ~/repositories/dotfiles.git/scripts/dev.sh)
 *   DEVOPS_APP_WORKTREE   — abs path to the copymind-app primary worktree
 *                           (default ~/repositories/copymind-app.git/main)
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  ensureContainerConfig,
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../src/db/container-configs.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import {
  createDestination,
  getDestinationByName,
} from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../src/modules/agent-to-agent/write-destinations.js';
import { findSessionByAgentGroup } from '../src/db/sessions.js';
import type { AgentGroup } from '../src/types.js';

const FOLDER = 'devops';
const NAME = 'DevOps';

const HOME = process.env.HOME || '';
const DEV_SCRIPT =
  process.env.DEVOPS_DEV_SCRIPT || path.join(HOME, 'repositories', 'dotfiles.git', 'scripts', 'dev.sh');
const APP_WORKTREE =
  process.env.DEVOPS_APP_WORKTREE || path.join(HOME, 'repositories', 'copymind-app.git', 'main');

// The copymind-support MCP — devops uses it ONLY to post progress updates to a
// support issue's thread (post_update). OneCLI injects SUPPORT_AGENT_API_KEY by
// host pattern. NOTE: this is the full support MCP, so other tools (post_question,
// mark_status, …) are technically callable — devops must use only post_update
// (enforced by instruction in CLAUDE.local.md, not by tool surface).
const SUPPORT_MCP_NAME = 'copymind-support';
const SUPPORT_MCP_URL =
  process.env.COPYMIND_APP_MCP_URL || 'https://app.copymind.com/api/support/mcp';

// Bash allowlist. The absolute dev.sh path is the workhorse; the git verbs are
// read/checkout only (no push/commit); docker/supabase are status + lifecycle.
// Compound commands (;, &&, |, >, `, $(), &) are always blocked by the hook.
const ALLOWED_PATTERNS = [
  `${DEV_SCRIPT} *`,
  'git fetch*',
  'git checkout*',
  'git switch*',
  'git status*',
  'git pull*',
  'git worktree *',
  'git branch*',
  'git log*',
  'git rev-parse*',
  'git remote*',
  'docker compose *',
  'docker ps*',
  'docker logs*',
  'docker inspect*',
  'supabase *',
];

const CLAUDE_LOCAL = `# DevOps

You are the **environment manager**. You run **on the host machine** (not in a
container) so you can drive the host's Docker daemon, local Supabase, and the
\`dev\` tooling. You bring up local environments for a branch on request, then
report where they are. You do **not** write code, and you **never** push git.

## Your shell is gated (read this)

Every Bash command is screened by an allowlist before it runs. You may run
**only**:
- \`${DEV_SCRIPT} <args>\` — the dev CLI (worktrees, shared supabase, env)
- read-only git: \`git fetch/checkout/switch/status/pull/worktree/branch/log/rev-parse/remote\`
- \`docker compose …\`, \`docker ps/logs/inspect\`
- \`supabase …\`

Anything else is blocked. **Command chaining, piping, redirection, command
substitution, and backgrounding (\`;\`, \`&&\`, \`||\`, \`|\`, \`>\`, \`\\\`\`, \`$(\`, \`&\`)
are always blocked — run one simple command at a time.** Do not try to work
around the gate; if you need something not allowed, report that to \`fixer\`.

Your working directory is the copymind-app primary worktree
(\`${APP_WORKTREE}\`), so \`dev wt up <branch>\` runs in place — you do **not**
\`cd\` (you can't — chaining is blocked).

## How you're triggered

You're woken by messages from the \`fixer\` agent. They arrive as
\`<message from="fixer">…</message>\`. Typical asks:

- **"env up branch=<branch> issue=<id>"** — bring up the app+DB for that branch.
- **"reset"** / **"seed"** — reset or seed the shared local Supabase.
- **"status"** — report what's currently up.

The \`issue=<id>\` field (when present) is the support issue whose Slack thread
you narrate to — see **Progress updates** below. It may be absent (operator/test
runs) — then just skip the thread posts.

## Progress updates (narrate to the thread)

When the message carries \`issue=<id>\`, post **one short line** to that issue's
Slack thread at each significant transition with:

\`mcp__${SUPPORT_MCP_NAME}__post_update(issue_id="<id>", text="<line>")\`

\`post_update\` posts to the thread and changes nothing else. Keep lines short.
No \`issue\` → don't call it. **Use ONLY \`post_update\` from this MCP** — never
\`post_question\`, \`mark_status\`, \`link_pr\`, or any other support tool (those are
the Fixer's; touching them would mutate a customer's ticket).

## Procedure

1. **env up branch=<branch> issue=<id>:**
   - If \`issue\` present: \`post_update(issue, "🖥️ Bringing up a test env for \\\`<branch>\\\`…")\`.
   - Run \`${DEV_SCRIPT} wt up <branch>\` (from your pinned cwd). This fetches
     origin, creates the worktree, allocates a port, builds, and starts the app
     under Docker Compose.
   - Read the script's output for the **allocated port** and any URL it prints.
   - Reply to \`fixer\` with the result: on success,
     \`ready branch=<branch> url=http://host.docker.internal:<port>\` (verifiers
     run in Docker, so give them the \`host.docker.internal\` host, not
     \`localhost\`); on failure, \`failed branch=<branch> reason=<short reason +
     the key error line>\`.
   - If \`issue\` present, also post the outcome:
     \`post_update(issue, "✅ Env up — http://host.docker.internal:<port>")\` or
     \`post_update(issue, "❌ Env-up failed: <short reason>")\`.

2. **reset / seed:** run \`${DEV_SCRIPT} sb reset\` or \`${DEV_SCRIPT} sb seed\`,
   then reply \`done\` or \`failed reason=<…>\`.

3. **status:** run \`docker compose ps\` and/or \`${DEV_SCRIPT} wt info\`, summarize.

## Hard rules

- **Report honestly.** If \`dev wt up\` fails (build error, port exhausted,
  missing registry, auth failure), say so plainly and quote the failing line.
  Never claim an environment is ready when it isn't.
- **Never push git, never open PRs, never commit.** You have no GH_TOKEN. If a
  task implies writing code or git history, refuse and tell \`fixer\` — that's
  Fixer's job.
- **One environment at a time.** Environments serialize per branch; if asked to
  bring up a new branch while another is up, note the currently-up one.
- Always end by sending a reply to \`fixer\` so the flow can continue.
`;

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function wire(fromAgentGroupId: string, localName: string, targetAgentGroupId: string, now: string): boolean {
  if (getDestinationByName(fromAgentGroupId, localName)) return false;
  createDestination({
    agent_group_id: fromAgentGroupId,
    local_name: localName,
    target_type: 'agent',
    target_id: targetAgentGroupId,
    created_at: now,
  });
  // Project into the live session's inbound.db if one exists.
  const sess = findSessionByAgentGroup(fromAgentGroupId);
  if (sess) writeDestinations(fromAgentGroupId, sess.id);
  return true;
}

async function main(): Promise<void> {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);
  const now = new Date().toISOString();

  let ag: AgentGroup | undefined = getAgentGroupByFolder(FOLDER);
  let created = false;
  if (!ag) {
    createAgentGroup({ id: generateId('ag'), name: NAME, folder: FOLDER, agent_provider: null, created_at: now });
    ag = getAgentGroupByFolder(FOLDER)!;
    created = true;
  }

  initGroupFilesystem(ag, { instructions: CLAUDE_LOCAL.trimEnd() });
  fs.writeFileSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.local.md'), CLAUDE_LOCAL);

  ensureContainerConfig(ag.id);
  updateContainerConfigScalars(ag.id, {
    runtime: 'host',
    cli_scope: 'disabled',
    bash_gating_enabled: 1,
    host_cwd: APP_WORKTREE,
  });
  updateContainerConfigJson(ag.id, 'bash_allowed_patterns', ALLOWED_PATTERNS);

  // Wire the narrow progress MCP (post-only) so devops can narrate to the issue
  // thread. Merge into any existing mcp_servers. No headers — OneCLI injects the
  // SUPPORT_PROGRESS_API_KEY bearer by host pattern.
  const existing = getContainerConfig(ag.id);
  const mcpServers: Record<string, unknown> = existing?.mcp_servers
    ? (JSON.parse(existing.mcp_servers) as Record<string, unknown>)
    : {};
  mcpServers[SUPPORT_MCP_NAME] = { type: 'http', url: SUPPORT_MCP_URL };
  updateContainerConfigJson(ag.id, 'mcp_servers', mcpServers);

  // Wire fixer ↔ devops so each can message the other.
  const fixer = getAgentGroupByFolder('fixer');
  let wiredFixerToDevops = false;
  let wiredDevopsToFixer = false;
  if (fixer) {
    wiredFixerToDevops = wire(fixer.id, 'devops', ag.id, now);
    wiredDevopsToFixer = wire(ag.id, 'fixer', fixer.id, now);
  }

  console.log('');
  console.log(`DevOps group ${created ? 'created' : 'already exists'}.`);
  console.log(`  id:        ${ag.id}`);
  console.log(`  folder:    groups/${FOLDER}`);
  console.log(`  runtime:   host`);
  console.log(`  cli_scope: disabled`);
  console.log(`  host_cwd:  ${APP_WORKTREE}${fs.existsSync(APP_WORKTREE) ? '' : '  (MISSING!)'}`);
  console.log(`  mcp:       ${SUPPORT_MCP_NAME} → ${SUPPORT_MCP_URL} (use only post_update)`);
  console.log(`  dev.sh:    ${DEV_SCRIPT}${fs.existsSync(DEV_SCRIPT) ? '' : '  (MISSING!)'}`);
  console.log(`  bash allowlist (${ALLOWED_PATTERNS.length} patterns):`);
  for (const p of ALLOWED_PATTERNS) console.log(`    - ${p}`);
  if (fixer) {
    console.log(`  destinations: fixer→devops ${wiredFixerToDevops ? 'wired' : 'exists'}, devops→fixer ${wiredDevopsToFixer ? 'wired' : 'exists'}`);
  } else {
    console.log('  destinations: fixer group not found — run scaffold-fixer first, then re-run this');
  }
  console.log('');
  console.log('OneCLI side (one-time): onecli agents set-secret-mode --id ' + ag.id + ' --mode all');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
