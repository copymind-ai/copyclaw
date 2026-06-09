import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'forward-gh-token',
  up(db: Database.Database) {
    // Opt-in GH_TOKEN forwarding. Only the Fixer should hold the GitHub PAT;
    // every other agent (devops, verifiers) must never push git. Default 0 so
    // a token is forwarded to NO agent until explicitly enabled (scaffold-fixer
    // sets it). Applies to both docker (buildContainerArgs) and — for safety —
    // keeps host agents tokenless regardless.
    db.prepare('ALTER TABLE container_configs ADD COLUMN forward_gh_token INTEGER NOT NULL DEFAULT 0').run();
  },
};
