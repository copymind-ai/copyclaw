# Prerequisite apps

Install these on the droplet before running `bash nanoclaw.sh`. The snippets below are what worked at time of writing, but installer URLs and recommended versions change often.

> **Before running anything: open the linked source-of-truth page and reconcile against the latest upstream instructions.** If the upstream page diverges from this doc, follow upstream and update this doc afterwards.

| App | Source of truth (verify before running) |
|---|---|
| Claude Code | https://code.claude.com/docs/en/setup |
| Node.js (via nvm) | https://nodejs.org/en/download |
| Docker Engine | https://docs.docker.com/engine/install/ubuntu/ |

## Claude Code

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

After install, run `claude` once to complete OAuth — paste the URL into your laptop's browser, complete sign-in, paste the code back into the SSH session.

```bash
claude --version
```

## Node.js (via nvm)

```bash
# 1. Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

# 2. Reload nvm in the current shell (or open a new one)
\. "$HOME/.nvm/nvm.sh"

# 3. Install + activate Node 24
nvm install 24

# 4. Verify
node -v    # → v24.x
npm -v     # → 11.x
```

## Docker Engine

```bash
# 1. Add Docker's official GPG key
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# 2. Add the repository to Apt sources
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update

# 3. Install Docker Engine
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

# 4. Verify the daemon
sudo systemctl status docker
# If inactive: sudo systemctl start docker
```

### Post-install: non-root Docker access

`nanoclaw.sh` and the agent runtime expect `docker` to work **without `sudo`**. Add your user to the `docker` group:

```bash
sudo usermod -aG docker $USER

# Log out and back in (or run `newgrp docker`) for the group change to take effect.
# Then verify:
docker run --rm hello-world   # → "Hello from Docker!" without sudo
```

If you started `nanoclaw.sh` before this step, kill it and re-run after the group change is active — systemd inherits the pre-group session otherwise.

## Verification (all three at once)

```bash
claude --version              # any version
node -v                       # v24.x
docker --version              # any version
docker run --rm hello-world   # no sudo, prints "Hello from Docker!"
```

When all four pass, you're ready for `bash nanoclaw.sh`.

## Keeping this doc current

These three tools all distribute via shell installers that frequently change. When you reinstall on a new droplet (or after a long gap), the workflow is:

1. Open each "Source of truth" page above.
2. Compare commands against this doc.
3. If anything differs (new nvm version, new Docker apt source format, new Claude Code installer URL): follow upstream, **then update this doc** so the next install is one-shot.
