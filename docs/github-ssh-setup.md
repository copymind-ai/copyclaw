# GitHub SSH setup (multi-repo per droplet)

Per-repo deploy keys with symmetric SSH config aliases. Lets one Linux user on a droplet clone/pull multiple GitHub repos without sharing keys across repos.

## Convention

| Element | Pattern |
|---|---|
| Private key | `~/.ssh/github/<reponame>/id_ed25519` |
| SSH host alias | `github.com-<reponame>` |
| Clone URL | `git@github.com-<reponame>:<org>/<reponame>.git` |
| GitHub side | Deploy key on the repo (read-only by default) |

Plain `git@github.com:...` clones **fail by design** — there is no global SSH identity on the droplet. The failure forces use of the right alias instead of silently picking the wrong key.

## Add a repo (parameterize `<reponame>`)

### 1. Generate a fresh ed25519 key for this repo only

```bash
mkdir -p ~/.ssh/github/<reponame>
chmod 700 ~/.ssh ~/.ssh/github ~/.ssh/github/<reponame>

ssh-keygen -t ed25519 \
  -C "<reponame>-droplet@github" \
  -f ~/.ssh/github/<reponame>/id_ed25519 \
  -N ""

cat ~/.ssh/github/<reponame>/id_ed25519.pub
```

Copy the printed public key.

### 2. Add it as a deploy key on GitHub

Repo → Settings → Deploy keys → Add deploy key:
- Title: `<droplet-hostname>-<reponame>` (e.g. `copyclaw-1-copyclaw`)
- Key: paste
- Allow write access: **off** unless this droplet needs to push back

### 3. Add an SSH config block

```bash
cat >> ~/.ssh/config <<'EOF'

Host github.com-<reponame>
  HostName github.com
  User git
  IdentityFile ~/.ssh/github/<reponame>/id_ed25519
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
```

`IdentitiesOnly yes` prevents ssh from trying other keys against github.com (which can trigger rate-limit / wrong-key failures).

### 4. Verify

```bash
ssh -T git@github.com-<reponame>
# → Hi <org>/<reponame>! You've successfully authenticated...
```

`Permission denied (publickey)` → deploy key not attached on GitHub. Other errors → SSH config block doesn't match.

### 5. Clone

```bash
git clone git@github.com-<reponame>:<org>/<reponame>.git
```

`origin` points at the aliased URL, so subsequent `git fetch` / `git pull` keep using the right key automatically.

## Scaling: full example with three repos

`~/.ssh/config` after `copyclaw`, `copymind-app`, `copymind-marketing` are set up:

```sshconfig
Host github.com-copyclaw
  HostName github.com
  User git
  IdentityFile ~/.ssh/github/copyclaw/id_ed25519
  IdentitiesOnly yes

Host github.com-copymind-app
  HostName github.com
  User git
  IdentityFile ~/.ssh/github/copymind-app/id_ed25519
  IdentitiesOnly yes

Host github.com-copymind-marketing
  HostName github.com
  User git
  IdentityFile ~/.ssh/github/copymind-marketing/id_ed25519
  IdentitiesOnly yes
```

Key tree on disk:

```
~/.ssh/
├── config
├── known_hosts
└── github/
    ├── copyclaw/{id_ed25519,id_ed25519.pub}
    ├── copymind-app/{id_ed25519,id_ed25519.pub}
    └── copymind-marketing/{id_ed25519,id_ed25519.pub}
```

Clone commands:

```bash
git clone git@github.com-copyclaw:copymind-ai/copyclaw.git
git clone git@github.com-copymind-app:copymind-ai/copymind-app.git
git clone git@github.com-copymind-marketing:copymind-ai/copymind-marketing.git
```

## Notes

- **Read-only by default.** Flip to "Allow write access" only if the install needs to push back (self-modification flows, CI-from-droplet, etc.).
- **One key per repo, never shared.** A leaked deploy key affects only that one repo.
- **Passphrase-less by design.** A systemd-driven `git pull` can't prompt for a passphrase. Filesystem permissions (`chmod 600` on private keys, `chmod 700` on directories) are the lock.
- **Rotation.** To rotate a repo's key: delete the deploy key on GitHub, delete `~/.ssh/github/<reponame>/`, redo steps 1-4.

## Recovery

If you lock yourself out of SSH-via-cloudflared during config edits, reach the droplet via DO Control Panel → Droplets → your droplet → **Console** (out-of-band). Fix `~/.ssh/config` from there. The web console doesn't depend on SSH or cloudflared.
