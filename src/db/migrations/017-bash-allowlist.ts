import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'bash-allowlist',
  up(db: Database.Database) {
    // Host-runtime agents hold a real shell; gating screens every Bash command
    // against an allowlist (see bash-allowlist.ts). Off by default so docker
    // agents — which rely on container isolation — are unaffected.
    db.prepare('ALTER TABLE container_configs ADD COLUMN bash_gating_enabled INTEGER NOT NULL DEFAULT 0').run();
    db.prepare("ALTER TABLE container_configs ADD COLUMN bash_allowed_patterns TEXT NOT NULL DEFAULT '[]'").run();
  },
};
