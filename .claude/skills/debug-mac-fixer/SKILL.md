---
name: debug-mac-fixer
description: >-
  Debug and verify the Mac-mini-hosted "Fixer" support agent (NanoClaw v2 /
  copyclaw). Use when checking what Fixer did with a Slack support ticket, why
  it didn't reply or didn't open a PR, inspecting its container / logs / session
  DBs, triggering a wake, reading the support MCP or prod DB it queries, reading
  the Slack thread it posts to, or verifying its reproduce→diagnose→fix→PR
  output. Triggers: "what did Fixer do", "check the mac-mini agent", "why didn't
  the bot respond", "debug Fixer", "verify the fixer".
---

# Debugging & verifying the Mac-mini Fixer agent

Fixer is a NanoClaw v2 agent group running on a Mac mini, reached over SSH. It is
woken by Slack support mentions (forwarded from copymind-app's support system),
reads the ticket, reproduces the reporter's state against the prod DB, diagnoses,
and — on an explicit fix request — edits code, pushes a branch, and opens a PR.
Everything below is how to observe and verify that, from this Claude Code session.

> **Scope:** the Mac-hosted Fixer *operational* playbook. Generic NanoClaw
> container mechanics — auth / API-key errors, the `/workspace` mount layout,
> env-var passing, session resumption, image rebuilds, and the manual `docker run`
> test harness — live in the `debug` skill and are **not** repeated here. The one
> Fixer quirk to keep front-of-mind: its *replies to Slack* go out via the
> `copymind-support` MCP, **not** the session DBs, so an empty `messages_out` does
> NOT mean Fixer was silent (see Gotchas).

## Connection & identity facts

| Thing | Value |
|---|---|
| SSH alias | `copyclaw-mac` (cloudflared access ssh; user `andriiyarmak`) |
| Docker binary on Mac | `/Applications/Docker.app/Contents/Resources/bin/docker` (NOT on default PATH) |
| copyclaw checkout | `~/repositories/copyclaw.git/agents/fixer` (bare-clone + worktree) |
| Node | v22 via nvm — `source ~/.nvm/nvm.sh; nvm use 22` (better-sqlite3 won't build on 26) |
| launchd service | `com.nanoclaw-v2-32a5669a` |
| Fixer agent_group id | `ag-1780561376088-ntblrb` |
| Fixer session dir | `data/v2-sessions/ag-1780561376088-ntblrb/sess-1780561449056-n97lcs` |
| Container name pattern | `nanoclaw-v2-fixer-*` (one live at a time; `--rm`) |
| Wake receiver | `http://127.0.0.1:5713/wake/<agent_group_id>`, header `X-Webhook-Secret` (value in `.env` `WAKE_WEBHOOK_SECRET`) |
| Support MCP | `https://app.copymind.com/api/support/mcp` (Bearer = `SUPPORT_AGENT_API_KEY`, injected by OneCLI proxy in-container) |
| OneCLI Fixer agent id | `ef40c0dd-df87-468c-b51e-5d6587ae6342` |
| Fix-target repos | `copymind-ai/copymind-app`, `copymind-ai/copymind-react-native` |

IDs can drift across redeploys — prefer the discovery commands below over trusting
the table blindly. All Mac commands run via `ssh copyclaw-mac 'bash -s' <<'REMOTE' … REMOTE`.

## 1. Health check (start here)

```bash
ssh copyclaw-mac 'bash -s' <<'REMOTE'
D=/Applications/Docker.app/Contents/Resources/bin/docker
launchctl print gui/$(id -u)/com.nanoclaw-v2-32a5669a 2>/dev/null | grep -E "state =|pid =" | head -2
"$D" ps --filter "name=nanoclaw-v2-fixer" --format "{{.Names}}  {{.Status}}"   # live container?
curl -s -o /dev/null -w "app http=%{http_code}\n" http://127.0.0.1:3000        # dev app (307=ok, auth-gated)
REMOTE
```

Restart the host if needed: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-32a5669a`.

## 2. Inspect the live container

The container is the richest signal **while it's alive** (`--rm` → logs vanish on exit).

```bash
ssh copyclaw-mac 'bash -s' <<'REMOTE'
D=/Applications/Docker.app/Contents/Resources/bin/docker
C=$("$D" ps --filter "name=nanoclaw-v2-fixer" --format "{{.Names}}" | head -1)
echo "container: ${C:-EXITED}"; [ -z "$C" ] && exit 0
"$D" stats --no-stream --format "cpu={{.CPUPerc}} mem={{.MemUsage}}" "$C"   # CPU climbing = thinking; flat ~0 = idle/blocked
"$D" exec "$C" sh -lc 'stat -c "%y" /workspace/.heartbeat; date -u +%H:%M:%S'  # last poll vs now
"$D" exec "$C" sh -lc 'ps aux | grep -E "claude.exe|git (clone|push|commit)|psql|expo|node /tmp" | grep -v grep'
# Logs — ALWAYS scrub secrets. Redact PG URL (leaks the readonly password) + tokens:
"$D" logs --tail 60 "$C" 2>&1 | sed -E "s#postgresql://[^ ]+#postgresql://***#g; s|github_pat_[A-Za-z0-9_]*|***|g; s|eyJ[A-Za-z0-9_.-]*|***JWT***|g"
REMOTE
```

The agent-runner log shows the poll loop, each `Progress:` (a Bash/tool call the
agent ran), and the `Result: <internal>…</internal>` summary of each turn. Note: the
in-container log buffer truncates long results — for the *full* text of what Fixer
concluded/posted, read the Slack thread (§6), not the log.

## 3. Session DBs (host side)

Two SQLite files; query with the in-tree wrapper (never the `sqlite3` CLI):

```bash
ssh copyclaw-mac 'bash -s' <<'REMOTE'
source ~/.nvm/nvm.sh >/dev/null; nvm use 22 >/dev/null
cd ~/repositories/copyclaw.git/agents/fixer
S=data/v2-sessions/ag-1780561376088-ntblrb/sess-1780561449056-n97lcs
# Did a wake/mention arrive? (content is in the `content` column, NOT `text`)
pnpm exec tsx scripts/q.ts "$S/inbound.db" "SELECT seq, kind, status, substr(content,1,200) FROM messages_in ORDER BY seq DESC LIMIT 5"
# Outbound DB — note replies-to-Slack do NOT appear here (they go via MCP); this is mostly cli_requests/system
pnpm exec tsx scripts/q.ts "$S/outbound.db" "SELECT seq, timestamp, substr(content,1,200) FROM messages_out ORDER BY seq DESC LIMIT 5"
pnpm exec tsx scripts/q.ts "$S/outbound.db" "SELECT * FROM session_state"   # continuation:<provider>|<sessionId>|<ts>
REMOTE
```

A wake row's `content` is JSON like `{"source":"copymind-app","event":"support_mention","payload":{"issue_id":"…","mention_id":"…"}}`.

## 4. The support MCP (what Fixer can read/do about a ticket)

The wake payload carries only `issue_id`/`mention_id`. Fixer reads ticket content via
this MCP. Tools (as of server 1.2.0): `list_open_issues`, **`get_issue_thread`** (added
2026-06; returns the bug report body + replies + screenshots — the unlock that lets
Fixer actually see a ticket), `list_pending_mentions`, `post_question` (→ status
`needs-info`), `link_pr` (→ `pr-opened`), `mark_status`, `mark_mentions_processed`.

Introspect from inside the container (auth auto-injected by the proxy):

```bash
ssh copyclaw-mac 'bash -s' <<'REMOTE'
D=/Applications/Docker.app/Contents/Resources/bin/docker
C=$("$D" ps --filter "name=nanoclaw-v2-fixer" --format "{{.Names}}" | head -1)
"$D" exec "$C" sh -lc 'curl -s -X POST "https://app.copymind.com/api/support/mcp" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"' | tr "," "\n" | grep -E '"name"|"title"'
REMOTE
```

`support_issues` stores only `title` + Slack pointers (`slack_channel`, `slack_ts`)
+ `status` + `pr_url` — **no bug body**. The body + screenshots live only in Slack.

## 5. The prod DB Fixer reproduces against

Fixer queries prod read-only via `$SUPPORT_PG_URL` (set in container env) to reproduce
a reporter's state. To check the same data yourself:

```bash
ssh copyclaw-mac 'bash -s' <<'REMOTE'
D=/Applications/Docker.app/Contents/Resources/bin/docker
C=$("$D" ps --filter "name=nanoclaw-v2-fixer" --format "{{.Names}}" | head -1)
"$D" exec "$C" sh -lc 'psql "$SUPPORT_PG_URL" -At -c "SELECT id,status,pr_url,title FROM public.support_issues WHERE id='\''<ISSUE_UUID>'\'';"' \
  | sed -E "s#postgresql://[^ ]+#***#g"
REMOTE
```

⚠️ `psql "$SUPPORT_PG_URL"` expands the password into the process list / log — the
`support_agent_readonly` password is known-leaked and should be rotated. Always pipe
output through the PG-URL redaction `sed` above, and never echo the raw URL.

For seeding a local repro user from prod, see `scripts/seed-test-user-from-prod.ts`
in the copyclaw repo (`LOCAL_DEV_PG_URL` / `SUPPORT_PG_URL`).

## 6. Read what Fixer actually posted (source of truth)

Fixer's replies go to Slack via the MCP, so read the thread directly (Slack MCP):
`mcp__claude_ai_Slack__slack_read_thread` with `channel_id` + `message_ts` (the issue's
`slack_ts`). Replies like `Status: open → needs-info` and the full diagnosis text are
here, not in the session DBs. Get `channel_id`/`slack_ts` from `support_issues` (§5).

## 7. Verify fix→PR output

On an explicit fix request Fixer clones over HTTPS with `$GH_TOKEN`, pushes a `fix/…`
branch, and opens a PR. In-container github traffic **bypasses the OneCLI proxy** via
`NO_PROXY` (the proxy otherwise mangles GitHub's `Authorization`). Check for output:

```bash
ssh copyclaw-mac 'bash -s' <<'REMOTE'
D=/Applications/Docker.app/Contents/Resources/bin/docker
C=$("$D" ps --filter "name=nanoclaw-v2-fixer" --format "{{.Names}}" | head -1)
TOK=$("$D" exec "$C" sh -lc 'echo $GH_TOKEN' 2>/dev/null)
for R in copymind-app copymind-react-native; do echo "[$R]"; \
  curl -s -H "Authorization: Bearer $TOK" "https://api.github.com/repos/copymind-ai/$R/branches?per_page=100" | grep -o '"name": "fix/[^"]*"'; done
REMOTE
```

Or just check the PR list / a specific PR locally with `gh pr list -R copymind-ai/copymind-app`.
Sanity-check the diagnosis against code in the local checkout
`~/Documents/copy-mind/copymind-app/main` (Fixer reasons from a read-only mount and has
no repro env, so its file/line claims are worth a `grep` to confirm).

## 8. Trigger a wake (test)

```bash
ssh copyclaw-mac 'bash -s' <<'REMOTE'
cd ~/repositories/copyclaw.git/agents/fixer
SECRET=$(grep "^WAKE_WEBHOOK_SECRET=" .env | cut -d= -f2-)
curl -sS -X POST "http://127.0.0.1:5713/wake/ag-1780561376088-ntblrb" \
  -H "X-Webhook-Secret: $SECRET" -H "Content-Type: application/json" \
  -d '{"issue_id":"<REAL_ISSUE_UUID>","mention_id":"<MENTION_UUID_OR_null>"}' -w "\nhttp=%{http_code}\n"
REMOTE
```

A **real** end-to-end test needs a real Slack `@Fixer …` mention (the fix flow is gated
on an explicit fix request read from the thread). Synthetic UUIDs that don't exist in
`support_issues` make Fixer no-op ("issue doesn't exist").

## Gotchas (learned the hard way)

- **Empty `messages_out` ≠ silent.** Replies to Slack go via the `copymind-support` MCP.
  Read the Slack thread (§6) to see what Fixer said.
- **`--rm` containers lose logs on exit.** Capture `docker logs` *while alive*. After exit,
  the Slack thread + `support_issues.status` + git branches are the only record.
- **Log buffer truncates** long `Result:` blocks — use the Slack thread for full text.
- **TZ offset:** wake/DB timestamps are UTC; container `ps` clock is local (often +3). A
  `13:21` process start can map to a `10:21` UTC wake.
- **`messages_in.content`** (not `.text`) holds the payload; column set differs from what
  you'd guess — `SELECT name FROM pragma_table_info('messages_in')` to be sure.
- **CPU flat at ~0% but container alive** = idle between turns or blocked on a network/MCP
  call; CPU climbing = actively reasoning/tool-calling.
- **Secrets in logs:** the readonly PG password appears in expanded `psql` args and the
  GH token may appear in git URLs — always run the redaction `sed` shown above before
  surfacing any log/ps output to the user.
- **Node 22 only** for any host `pnpm`/`tsx` command on the Mac (`nvm use 22`).
