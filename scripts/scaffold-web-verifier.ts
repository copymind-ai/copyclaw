/**
 * Scaffold the headless `web-verifier` agent group.
 *
 * A verification-ONLY agent: given a running branch environment (brought up by
 * `devops`), it drives the web app with agent-browser, reproduces a bug before
 * and after the fix, captures screenshots + DB state, and reports a verdict +
 * artifacts back to `fixer`. It runs in Docker (agent-browser is baked into the
 * image), holds NO GH_TOKEN, and must never clone/commit/push.
 *
 * It already receives, like every docker agent, $SUPPORT_PG_URL (prod, RO),
 * $LOCAL_DEV_PG_URL (local, RW) and $LOCAL_DEV_APP_URL from the host — so it can
 * seed repro state and read back what the app wrote. The branch env URL itself
 * comes in the verify message from fixer (host.docker.internal:<port>).
 *
 * Idempotent. Run scaffold-fixer first so the destinations can be wired.
 *
 * Usage:
 *   pnpm exec tsx scripts/scaffold-web-verifier.ts
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

const FOLDER = 'web-verifier';
const NAME = 'WebVerifier';

// Narrow, post-only support surface — gives the verifier only the post_update
// tool (not the full support MCP). OneCLI injects SUPPORT_AGENT_API_KEY (reused)
// by host pattern.
const PROGRESS_MCP_NAME = 'copymind-progress';
const PROGRESS_MCP_URL =
  process.env.COPYMIND_PROGRESS_MCP_URL || 'https://app.copymind.com/api/support/progress/mcp';

const CLAUDE_LOCAL = `# WebVerifier

You are a **verification-only** agent. Given a running web environment, you
reproduce a bug **before and after** a fix, capture proof, and report a verdict.
You **never** clone, edit, commit, or push code — that is Fixer's job, and you
hold no GH_TOKEN. You do not touch production.

## How you're triggered

A message from \`fixer\`:

<message from="fixer">
verify branch=<branch> env=<url> login=<email>/<password> seeded_user_id=<id> issue=<id> repro=<exact steps> expected=<before vs after>
</message>

\`env\` is a branch environment \`devops\` brought up, reachable at a
\`http://host.docker.internal:<port>\` URL. **Never** point your browser at prod
(\`app.copymind.com\`). \`login\` is a **local** test user that Fixer already seeded
for you — you log in with it; you do **not** create or seed users yourself.
\`issue=<id>\` (when present) is the support issue whose Slack thread you narrate
to — see **Progress updates**. It may be absent (operator/test runs) — then skip
the thread posts.

## Tools

- **agent-browser** — headless Chrome. Drive the \`env\` URL: log in with the
  \`login\` creds Fixer gave you, click through the repro flow, take screenshots.
  Save each screenshot to a file in your workspace so you can attach it.
- **psql** — \`$LOCAL_DEV_PG_URL\` (the local/branch Postgres). Use it to **read
  back** what the app wrote for the seeded \`seeded_user_id\` (the rows that prove
  the fix). Local only — never connect to prod.
- **\`mcp__${PROGRESS_MCP_NAME}__post_update(issue_id, text)\`** — post **one short
  line** to the issue's Slack thread (narration only; changes nothing else).
  Your only support tool. No \`issue\` → don't call it.

## Progress updates (narrate to the thread)

When the request carries \`issue=<id>\`, bracket your work with two posts:
- at the **start**: \`post_update(issue, "🔬 Verifying \\\`<branch>\\\`…")\`
- at the **end**, your verdict: \`post_update(issue, "🟢 Verified")\` /
  \`post_update(issue, "🔴 Not verified: <short reason>")\` /
  \`post_update(issue, "🟡 Couldn't reproduce the original bug")\`.

## Procedure

1. Parse the request: branch, env URL, \`login\` creds, \`seeded_user_id\`,
   \`issue\`, repro steps, expected. If \`issue\` present:
   \`post_update(issue, "🔬 Verifying \\\`<branch>\\\`…")\`.
2. **Log in** with the \`login\` creds Fixer gave you at the \`env\` URL. Fixer has
   already seeded the user's state from prod — you do **not** seed and you do
   **not** touch prod. **Never drive the welcome-quiz onboarding UI** to create a
   user. (If Fixer sent no \`login\`, the repro isn't user-specific — proceed with
   the steps as given; if it clearly needs a user and none was provided, reply
   asking Fixer to seed one rather than making your own.)
3. **Capture proof.** Drive the repro flow with agent-browser and record the
   relevant state both ways:
   - the **fixed** behavior on this branch env (screenshots + the DB rows the
     app wrote for \`seeded_user_id\`, read via psql), against the **expected**
     change fixer described.
   - where it helps, contrast with the **before** (buggy) behavior.
4. **Decide a verdict** (be strict — fixer marks the PR "verified" only on yours):
   - \`verified\` — expected behavior present / bug gone, with proof.
   - \`not_verified\` — fix is deployed but the bug persists, or a new problem.
   - \`not_reproduced\` — couldn't reproduce the original bug at all.
5. **Report to fixer.** For each artifact:
   \`send_file("fixer", "<path>", "<filename>", "<one-line caption>")\`. Then:
   \`send_message("fixer", "verdict=<verified|not_verified|not_reproduced> branch=<branch> notes=<concise: what you did, what you saw, file names>")\`.
   If \`issue\` present, also \`post_update(issue, "<🟢/🔴/🟡 verdict line>")\` to the thread.

## Hard rules

- **Verify-only.** Never clone/edit/commit/push; no git writes. If a task implies
  changing code, refuse and tell \`fixer\`.
- **Never touch prod, never seed.** Browser + psql target the local/branch env
  only. Seeding prod data is Fixer's job exclusively — you log in with the local
  creds Fixer hands you. Never connect to prod, never run a seed tool, never
  drive onboarding to create a user.
- **Report honestly.** Quote what you actually observed. Don't claim
  \`verified\` unless the proof shows it. Always end by sending fixer a verdict
  plus the artifacts.
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
  // Docker runtime (default), no ncl, no GH_TOKEN (forward_gh_token stays 0).
  updateContainerConfigScalars(ag.id, { runtime: 'docker', cli_scope: 'disabled' });

  // psql for seeding/inspecting the local/branch DB. agent-browser is already
  // in the base image. Merge into any existing apt list.
  const existing = getContainerConfig(ag.id);
  const apt: string[] = existing?.packages_apt ? (JSON.parse(existing.packages_apt) as string[]) : [];
  const aptChanged = !apt.includes('postgresql-client');
  if (aptChanged) updateContainerConfigJson(ag.id, 'packages_apt', [...apt, 'postgresql-client']);

  // Wire the narrow progress MCP (post-only) so the verifier can narrate to the
  // issue thread. Merge into any existing mcp_servers. No headers — OneCLI
  // injects the SUPPORT_PROGRESS_API_KEY bearer by host pattern.
  const mcpServers: Record<string, unknown> = existing?.mcp_servers
    ? (JSON.parse(existing.mcp_servers) as Record<string, unknown>)
    : {};
  mcpServers[PROGRESS_MCP_NAME] = { type: 'http', url: PROGRESS_MCP_URL };
  updateContainerConfigJson(ag.id, 'mcp_servers', mcpServers);

  // Note: the web-verifier does NOT get the seed tool or the full support MCP —
  // seeding from prod is Fixer's exclusive job, and it gets only the post-only
  // progress surface. It logs in with the local creds Fixer hands it.

  const fixer = getAgentGroupByFolder('fixer');
  let wiredFixerToVerifier = false;
  let wiredVerifierToFixer = false;
  if (fixer) {
    wiredFixerToVerifier = wire(fixer.id, 'web-verifier', ag.id, now);
    wiredVerifierToFixer = wire(ag.id, 'fixer', fixer.id, now);
  }

  console.log('');
  console.log(`WebVerifier group ${created ? 'created' : 'already exists'}.`);
  console.log(`  id:        ${ag.id}`);
  console.log(`  folder:    groups/${FOLDER}`);
  console.log(`  runtime:   docker`);
  console.log(`  cli_scope: disabled`);
  console.log(`  GH_TOKEN:  not forwarded (verify-only)`);
  console.log(`  mcp:       ${PROGRESS_MCP_NAME} → ${PROGRESS_MCP_URL} (post-only)`);
  console.log(`  packages_apt.postgresql-client → ${aptChanged ? 'added (image rebuild required)' : 'already present'}`);
  if (fixer) {
    console.log(`  destinations: fixer→web-verifier ${wiredFixerToVerifier ? 'wired' : 'exists'}, web-verifier→fixer ${wiredVerifierToFixer ? 'wired' : 'exists'}`);
  } else {
    console.log('  destinations: fixer group not found — run scaffold-fixer first, then re-run this');
  }
  console.log('');
  console.log('OneCLI side (one-time): onecli agents set-secret-mode --id ' + ag.id + ' --mode all');
  console.log('Image rebuild (if apt changed): ncl groups restart --id ' + ag.id + ' --rebuild');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
