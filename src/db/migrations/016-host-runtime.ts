import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'host-runtime',
  up(db: Database.Database) {
    // Where the agent-runner runs: 'docker' (default) or 'host' (a plain host
    // process, for agents that need host docker/simulators — e.g. devops).
    db.prepare("ALTER TABLE container_configs ADD COLUMN runtime TEXT NOT NULL DEFAULT 'docker'").run();
  },
};
