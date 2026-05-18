/**
 * Pre-wake repo refresh.
 *
 * Pulls every `additional_mounts` entry that looks like a git repo to remote
 * HEAD before the issues-agent container is woken, so the agent always reads
 * fresh source when investigating a Slack support issue.
 *
 * Per-repo in-process mutex coalesces concurrent wakes targeting the same
 * repo into a single underlying pull. Failures are warn-only — wake proceeds
 * with stale code rather than dropping the issue.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import type { AdditionalMountConfig } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { log } from './log.js';

const PULL_TIMEOUT_MS = 15_000;
const inFlight = new Map<string, Promise<void>>();

export async function refreshRepoMounts(agentGroupId: string): Promise<void> {
  const cfg = getContainerConfig(agentGroupId);
  if (!cfg?.additional_mounts) return;

  let mounts: AdditionalMountConfig[];
  try {
    mounts = JSON.parse(cfg.additional_mounts) as AdditionalMountConfig[];
  } catch {
    return;
  }

  await Promise.all(
    mounts.filter((m) => fs.existsSync(path.join(m.hostPath, '.git'))).map((m) => safePull(m.hostPath)),
  );
}

function safePull(repoPath: string): Promise<void> {
  const existing = inFlight.get(repoPath);
  if (existing) return existing;
  const p = doPull(repoPath).finally(() => inFlight.delete(repoPath));
  inFlight.set(repoPath, p);
  return p;
}

async function doPull(repoPath: string): Promise<void> {
  const start = Date.now();
  try {
    await runGit(['-C', repoPath, 'fetch', '--quiet', 'origin']);
    await runGit(['-C', repoPath, 'reset', '--hard', '--quiet', 'origin/HEAD']);
    log.info('[repo-refresh] pulled', { repoPath, ms: Date.now() - start });
  } catch (err) {
    log.warn('[repo-refresh] pull failed', {
      repoPath,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function runGit(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout: PULL_TIMEOUT_MS }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
