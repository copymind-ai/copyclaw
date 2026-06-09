/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  DATA_DIR,
  GH_TOKEN,
  GROUPS_DIR,
  LOCAL_DEV_APP_URL,
  LOCAL_DEV_PG_URL,
  NANOCLAW_BUN_BIN,
  NANOCLAW_CLAUDE_CODE_BIN,
  ONECLI_API_KEY,
  ONECLI_URL,
  SUPPORT_PG_URL,
  TIMEZONE,
} from './config.js';
import { materializeContainerJson } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars, updateContainerConfigJson } from './db/container-configs.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/** Active agents tracked by session ID (Docker containers or host processes). */
const activeContainers = new Map<
  string,
  { process: ChildProcess; containerName: string; runtime: 'docker' | 'host' }
>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const runtime = (containerConfig.runtime || 'docker') === 'host' ? 'host' : 'docker';

  // Clear any orphan heartbeat from a previous instance — the sweep's ceiling
  // check treats a missing file as "fresh spawn, give grace" (host-sweep.ts).
  // Without this, a stale mtime can trigger an immediate kill before the new
  // process touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  let container: ChildProcess;
  if (runtime === 'host') {
    // Host runtime: run the agent-runner as a plain bun process (no Docker),
    // for agents that need host docker/simulators (e.g. devops). Paths are
    // redirected via NANOCLAW_WORKSPACE/AGENT_DIR; credentials via the extracted
    // OneCLI gateway env. See buildHostEnv / agent-runner/src/paths.ts.
    const claudeDir = prepareGroupFilesystem(agentGroup, containerConfig, true);
    const sessDir = sessionDir(agentGroup.id, session.id);
    const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);
    const env = await buildHostEnv(sessDir, groupDir, claudeDir, contribution, agentGroup.name, agentIdentifier);
    const entry = path.join(process.cwd(), 'container', 'agent-runner', 'src', 'index.ts');
    const bunBin = resolveBunBin();
    log.info('Spawning host agent process', { sessionId: session.id, agentGroup: agentGroup.name, bunBin });
    container = spawn(bunBin, ['run', entry], { cwd: groupDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    const mounts = buildMounts(agentGroup, session, containerConfig, contribution);
    const args = await buildContainerArgs(
      mounts,
      containerName,
      agentGroup,
      containerConfig,
      provider,
      contribution,
      agentIdentifier,
    );
    log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });
    container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  activeContainers.set(session.id, { process: container, containerName, runtime });
  markContainerRunning(session.id);

  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.info('Container exited', { sessionId: session.id, code, containerName });
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName, runtime: entry.runtime });
  if (entry.runtime === 'host') {
    // Host process: SIGTERM the bun process; the runner's handlers finalize
    // outbound.db. The 'close' handler clears activeContainers + heartbeat.
    entry.process.kill('SIGTERM');
    return;
  }
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

/**
 * Idempotent per-group filesystem prep, shared by the Docker and host runtimes:
 * init the group dirs, sync skill symlinks, and (re)compose CLAUDE.md. Returns
 * the per-group `.claude-shared` dir (Claude SDK state + skill symlinks).
 *
 * `hostRuntime` controls the skill symlink target: Docker sees skills at the
 * `/app/skills` RO mount; a host process has no mount, so symlinks must point
 * at the real repo path (`container/skills`).
 */
function prepareGroupFilesystem(
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  hostRuntime: boolean,
): string {
  initGroupFilesystem(agentGroup);
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  const skillTargetBase = hostRuntime ? path.join(process.cwd(), 'container', 'skills') : '/app/skills';
  syncSkillSymlinks(claudeDir, containerConfig, skillTargetBase);
  composeGroupClaudeMd(agentGroup);
  return claudeDir;
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Idempotent group filesystem prep (init dirs, skill symlinks, compose
  // CLAUDE.md). Shared with the host runtime — Docker skill symlinks target
  // /app/skills (RO mount).
  const claudeDir = prepareGroupFilesystem(agentGroup, containerConfig, false);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(
  claudeDir: string,
  containerConfig: import('./container-config.js').ContainerConfig,
  // Where the skill targets live. In Docker the runner sees them at
  // /app/skills (a RO mount); for the host runtime there's no mount, so the
  // symlinks must point at the real repo path (container/skills).
  skillTargetBase: string = '/app/skills',
): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Determine desired skill set
  const projectRoot = process.cwd();
  const sharedSkillsDir = path.join(projectRoot, 'container', 'skills');
  let desired: string[];
  if (containerConfig.skills === 'all') {
    // Recompute from shared dir — newly-added upstream skills appear automatically
    desired = fs.existsSync(sharedSkillsDir)
      ? fs.readdirSync(sharedSkillsDir).filter((e) => {
          try {
            return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
          } catch {
            return false;
          }
        })
      : [];
  } else {
    desired = containerConfig.skills;
  }

  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(`${skillTargetBase}/${skill}`, linkPath);
    }
  }
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Forward the assembled Supabase Postgres URL (built in config.ts from the
  // three SUPABASE_APP_PG_* .env components) so the agent can query the prod
  // DB as the read-only role. The container only sees the final URL.
  if (SUPPORT_PG_URL) {
    args.push('-e', `SUPPORT_PG_URL=${SUPPORT_PG_URL}`);
  }

  // Forward the long-lived local dev stack URLs so the agent can visit the
  // dev app via agent-browser (LOCAL_DEV_APP_URL) and write to the local
  // Supabase Postgres (LOCAL_DEV_PG_URL) for reproductions, without ever
  // pointing at prod. Optional — undefined when the host hasn't provisioned
  // the dev stack yet.
  if (LOCAL_DEV_APP_URL) {
    args.push('-e', `LOCAL_DEV_APP_URL=${LOCAL_DEV_APP_URL}`);
  }
  if (LOCAL_DEV_PG_URL) {
    args.push('-e', `LOCAL_DEV_PG_URL=${LOCAL_DEV_PG_URL}`);
  }

  // Forward the GitHub PAT so the Fixer can push fix branches + open PRs.
  // Only the Fixer needs it, but it's harmless for verify-only agents (they
  // simply never use it). Optional — undefined until provisioned.
  if (GH_TOKEN) {
    args.push('-e', `GH_TOKEN=${GH_TOKEN}`);
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection. Treated as
  // a transient hard failure: if we can't wire the gateway, we don't spawn.
  // The caller (router or host-sweep) catches the throw, leaves the inbound
  // message pending, and the next sweep tick retries.
  if (agentIdentifier) {
    await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
  }
  const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
  if (!onecliApplied) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }
  log.info('OneCLI gateway applied', { containerName });

  // GitHub goes DIRECT, bypassing the OneCLI proxy. The proxy MITMs TLS and
  // only cleanly forwards Authorization for hosts it has a vault secret for;
  // github isn't one, so a proxied push/PR gets its auth header mangled
  // (verified: 403 via proxy, 200 direct). The proxy's combined CA already
  // validates github's real cert, so only the proxy bypass is needed. Set
  // after applyContainerConfig so it isn't clobbered by OneCLI's proxy vars.
  const NO_PROXY_GITHUB =
    'github.com,api.github.com,codeload.github.com,uploads.github.com,objects.githubusercontent.com';
  args.push('-e', `NO_PROXY=${NO_PROXY_GITHUB}`, '-e', `no_proxy=${NO_PROXY_GITHUB}`);

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  return args;
}

/**
 * Extract the OneCLI gateway env for a HOST process. The SDK only knows how to
 * mutate a Docker args array (applyContainerConfig pushes -e/-v), so run it
 * against a throwaway array and lift the result onto a process env:
 *   - each `-e KEY=VALUE` → env[KEY]
 *   - a cert env value pointing at a `-v <hostSrc>:<containerTarget>` mount
 *     target is remapped to the host source path (there's no mount on the host)
 *   - `host.docker.internal` (a container-only alias) → 127.0.0.1
 * Throws if the gateway is unreachable (same contract as the Docker path).
 */
/**
 * Resolve the `bun` binary for the host runtime. The launchd-spawned host
 * process's PATH usually omits `~/.bun/bin`, so probe known locations and fall
 * back to PATH resolution. Override with NANOCLAW_BUN_BIN.
 */
function resolveBunBin(): string {
  const home = process.env.HOME;
  const candidates = [
    NANOCLAW_BUN_BIN,
    home ? path.join(home, '.bun', 'bin', 'bun') : undefined,
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* keep probing */
    }
  }
  return 'bun';
}

/**
 * Locate the `claude-code` CLI on the host. The Docker image installs it at
 * `/pnpm/claude`; on the host it lives wherever it was globally installed.
 * Set `NANOCLAW_CLAUDE_CODE_BIN` to pin an absolute path (the launchd PATH is
 * narrow and won't include nvm/bun bins). Returns undefined if none found, in
 * which case the SDK falls back to its built-in default.
 */
function resolveClaudeCodeBin(): string | undefined {
  const home = process.env.HOME;
  const candidates = [
    NANOCLAW_CLAUDE_CODE_BIN,
    home ? path.join(home, '.bun', 'bin', 'claude') : undefined,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* keep probing */
    }
  }
  return undefined;
}

async function extractOneCliHostEnv(agentName: string, agentIdentifier: string): Promise<Record<string, string>> {
  // Register the agent first (mirrors the Docker path in buildContainerArgs);
  // applyContainerConfig fetches per-agent config and returns false otherwise.
  await onecli.ensureAgent({ name: agentName, identifier: agentIdentifier });
  const tmp: string[] = [];
  const ok = await onecli.applyContainerConfig(tmp, { addHostMapping: false, agent: agentIdentifier });
  if (!ok) throw new Error('OneCLI gateway not applied (host runtime) — refusing to spawn without credentials');

  const targetToHostSrc = new Map<string, string>();
  for (let i = 0; i < tmp.length - 1; i++) {
    if (tmp[i] === '-v') {
      const parts = tmp[i + 1].split(':');
      if (parts.length >= 2) targetToHostSrc.set(parts[1], parts[0]);
    }
  }

  const env: Record<string, string> = {};
  for (let i = 0; i < tmp.length - 1; i++) {
    if (tmp[i] !== '-e') continue;
    const kv = tmp[i + 1];
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    const key = kv.slice(0, eq);
    let value = kv.slice(eq + 1);
    if (targetToHostSrc.has(value)) value = targetToHostSrc.get(value)!;
    value = value.replace(/host\.docker\.internal/g, '127.0.0.1');
    env[key] = value;
  }
  return env;
}

/**
 * Build the environment for a host-runtime agent process. Inherits the host env
 * (PATH etc. — a host agent runs real host tooling), then overlays TZ, the
 * forwarded app vars, provider env, the OneCLI gateway env, the NANOCLAW_* path
 * overrides (session dir + group dir), and a host HOME whose `.claude` points at
 * the per-group Claude state dir (the Docker runtime achieves this with a
 * mount-rename; on the host we symlink).
 */
async function buildHostEnv(
  sessDir: string,
  groupDir: string,
  claudeDir: string,
  contribution: ProviderContainerContribution,
  agentName: string,
  agentIdentifier: string,
): Promise<NodeJS.ProcessEnv> {
  const homeDir = path.join(sessDir, '.host-home');
  fs.mkdirSync(homeDir, { recursive: true });
  const dotClaude = path.join(homeDir, '.claude');
  try {
    if (fs.lstatSync(dotClaude).isSymbolicLink() && fs.readlinkSync(dotClaude) === claudeDir) {
      // already correct
    } else {
      fs.rmSync(dotClaude, { recursive: true, force: true });
      fs.symlinkSync(claudeDir, dotClaude);
    }
  } catch {
    fs.symlinkSync(claudeDir, dotClaude);
  }

  const onecliEnv = await extractOneCliHostEnv(agentName, agentIdentifier);

  // GitHub bypasses the gateway proxy (same rationale as the Docker path). A
  // host agent also runs local dev tooling (docker/supabase/git on loopback)
  // whose traffic must NOT route through the gateway, so widen NO_PROXY.
  const noProxy = [
    process.env.NO_PROXY,
    'github.com,api.github.com,codeload.github.com,uploads.github.com,objects.githubusercontent.com',
    'localhost,127.0.0.1,::1,host.docker.internal',
  ]
    .filter(Boolean)
    .join(',');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TZ: TIMEZONE,
    ...contribution.env,
    ...onecliEnv,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NANOCLAW_WORKSPACE: sessDir,
    NANOCLAW_AGENT_DIR: groupDir,
    HOME: homeDir,
  };
  const claudeBin = resolveClaudeCodeBin();
  if (claudeBin) env.CLAUDE_CODE_EXECUTABLE = claudeBin;
  if (SUPPORT_PG_URL) env.SUPPORT_PG_URL = SUPPORT_PG_URL;
  if (LOCAL_DEV_APP_URL) env.LOCAL_DEV_APP_URL = LOCAL_DEV_APP_URL;
  if (LOCAL_DEV_PG_URL) env.LOCAL_DEV_PG_URL = LOCAL_DEV_PG_URL;
  if (GH_TOKEN) env.GH_TOKEN = GH_TOKEN;
  return env;
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
