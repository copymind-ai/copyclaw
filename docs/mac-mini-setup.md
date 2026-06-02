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
| Wake webhook | `copyclaw` | `copymind.com` | `HTTP` | `localhost:5713` |

Both are first-level subdomains → covered by free Universal SSL. Wake-route's backend doesn't exist yet; the route returns 502 until Phase B builds the listener.

(SSH subdomain is `ssh-copyclaw-mac` — different from the droplet's `ssh-copyclaw` — so the two machines can coexist on the same Cloudflare account.)

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

**Do not** create an Access app for `copyclaw.copymind.com` — that hostname is gated by the `X-Webhook-Secret` header from copymind-app.

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
COPYCLAW_URL=https://copyclaw.copymind.com
COPYCLAW_AGENT_ID=<bug-triage agent group id>
COPYCLAW_WEBHOOK_SECRET=<long random string>
```

`CopyClawClient.fireWakeWebhook` POSTs to `${COPYCLAW_URL}/wake/${COPYCLAW_AGENT_ID}` with `X-Webhook-Secret`.

For pure-LAN use, point `COPYCLAW_URL` at `http://copyclaw-mac.local:5713` instead.

## Next

Mac mini is bootstrapped. Continue, in order, inside the mini:

1. **`docs/github-ssh-setup.md`** — per-repo GitHub deploy keys with symmetric SSH config aliases (one block per repo under `~/.ssh/github/<reponame>/`).
2. **`docs/prerequisites.md`** — install Claude Code, Node.js (via nvm), Docker. On macOS the Docker step is **Docker Desktop** (`brew install --cask docker`) or **Colima** (`brew install colima docker`); the apt instructions in that doc are Ubuntu-only.
3. **Clone CopyClaw** under `~/repositories/copyclaw` on the `agents/fixer` branch, then run `bash nanoclaw.sh` to drive OneCLI install, agent image build, and the launchd user agent (macOS analog of the systemd user service).
