# Droplet setup (Digital Ocean + Cloudflare Tunnel)

Bootstrap an Ubuntu droplet reachable **only via Cloudflare Tunnel SSH** (email-PIN gated). Wake-webhook hostname reserved on the same tunnel. Public port 22 never opens.

Substitute `<user>` with your preferred non-root username everywhere it appears.

## 1. Create droplet

DO Control Panel → Create → Droplets.

| Setting | Value |
|---|---|
| Image | Ubuntu 24.04 LTS x64 |
| Plan | Premium Intel/AMD, 4 GB / 2 vCPU |
| Region | nearest |
| VPC | default |
| IPv6 | enable |
| Backups | skip |
| Monitoring | enable |
| Authentication | SSH key (`~/.ssh/id_ed25519.pub`); no password |
| Hostname | `copyclaw-1` |
| Tags | `copyclaw` |

DO Cloud Firewall (Networking → Firewalls → Create):
- **No inbound rules** (port 22 stays closed from day one).
- Outbound: All TCP / All UDP.
- Apply to tag `copyclaw`.

## 2. Bootstrap (DO web Droplet Console, as root)

```bash
apt update && apt upgrade -y
apt install -y curl ca-certificates ufw

adduser <user>
usermod -aG sudo <user>
rsync --archive --chown=<user>:<user> /root/.ssh /home/<user>/

sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh

ufw default deny incoming
ufw default allow outgoing
ufw --force enable
```

## 3. Install cloudflared

Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** → name `COPYCLAW` → next → pick **Debian / 64-bit** → copy the install snippet.

Paste it on the droplet (web console). Shape:

```bash
curl -L --output cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
sudo cloudflared service install <TUNNEL_TOKEN>
systemctl status cloudflared      # → active (running)
```

Wait until the dashboard shows the tunnel as **HEALTHY**.

## 4. Add tunnel routes

**Tunnels → COPYCLAW → Routes → Add a route → Published application**:

| Purpose | Subdomain | Domain | Service |
|---|---|---|---|
| SSH | `ssh-copyclaw` | `copymind.com` | `ssh://localhost:22` |
| Wake webhook | `copyclaw` | `copymind.com` | `http://localhost:5713` |

Both are first-level subdomains → covered by free Universal SSL. Wake-route's backend doesn't exist yet; route returns 502 until Phase B builds the listener.

## 5. Cloudflare Access (SSH only)

**Zero Trust → Access → Applications → Add → Self-hosted**:

| Field | Value |
|---|---|
| App name | `copyclaw-ssh` |
| Session duration | 24 hours |
| Destination | `ssh-copyclaw.copymind.com` (path empty) |
| Auth: Accept all IdPs | ON |
| Auth: Apply instant authentication | ON |
| Auth: Authenticate with Cloudflare One Client | OFF |
| MFA | skip |

Policies tab → Add a policy:

| Field | Value |
|---|---|
| Name | `copymind-admins` |
| Action | Allow |
| Include | Selector: **Emails**, Value: your email |

**Do not** create an Access app for `copyclaw.copymind.com` — that hostname is gated by the `X-Webhook-Secret` header from copymind-app.

## 6. Laptop SSH config

```bash
brew install cloudflared
```

Append to `~/.ssh/config`:

```sshconfig
Host copyclaw
  HostName ssh-copyclaw.copymind.com
  User <user>
  ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h
```

(Adjust `cloudflared` path: `/usr/local/bin/cloudflared` on Intel macOS / Linux.)

Test:

```bash
cloudflared access login ssh-copyclaw.copymind.com   # one-time PIN
ssh copyclaw
```

## 7. Verify lockdown

From outside the droplet:

```bash
nc -vz -w 5 <droplet-public-ip> 22    # → connection timed out
ssh copyclaw                           # → still works
```

## Recovery

DO Control Panel → Droplets → your droplet → **Console** (out-of-band; works without SSH or firewall changes).

## Env vars for copymind-app (Phase B handoff)

```
COPYCLAW_URL=https://copyclaw.copymind.com
COPYCLAW_AGENT_ID=<bug-triage agent group id>
COPYCLAW_WEBHOOK_SECRET=<long random string>
```

`CopyClawClient.fireWakeWebhook` POSTs to `${COPYCLAW_URL}/wake/${COPYCLAW_AGENT_ID}` with `X-Webhook-Secret`.

## Next

Droplet is bootstrapped and reachable only via Cloudflare Tunnel SSH. Continue, in order, inside the droplet over `ssh copyclaw`:

1. **`docs/github-ssh-setup.md`** — per-repo GitHub deploy keys with symmetric SSH config aliases (one block per repo under `~/.ssh/github/<reponame>/`).
2. **`docs/prerequisites.md`** — install Claude Code, Node.js (via nvm), Docker Engine. Includes the non-root `docker` group step that `nanoclaw.sh` needs.
3. **Clone CopyClaw** under `~/repositories/copyclaw` on the `deploy` branch, then run `bash nanoclaw.sh` to drive OneCLI install, agent image build, and the systemd user service.
