/**
 * Runtime paths for the agent-runner.
 *
 * In the Docker runtime these resolve to the baked-in container layout
 * (`/workspace`, `/workspace/agent`). For the **host runtime** (an agent that
 * runs as a plain host process — see src/container-runner.ts), the host spawns
 * the runner with `NANOCLAW_WORKSPACE` (the session dir) and `NANOCLAW_AGENT_DIR`
 * (the agent group dir) set, so the same code reads/writes real host paths
 * instead of container mount points. Defaults keep the Docker behavior identical.
 */

/** Session dir: inbound.db, outbound.db, .heartbeat, outbox/, extra/. */
export const WORKSPACE = process.env.NANOCLAW_WORKSPACE || '/workspace';

/** Agent group dir: cwd, container.json, CLAUDE.local.md, conversations/. */
export const AGENT_DIR = process.env.NANOCLAW_AGENT_DIR || `${WORKSPACE}/agent`;

export const INBOUND_DB_PATH = `${WORKSPACE}/inbound.db`;
export const OUTBOUND_DB_PATH = `${WORKSPACE}/outbound.db`;
export const HEARTBEAT_PATH = `${WORKSPACE}/.heartbeat`;
export const OUTBOX_DIR = `${WORKSPACE}/outbox`;
export const EXTRA_DIR = `${WORKSPACE}/extra`;

export const CONTAINER_JSON_PATH = `${AGENT_DIR}/container.json`;
export const CONVERSATIONS_DIR = process.env.NANOCLAW_CONVERSATIONS_DIR || `${AGENT_DIR}/conversations`;
