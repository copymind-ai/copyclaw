import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'TZ',
  'WAKE_WEBHOOK_SECRET',
  'WAKE_RECEIVER_PORT',
  'SUPABASE_APP_PG_REF',
  'SUPABASE_APP_PG_USR',
  'SUPABASE_APP_PG_PWD',
  'LOCAL_DEV_APP_URL',
  'LOCAL_DEV_PG_URL',
]);

// Assemble the read-only Supabase Postgres URL once at startup from the three
// .env components, so the agent container only ever sees the final connection
// string. Undefined when any component is missing — psql in the container
// will then fail clearly if the agent tries to query.
const _pgRef = envConfig.SUPABASE_APP_PG_REF;
const _pgUsr = envConfig.SUPABASE_APP_PG_USR;
const _pgPwd = envConfig.SUPABASE_APP_PG_PWD;
export const SUPPORT_PG_URL: string | undefined =
  _pgRef && _pgUsr && _pgPwd
    ? `postgresql://${_pgUsr}:${encodeURIComponent(_pgPwd)}@db.${_pgRef}.supabase.co:5432/postgres?sslmode=require`
    : undefined;

// Long-lived local dev stack on the droplet host. The Next.js app runs as a
// Docker compose service on a port allocated by `dev wt up main`; Postgres
// is the local Supabase shipped with the `supabase` CLI worktree.
// Both forwarded into the agent container as env vars so the agent can visit
// the app (via agent-browser) and write to the local DB (via psql) without
// touching prod.
export const LOCAL_DEV_APP_URL: string | undefined = envConfig.LOCAL_DEV_APP_URL || undefined;
export const LOCAL_DEV_PG_URL: string | undefined = envConfig.LOCAL_DEV_PG_URL || undefined;

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Per-checkout image tag so two installs on the same host don't share
// `nanoclaw-agent:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);

// Wake-webhook receiver — external trigger that wakes a headless agent group
// (e.g. bug-triage) via POST /wake/<agent_group_id> with X-Webhook-Secret.
// Unset secret disables the receiver entirely.
export const WAKE_WEBHOOK_SECRET = process.env.WAKE_WEBHOOK_SECRET || envConfig.WAKE_WEBHOOK_SECRET;
export const WAKE_RECEIVER_PORT = parseInt(
  process.env.WAKE_RECEIVER_PORT || envConfig.WAKE_RECEIVER_PORT || '5713',
  10,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
