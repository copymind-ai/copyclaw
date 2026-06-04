# Mac mini setup (macOS)

Bootstrap a Mac mini so it can host CopyClaw while still being usable as a normal personal computer. Remote access is **optional** — by default the box is reachable over your LAN via plain SSH; the Cloudflare Tunnel section at the end lets you reach it from the public internet without opening router ports.

Substitute `<user>` with your existing macOS account name everywhere it appears.

## 1. Basics

Open Terminal as your normal account.

```bash
# Hostname (all three so HostName / LocalHostName / ComputerName agree)
sudo scutil --set HostName     copyclaw-mac
sudo scutil --set LocalHostName copyclaw-mac
sudo scutil --set ComputerName  copyclaw-mac

# Don't let the system sleep — display can still turn off
sudo pmset -a sleep 0 disksleep 0 displaysleep 10 powernap 0
```

If you also want it to come back automatically after a power cut (typical for a box that doubles as a server):

```bash
sudo pmset -a autorestart 1
```

Skip that if you'd rather the box stay off until you press the power button.

## 2. Enable SSH (LAN)

On the mini:

```bash
# Turn on Remote Login (sshd) for your user
sudo systemsetup -setremotelogin on
sudo dseditgroup -o edit -a <user> -t user com.apple.access_ssh

# Disable password auth — keys only
sudo tee /etc/ssh/sshd_config.d/100-copyclaw.conf > /dev/null <<'EOF'
PasswordAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin no
EOF

sudo launchctl kickstart -k system/com.openssh.sshd
```

> **Diagnostic gotcha.** `sudo launchctl print system/com.openssh.sshd | grep state` will report `state = not running` when nobody is connected. That's **normal** — macOS sshd is launchd-socket-activated: `launchd` (PID 1) holds port 22 and spawns sshd on-demand per connection. Verify the listener is actually live with `sudo lsof -nP -iTCP:22 -sTCP:LISTEN` (expect a `launchd` row on `*:22`). If `systemsetup -setremotelogin on` silently no-ops, fall back to the GUI: **System Settings → General → Sharing → Remote Login** toggle ON.

Generate a dedicated SSH key on **your laptop** (don't reuse a general-purpose key — one breach shouldn't compromise everything):

```bash
mkdir -p ~/.ssh/mac-mini && chmod 700 ~/.ssh/mac-mini
ssh-keygen -t ed25519 -f ~/.ssh/mac-mini/copymind -N "" -C "$(whoami)@laptop -> copyclaw-mac"
cat ~/.ssh/mac-mini/copymind.pub        # copy this line
```

Then on the **mini**, paste the public key into `authorized_keys`:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
cat >> ~/.ssh/authorized_keys <<'EOF'
ssh-ed25519 AAAA...paste-the-line-from-cat-above... you@laptop -> copyclaw-mac
EOF
chmod 600 ~/.ssh/authorized_keys
```

Test from your laptop on the same network:

```bash
ssh -i ~/.ssh/mac-mini/copymind <user>@copyclaw-mac.local
```

That's the minimum. The box is now a normal Mac that you can also SSH into from any laptop on your LAN.

## 3. Install Homebrew

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv)"
```

CopyClaw's later install steps (`docs/prerequisites.md`) assume `brew` on PATH.

---

Everything below is **optional** — only do it if you need to reach the mini from the public internet (e.g. wake webhook from copymind-app, or SSH while travelling) without opening any router ports.

## 4. (Optional) Cloudflare Tunnel

The tunnel exposes two hostnames: one for SSH (gated by Cloudflare Access email PIN), one for the wake webhook (gated by an `X-Webhook-Secret` header). Router stays closed.

### 4.1 Install cloudflared

```bash
brew install cloudflared
```

Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** → name `COPYCLAW` → next → pick **macOS / arm64** → copy the install snippet, which ends with:

```bash
sudo cloudflared service install <TUNNEL_TOKEN>
```

Verify:

```bash
sudo launchctl print system/com.cloudflare.cloudflared | grep -E 'state|pid'
# → state = running, pid = <nonzero>
```

Wait until the dashboard shows the tunnel as **HEALTHY**.

### 4.2 Add tunnel routes

**Tunnels → COPYCLAW → Public Hostnames → Add a public hostname**:

| Purpose | Subdomain | Domain | Type | URL |
|---|---|---|---|---|
| SSH | `ssh-copyclaw-mac` | `copymind.com` | `SSH` | `localhost:22` |
| Wake webhook | `copyclaw-mac` | `copymind.com` | `HTTP` | `localhost:5713` |

Both are first-level subdomains → covered by free Universal SSL. Wake-route's backend doesn't exist yet; the route returns 502 until the host's wake-receiver is listening on `:5713`.

Both subdomains are `*-copyclaw-mac` — distinct from the droplet's `ssh-copyclaw` / `copyclaw` — so the two machines run side-by-side on the same Cloudflare account, and you cut copymind-app over from the droplet to the mini by changing one env var (`COPYCLAW_URL`), not by touching DNS.

> **530 gotcha.** If `curl -I https://copyclaw-mac.copymind.com/...` returns **530** (Cloudflare error 1033) even with the connector HEALTHY, the `copyclaw-mac` **DNS record points at the wrong tunnel** — typically a stale/dead tunnel from an earlier attempt. Cloudflare → **DNS → Records → `copyclaw-mac`** and confirm the CNAME target is `<this-tunnel-id>.cfargotunnel.com` (same target as the working `ssh-copyclaw-mac` record). A 530 means the edge has no connector for that hostname's tunnel; a 502 means it reached the mini but nothing is on `:5713` yet.

### 4.3 Cloudflare Access (gate the SSH hostname)

**Zero Trust → Access → Applications → Add an application → Public DNS** ("Public DNS" is what older docs called "Self-hosted"). Fields:

| Field | Value |
|---|---|
| Application name | `copyclaw-mac-ssh` |
| Session duration | 24 hours |
| Public hostname | `ssh-copyclaw-mac.copymind.com` |
| Identity providers | **Choose available identity providers** → check `OneTimePin` |
| Apply instant authentication | ON |
| Authenticate with Cloudflare One Client | OFF |
| MFA | skip |

> The "Accept all available identity providers" vs "Choose available identity providers + instant auth" choices are mutually exclusive in the new UI. Pick the second: it skips the IdP picker screen *and* prevents future IdPs (Google, GitHub, etc.) from silently becoming valid for SSH.

Policies step → if you already have a `copymind-admins` (or equivalent) reusable policy from the droplet setup, **attach it** rather than creating a duplicate. Otherwise add:

| Field | Value |
|---|---|
| Name | `copymind-admins` |
| Action | Allow |
| Include | Selector: **Emails**, Value: your email |

**Do not** create an Access app for `copyclaw-mac.copymind.com` — that hostname is gated by the `X-Webhook-Secret` header from copymind-app, not by Access.

### 4.4 Laptop SSH config (tunnel)

On your laptop:

```bash
brew install cloudflared
```

Append to `~/.ssh/config`:

```sshconfig
Host copyclaw-mac
  HostName ssh-copyclaw-mac.copymind.com
  User <user>
  IdentityFile ~/.ssh/mac-mini/copymind
  IdentitiesOnly yes
  ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h
  ForwardAgent no
```

(Adjust `cloudflared` path: `/usr/local/bin/cloudflared` on Intel macOS / Linux.)

`IdentitiesOnly yes` is load-bearing: without it, ssh-agent offers every key it knows about before falling back to the configured one — which can trip Cloudflare Access rate limiting or cause confusing "too many auth failures" errors.

Test:

```bash
cloudflared access login ssh-copyclaw-mac.copymind.com   # one-time PIN
ssh copyclaw-mac
```

You now have two ways to reach the mini: `ssh -i ~/.ssh/mac-mini/copymind <user>@copyclaw-mac.local` on the LAN, and `ssh copyclaw-mac` (over the tunnel) from anywhere.

## 5. Env vars for copymind-app (Phase B handoff)

Only relevant if you set up the tunnel above and want copymind-app to fire the wake webhook:

```
COPYCLAW_URL=https://copyclaw-mac.copymind.com
COPYCLAW_AGENT_ID=<fixer group id printed by scripts/scaffold-fixer.ts>
COPYCLAW_WEBHOOK_SECRET=<must equal the mini's WAKE_WEBHOOK_SECRET in .env>
```

`CopyClawClient.fireWakeWebhook` POSTs to `${COPYCLAW_URL}/wake/${COPYCLAW_AGENT_ID}` with `X-Webhook-Secret`.

For pure-LAN use, point `COPYCLAW_URL` at `http://copyclaw-mac.local:5713` instead.

> **Cutover from the droplet.** Flipping these three values on copymind-app's Vercel **production** env (and redeploying) is the entire cutover — the droplet keeps running untouched as an instant rollback (revert the three values). `COPYCLAW_AGENT_ID` is mini-specific: the mini's central DB is fresh, so `scaffold-fixer.ts` mints a **new** `ag-*` id distinct from the droplet's.

## Next

Mac mini is bootstrapped. Continue, in order, inside the mini:

1. **`docs/github-ssh-setup.md`** — per-repo GitHub deploy keys with symmetric SSH config aliases (one block per repo under `~/.ssh/github/<reponame>/`).
2. **`docs/prerequisites.md`** — install Claude Code, Node.js (via nvm), Docker. On macOS the Docker step is **Docker Desktop** (`brew install --cask docker`) or **Colima** (`brew install colima docker`); the apt instructions in that doc are Ubuntu-only.
   > **Node version is load-bearing.** Install the version in CopyClaw's `.nvmrc` (currently **22**) and `nvm alias default 22`. Do **not** use Node 26 — `better-sqlite3@11.x` fails to compile against its V8 headers (`gyp ERR! build error`), which silently breaks `pnpm install`.
3. **Clone CopyClaw** and run it on the **`agents/fixer`** branch (`deploy` is deprecated and will be deleted post-release; `agents/*` is the per-agent branch convention). Then `bash nanoclaw.sh` (or `dev nanoclaw up`) drives OneCLI install, agent image build, and the launchd user agent (macOS analog of the systemd user service).
   > **Worktree trap.** If you use the bare-clone + worktree layout (`copyclaw.git/agents/fixer`), make sure the worktree actually tracks `origin/agents/fixer` — `git -C <worktree> rev-parse --abbrev-ref HEAD` and `git log -1` should show the support-agent commits (e.g. `src/wake-receiver.ts` exists). A worktree left on a stale local branch cut from upstream `main` looks fine but is missing every customization, so `:5713` never binds. Fix: `git fetch origin && git reset --hard origin/agents/fixer`, then reinstall + rebuild.
4. **Scaffold + secret** — run `scripts/scaffold-fixer.ts` (creates the fixer group, prints the `COPYCLAW_AGENT_ID`, sets `additional_mounts`/`packages_apt`). Add `SUPPORT_AGENT_API_KEY` to the OneCLI vault (host pattern `app.copymind.com`, `Authorization: Bearer {value}`) and **explicitly assign it** to the agent (`onecli agents set-secrets --id <onecli-agent-id> --secret-ids <anthropic>,<support>`). `--mode all` alone did **not** inject reliably; explicit `set-secrets` is what works. Verify with a local wake: `list_pending_mentions` returns 200, not `credential_not_found`.
