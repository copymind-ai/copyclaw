/**
 * Unit tests for the wake-receiver request handler.
 *
 * Tests the handler logic in isolation: path matching, secret validation,
 * body parsing, agent-group lookup, and the dispatch into session-manager
 * + container-runner. The http.Server itself isn't tested — that's trivial
 * http.createServer wiring.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { inboundDbPath } from './session-manager.js';
import type { Session } from './types.js';

// Hoisted constants — referenced inside vi.mock factories below.
const { TEST_DIR, TEST_SECRET, mockWakeContainer } = vi.hoisted(() => ({
  TEST_DIR: '/tmp/nanoclaw-test-wake-receiver',
  TEST_SECRET: 'test-secret-do-not-use-in-prod',
  mockWakeContainer: vi.fn(),
}));

// Mock container runner to prevent actual Docker spawning.
vi.mock('./container-runner.js', () => ({
  wakeContainer: (s: unknown) => mockWakeContainer(s),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override config for tests.
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    WAKE_WEBHOOK_SECRET: TEST_SECRET,
    WAKE_RECEIVER_PORT: 0,
  };
});

// Imported after the mocks so they take effect.
import { handleRequest } from './wake-receiver.js';

const AGENT_GROUP_ID = 'ag-issues-agent-1';

function now() {
  return new Date().toISOString();
}

function makeReq(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): import('http').IncomingMessage {
  const stream = Readable.from(opts.body ? [Buffer.from(opts.body, 'utf-8')] : []);
  const req = stream as unknown as import('http').IncomingMessage & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = opts.method;
  req.url = opts.url;
  req.headers = opts.headers ?? {};
  return req;
}

function makeRes(): {
  res: import('http').ServerResponse;
  statusCode: () => number;
  body: () => string;
  headers: () => Record<string, string>;
} {
  let statusCode = 0;
  let body = '';
  let headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    writeHead: (code: number, hs?: Record<string, string>) => {
      statusCode = code;
      if (hs) headers = hs;
    },
    end: (data?: string) => {
      if (data) body = data;
    },
  } as unknown as import('http').ServerResponse;
  return {
    res,
    statusCode: () => statusCode,
    body: () => body,
    headers: () => headers,
  };
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  mockWakeContainer.mockReset();
  mockWakeContainer.mockResolvedValue(true);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('wake-receiver handleRequest', () => {
  it('returns 404 on a non-POST method', async () => {
    const r = makeRes();
    await handleRequest(
      makeReq({
        method: 'GET',
        url: `/wake/${AGENT_GROUP_ID}`,
        headers: { 'x-webhook-secret': TEST_SECRET },
      }),
      r.res,
    );
    expect(r.statusCode()).toBe(404);
    expect(mockWakeContainer).not.toHaveBeenCalled();
  });

  it('returns 404 on the wrong path', async () => {
    const r = makeRes();
    await handleRequest(
      makeReq({
        method: 'POST',
        url: '/not-wake/something',
        headers: { 'x-webhook-secret': TEST_SECRET },
      }),
      r.res,
    );
    expect(r.statusCode()).toBe(404);
  });

  it('returns 401 when X-Webhook-Secret is missing', async () => {
    const r = makeRes();
    await handleRequest(makeReq({ method: 'POST', url: `/wake/${AGENT_GROUP_ID}`, body: '{"issue_id":"i1"}' }), r.res);
    expect(r.statusCode()).toBe(401);
    expect(mockWakeContainer).not.toHaveBeenCalled();
  });

  it('returns 401 when X-Webhook-Secret is wrong', async () => {
    const r = makeRes();
    await handleRequest(
      makeReq({
        method: 'POST',
        url: `/wake/${AGENT_GROUP_ID}`,
        headers: { 'x-webhook-secret': 'wrong-secret' },
        body: '{"issue_id":"i1"}',
      }),
      r.res,
    );
    expect(r.statusCode()).toBe(401);
    expect(mockWakeContainer).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON body', async () => {
    const r = makeRes();
    await handleRequest(
      makeReq({
        method: 'POST',
        url: `/wake/${AGENT_GROUP_ID}`,
        headers: { 'x-webhook-secret': TEST_SECRET },
        body: 'not json',
      }),
      r.res,
    );
    expect(r.statusCode()).toBe(400);
    expect(r.body()).toContain('JSON');
    expect(mockWakeContainer).not.toHaveBeenCalled();
  });

  it('returns 400 when issue_id is missing', async () => {
    const r = makeRes();
    await handleRequest(
      makeReq({
        method: 'POST',
        url: `/wake/${AGENT_GROUP_ID}`,
        headers: { 'x-webhook-secret': TEST_SECRET },
        body: '{"mention_id":"m1"}',
      }),
      r.res,
    );
    expect(r.statusCode()).toBe(400);
    expect(r.body()).toMatch(/issue_id/);
    expect(mockWakeContainer).not.toHaveBeenCalled();
  });

  it('returns 404 when the agent group does not exist', async () => {
    const r = makeRes();
    await handleRequest(
      makeReq({
        method: 'POST',
        url: '/wake/ag-missing',
        headers: { 'x-webhook-secret': TEST_SECRET },
        body: '{"issue_id":"i1","mention_id":"m1"}',
      }),
      r.res,
    );
    expect(r.statusCode()).toBe(404);
    expect(mockWakeContainer).not.toHaveBeenCalled();
  });

  it('returns 202 on happy path, writes message, wakes container', async () => {
    createAgentGroup({
      id: AGENT_GROUP_ID,
      name: 'Issues Agent',
      folder: 'issues-agent',
      agent_provider: null,
      created_at: now(),
    });

    const r = makeRes();
    await handleRequest(
      makeReq({
        method: 'POST',
        url: `/wake/${AGENT_GROUP_ID}`,
        headers: { 'x-webhook-secret': TEST_SECRET },
        body: '{"issue_id":"issue-uuid","mention_id":"mention-uuid"}',
      }),
      r.res,
    );

    expect(r.statusCode()).toBe(202);
    expect(JSON.parse(r.body()).ok).toBe(true);

    // wakeContainer called with a Session for our agent group
    expect(mockWakeContainer).toHaveBeenCalledTimes(1);
    const sessionArg = mockWakeContainer.mock.calls[0][0] as Session;
    expect(sessionArg.agent_group_id).toBe(AGENT_GROUP_ID);

    // Wake message landed in inbound.db
    const inPath = inboundDbPath(AGENT_GROUP_ID, sessionArg.id);
    expect(fs.existsSync(inPath)).toBe(true);
    const db = new Database(inPath);
    const row = db.prepare('SELECT id, kind, content, trigger FROM messages_in ORDER BY seq DESC LIMIT 1').get() as {
      id: string;
      kind: string;
      content: string;
      trigger: number;
    };
    db.close();

    expect(row.kind).toBe('webhook');
    expect(row.trigger).toBe(1);
    const parsed = JSON.parse(row.content);
    expect(parsed).toEqual({
      source: 'copymind-app',
      event: 'support_mention',
      payload: {
        issue_id: 'issue-uuid',
        mention_id: 'mention-uuid',
      },
    });
  });

  it('accepts null mention_id', async () => {
    createAgentGroup({
      id: AGENT_GROUP_ID,
      name: 'Issues Agent',
      folder: 'issues-agent',
      agent_provider: null,
      created_at: now(),
    });

    const r = makeRes();
    await handleRequest(
      makeReq({
        method: 'POST',
        url: `/wake/${AGENT_GROUP_ID}`,
        headers: { 'x-webhook-secret': TEST_SECRET },
        body: '{"issue_id":"issue-uuid","mention_id":null}',
      }),
      r.res,
    );

    expect(r.statusCode()).toBe(202);
    const sessionArg = mockWakeContainer.mock.calls[0][0] as Session;
    const db = new Database(inboundDbPath(AGENT_GROUP_ID, sessionArg.id));
    const row = db.prepare('SELECT content FROM messages_in ORDER BY seq DESC LIMIT 1').get() as { content: string };
    db.close();
    expect(JSON.parse(row.content).payload.mention_id).toBeNull();
  });

  it('reuses the agent-shared session across multiple wake events', async () => {
    createAgentGroup({
      id: AGENT_GROUP_ID,
      name: 'Issues Agent',
      folder: 'issues-agent',
      agent_provider: null,
      created_at: now(),
    });

    const r1 = makeRes();
    await handleRequest(
      makeReq({
        method: 'POST',
        url: `/wake/${AGENT_GROUP_ID}`,
        headers: { 'x-webhook-secret': TEST_SECRET },
        body: '{"issue_id":"i1","mention_id":"m1"}',
      }),
      r1.res,
    );
    const r2 = makeRes();
    await handleRequest(
      makeReq({
        method: 'POST',
        url: `/wake/${AGENT_GROUP_ID}`,
        headers: { 'x-webhook-secret': TEST_SECRET },
        body: '{"issue_id":"i2","mention_id":null}',
      }),
      r2.res,
    );

    const s1 = mockWakeContainer.mock.calls[0][0] as Session;
    const s2 = mockWakeContainer.mock.calls[1][0] as Session;
    expect(s1.id).toBe(s2.id); // agent-shared mode → one session

    // Both messages landed in the same inbound.db
    const db = new Database(inboundDbPath(AGENT_GROUP_ID, s1.id));
    const count = (db.prepare('SELECT COUNT(*) AS c FROM messages_in').get() as { c: number }).c;
    db.close();
    expect(count).toBe(2);
  });
});
