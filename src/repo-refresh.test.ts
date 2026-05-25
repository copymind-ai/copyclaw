/**
 * Tests for the pre-wake repo refresh — verifies that we pull only git-backed
 * mounts, that the per-repo mutex coalesces concurrent pulls, and that spawn
 * failures are swallowed so a hung pull never blocks a wake.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// child_process.execFile callback signature: (err, stdout, stderr).
// `runGit` reads stdout from `rev-parse --git-common-dir`, so the mock has
// to deliver it.
type ExecFileCallback = (err: Error | null, stdout?: string, stderr?: string) => void;
type ExecFileArgs = [string, string[], { timeout?: number }, ExecFileCallback];

const mockExecFile = vi.fn<(...a: ExecFileArgs) => void>();

vi.mock('child_process', () => ({
  execFile: (...args: ExecFileArgs) => mockExecFile(...args),
}));

const mockExistsSync = vi.fn<(p: string) => boolean>();
vi.mock('fs', () => ({
  default: {
    existsSync: (p: string) => mockExistsSync(p),
  },
  existsSync: (p: string) => mockExistsSync(p),
}));

const mockGetContainerConfig = vi.fn<(id: string) => { additional_mounts: string | null } | undefined>();
vi.mock('./db/container-configs.js', () => ({
  getContainerConfig: (id: string) => mockGetContainerConfig(id),
}));

import { refreshRepoMounts } from './repo-refresh.js';

// Helper: return ".git\n" for rev-parse calls, empty stdout otherwise.
function defaultMockImpl(_cmd: string, args: string[], _opts: unknown, cb: ExecFileCallback): void {
  const stdout = args.includes('rev-parse') ? '.git\n' : '';
  setImmediate(() => cb(null, stdout, ''));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFile.mockImplementation(defaultMockImpl);
  mockExistsSync.mockReturnValue(true);
});

describe('refreshRepoMounts', () => {
  it('no-ops when the agent group has no container_configs row', async () => {
    mockGetContainerConfig.mockReturnValue(undefined);
    await refreshRepoMounts('ag-missing');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('no-ops when additional_mounts is null', async () => {
    mockGetContainerConfig.mockReturnValue({ additional_mounts: null });
    await refreshRepoMounts('ag-1');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('no-ops when a mount has no .git', async () => {
    mockGetContainerConfig.mockReturnValue({
      additional_mounts: JSON.stringify([{ hostPath: '/srv/not-a-repo', containerPath: 'foo' }]),
    });
    mockExistsSync.mockReturnValue(false);
    await refreshRepoMounts('ag-1');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('runs rev-parse + fetch + reset for a git-backed mount', async () => {
    mockGetContainerConfig.mockReturnValue({
      additional_mounts: JSON.stringify([
        { hostPath: '/srv/copymind-app', containerPath: 'copymind-app', readonly: true },
      ]),
    });
    await refreshRepoMounts('ag-1');

    expect(mockExecFile).toHaveBeenCalledTimes(3);
    expect(mockExecFile.mock.calls[0][0]).toBe('git');
    expect(mockExecFile.mock.calls[0][1]).toEqual([
      '-C',
      '/srv/copymind-app',
      'rev-parse',
      '--git-common-dir',
    ]);
    // Fetch runs against the resolved common-dir (.git in the mock).
    expect(mockExecFile.mock.calls[1][1]).toEqual(['-C', '.git', 'fetch', '--quiet', 'origin']);
    // Reset runs against the worktree.
    expect(mockExecFile.mock.calls[2][1]).toEqual([
      '-C',
      '/srv/copymind-app',
      'reset',
      '--hard',
      '--quiet',
      'origin/HEAD',
    ]);
  });

  it('coalesces concurrent calls for the same repo into one pull', async () => {
    mockGetContainerConfig.mockReturnValue({
      additional_mounts: JSON.stringify([
        { hostPath: '/srv/copymind-app', containerPath: 'copymind-app', readonly: true },
      ]),
    });

    // Hold the first git call (rev-parse) open until we've fired the second
    // refresh. The mutex should funnel both callers through one pull.
    let release: () => void = () => {};
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      release = () => cb(null, '.git\n', '');
    });
    mockExecFile.mockImplementation(defaultMockImpl);

    const a = refreshRepoMounts('ag-1');
    const b = refreshRepoMounts('ag-1');
    // Only one spawn while the first rev-parse is held.
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([a, b]);

    // After release: the in-flight pull continues with fetch + reset. Total
    // spawns across the single coalesced pull: 3.
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it('does not throw when execFile rejects — failure is warn-only', async () => {
    mockGetContainerConfig.mockReturnValue({
      additional_mounts: JSON.stringify([{ hostPath: '/srv/copymind-app', containerPath: 'copymind-app' }]),
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      setImmediate(() => cb(new Error('network unreachable')));
    });

    await expect(refreshRepoMounts('ag-1')).resolves.toBeUndefined();
  });

  it('pulls multiple repos in parallel', async () => {
    mockGetContainerConfig.mockReturnValue({
      additional_mounts: JSON.stringify([
        { hostPath: '/srv/repo-a', containerPath: 'a' },
        { hostPath: '/srv/repo-b', containerPath: 'b' },
      ]),
    });

    await refreshRepoMounts('ag-1');

    // 3 calls per repo × 2 repos = 6.
    const aCalls = mockExecFile.mock.calls.filter((c) => c[1].includes('/srv/repo-a'));
    const bCalls = mockExecFile.mock.calls.filter((c) => c[1].includes('/srv/repo-b'));
    expect(aCalls).toHaveLength(2); // rev-parse + reset target the repoPath
    expect(bCalls).toHaveLength(2);
  });
});
