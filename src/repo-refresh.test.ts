/**
 * Tests for the pre-wake repo refresh — verifies that we pull only git-backed
 * mounts, that the per-repo mutex coalesces concurrent pulls, and that spawn
 * failures are swallowed so a hung pull never blocks a wake.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// Type for the execFile callback shape we actually invoke (`(err) => void`).
// child_process.execFile's full signature accepts (err, stdout, stderr) but
// runGit only inspects err, so we keep the mock surface narrow.
type ExecFileCallback = (err: Error | null) => void;
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

beforeEach(() => {
  vi.clearAllMocks();
  // Default: every spawn succeeds asynchronously on the next tick.
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
    setImmediate(() => cb(null));
  });
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

  it('no-ops when a mount has no .git directory', async () => {
    mockGetContainerConfig.mockReturnValue({
      additional_mounts: JSON.stringify([{ hostPath: '/srv/not-a-repo', containerPath: 'foo' }]),
    });
    mockExistsSync.mockReturnValue(false);
    await refreshRepoMounts('ag-1');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('runs fetch + reset for a git-backed mount', async () => {
    mockGetContainerConfig.mockReturnValue({
      additional_mounts: JSON.stringify([
        { hostPath: '/srv/copymind-app', containerPath: 'copymind-app', readonly: true },
      ]),
    });
    await refreshRepoMounts('ag-1');

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile.mock.calls[0][0]).toBe('git');
    expect(mockExecFile.mock.calls[0][1]).toEqual(['-C', '/srv/copymind-app', 'fetch', '--quiet', 'origin']);
    expect(mockExecFile.mock.calls[1][1]).toEqual([
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

    // Hold the first fetch open until we've fired the second refresh.
    let releaseFetch: () => void = () => {};
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      releaseFetch = () => cb(null);
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      setImmediate(() => cb(null));
    });

    const a = refreshRepoMounts('ag-1');
    const b = refreshRepoMounts('ag-1');
    // Both refreshes should be waiting on the same in-flight fetch.
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    releaseFetch();
    await Promise.all([a, b]);

    // After release: the in-flight pull continues with reset --hard, and that
    // single completed pull satisfies BOTH callers (mutex). Total spawns: 2.
    expect(mockExecFile).toHaveBeenCalledTimes(2);
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

    const aCalls = mockExecFile.mock.calls.filter((c) => c[1].includes('/srv/repo-a'));
    const bCalls = mockExecFile.mock.calls.filter((c) => c[1].includes('/srv/repo-b'));
    expect(aCalls).toHaveLength(2);
    expect(bCalls).toHaveLength(2);
  });
});
