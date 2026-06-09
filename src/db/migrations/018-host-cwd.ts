import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration018: Migration = {
  version: 18,
  name: 'host-cwd',
  up(db: Database.Database) {
    // For host-runtime agents: the working directory the agent-runner (and its
    // Bash/Read tools) operate from. Lets a host agent run tools from a fixed
    // location (e.g. devops from a repo's primary worktree so `dev wt up` works
    // without a `cd`). NULL → default to the group dir, as before.
    db.prepare('ALTER TABLE container_configs ADD COLUMN host_cwd TEXT').run();
  },
};
