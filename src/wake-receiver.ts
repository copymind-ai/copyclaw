/**
 * Wake-webhook receiver — internal HTTP endpoint for waking a headless
 * agent group from outside the host.
 *
 * Used by copymind-app's CopyClawClient to fire a wake when a new
 * support_mention lands; the issues-agent picks it up and processes it.
 *
 * Route: POST /wake/<agent_group_id>
 *   - Header: X-Webhook-Secret (must match WAKE_WEBHOOK_SECRET)
 *   - Body: { "issue_id": string, "mention_id": string | null }
 *   - Returns 202 on success, 401 on bad secret, 400 on bad body,
 *     404 on wrong path or unknown agent group.
 *
 * On success we resolve the agent-shared session for the group, write a
 * `system`-kind message with `trigger: 1` into inbound.db, and call
 * wakeContainer(). The container's agent-runner sees the message on its
 * next poll and processes it per the group's CLAUDE.local.md.
 *
 * Bind interface: 127.0.0.1 only. cloudflared reaches us via localhost,
 * so there's no reason to expose this port externally — defense in depth.
 *
 * Disabled when WAKE_WEBHOOK_SECRET is unset (logged at startup).
 */
import crypto from 'crypto';
import http from 'http';

import { WAKE_RECEIVER_PORT, WAKE_WEBHOOK_SECRET } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getSession } from './db/sessions.js';
import { wakeContainer } from './container-runner.js';
import { log } from './log.js';
import { refreshRepoMounts } from './repo-refresh.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';

let server: http.Server | null = null;

export function startWakeReceiver(): void {
  if (server) return;
  if (!WAKE_WEBHOOK_SECRET) {
    log.warn('[wake-receiver] WAKE_WEBHOOK_SECRET not set — receiver disabled');
    return;
  }

  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log.error('[wake-receiver] unhandled error', { err });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    });
  });

  server.listen(WAKE_RECEIVER_PORT, '127.0.0.1', () => {
    log.info('[wake-receiver] listening', { port: WAKE_RECEIVER_PORT });
  });
}

export async function stopWakeReceiver(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  log.info('[wake-receiver] stopped');
}

export async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url || '/';

  // POST /wake/<agent_group_id>
  const match = url.match(/^\/wake\/([^/?]+)$/);
  if (req.method !== 'POST' || !match) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const agentGroupId = match[1];

  if (!validateSecret(req)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
    return;
  }

  const body = await readBody(req);
  let payload: { issue_id?: unknown; mention_id?: unknown };
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid JSON');
    return;
  }

  const issueId = payload.issue_id;
  if (typeof issueId !== 'string' || issueId.length === 0) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing issue_id');
    return;
  }
  const mentionId = typeof payload.mention_id === 'string' ? payload.mention_id : null;

  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) {
    log.warn('[wake-receiver] unknown agent group', { agentGroupId });
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Unknown agent group');
    return;
  }

  // Pull all git-backed additional_mounts to remote HEAD before the agent
  // sees the new message — guarantees the agent always grep's fresh source.
  await refreshRepoMounts(agentGroupId);
  await dispatchWake(agentGroupId, { issueId, mentionId });

  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, queued: true }));
}

async function dispatchWake(
  agentGroupId: string,
  payload: { issueId: string; mentionId: string | null },
): Promise<void> {
  const { session, created } = resolveSession(agentGroupId, null, null, 'agent-shared');

  const messageId = `wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Use kind:'webhook' (not 'system' — that's reserved for MCP tool responses
  // and is filtered out by the agent-runner's poll loop). The formatter
  // renders this as <webhook source="..." event="...">payload</webhook>.
  writeSessionMessage(agentGroupId, session.id, {
    id: messageId,
    kind: 'webhook',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      source: 'copymind-app',
      event: 'support_mention',
      payload: {
        issue_id: payload.issueId,
        mention_id: payload.mentionId,
      },
    }),
    trigger: 1,
  });

  log.info('[wake-receiver] dispatched wake', {
    agentGroupId,
    sessionId: session.id,
    sessionCreated: created,
    issueId: payload.issueId,
    mentionId: payload.mentionId,
  });

  // Refetch in case of any concurrent state changes between resolve and wake.
  const fresh = getSession(session.id);
  if (fresh) {
    await wakeContainer(fresh);
  }
}

function validateSecret(req: http.IncomingMessage): boolean {
  const header = req.headers['x-webhook-secret'];
  const provided = typeof header === 'string' ? header : '';
  const expected = WAKE_WEBHOOK_SECRET || '';
  if (provided.length === 0 || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided, 'utf-8'), Buffer.from(expected, 'utf-8'));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
