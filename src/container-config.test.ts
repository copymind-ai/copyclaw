/**
 * Tests for the McpServerConfig union shape — make sure HTTP and SSE
 * server configs survive the DB → materialized JSON round-trip.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import {
  createContainerConfig,
  updateContainerConfigJson,
} from './db/container-configs.js';
import { configFromDb, materializeContainerJson } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';

// vi.hoisted so the value is available inside the hoisted vi.mock factory below.
const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: '/tmp/nanoclaw-test-container-config' }));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
  };
});

function now() {
  return new Date().toISOString();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(`${TEST_DIR}/groups/test-group`, { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({
    id: 'ag-1',
    name: 'Test Group',
    folder: 'test-group',
    agent_provider: null,
    created_at: now(),
  });

  createContainerConfig({
    agent_group_id: 'ag-1',
    provider: null,
    model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: '"all"',
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    additional_mounts: '[]',
    cli_scope: null,
    updated_at: now(),
  } as never);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('container-config McpServerConfig union', () => {
  it('stdio shape (legacy, no type field) round-trips through configFromDb', () => {
    updateContainerConfigJson('ag-1', 'mcp_servers', {
      legacy: {
        command: 'bun',
        args: ['run', '/app/foo.ts'],
        env: { FOO: 'bar' },
      },
    });

    const row = getContainerConfig('ag-1');
    expect(row).toBeDefined();
    const config = configFromDb(row!, getAgentGroup('ag-1')!);

    expect(config.mcpServers.legacy).toEqual({
      command: 'bun',
      args: ['run', '/app/foo.ts'],
      env: { FOO: 'bar' },
    });
  });

  it('http shape round-trips through configFromDb', () => {
    updateContainerConfigJson('ag-1', 'mcp_servers', {
      'copymind-support': {
        type: 'http',
        url: 'https://app.copymind.com/api/support/streamable-http',
        headers: { Authorization: 'Bearer ${SUPPORT_AGENT_API_KEY}' },
      },
    });

    const row = getContainerConfig('ag-1');
    const config = configFromDb(row!, getAgentGroup('ag-1')!);

    expect(config.mcpServers['copymind-support']).toEqual({
      type: 'http',
      url: 'https://app.copymind.com/api/support/streamable-http',
      headers: { Authorization: 'Bearer ${SUPPORT_AGENT_API_KEY}' },
    });
  });

  it('sse shape round-trips through configFromDb', () => {
    updateContainerConfigJson('ag-1', 'mcp_servers', {
      'sse-server': {
        type: 'sse',
        url: 'https://example.com/sse',
      },
    });

    const row = getContainerConfig('ag-1');
    const config = configFromDb(row!, getAgentGroup('ag-1')!);

    expect(config.mcpServers['sse-server']).toEqual({
      type: 'sse',
      url: 'https://example.com/sse',
    });
  });

  it('mixed shapes coexist in one mcp_servers JSON', () => {
    updateContainerConfigJson('ag-1', 'mcp_servers', {
      stdio_one: { command: 'bun', args: ['run', '/app/a.ts'], env: {} },
      http_one: {
        type: 'http',
        url: 'https://api.example.com/mcp',
        headers: { 'X-Custom': 'hello' },
      },
    });

    const row = getContainerConfig('ag-1');
    const config = configFromDb(row!, getAgentGroup('ag-1')!);

    expect(Object.keys(config.mcpServers).sort()).toEqual(['http_one', 'stdio_one']);
    expect('command' in config.mcpServers.stdio_one).toBe(true);
    expect('url' in config.mcpServers.http_one).toBe(true);
  });

  it('materializeContainerJson writes the union shape to disk verbatim', () => {
    updateContainerConfigJson('ag-1', 'mcp_servers', {
      'copymind-support': {
        type: 'http',
        url: 'https://app.copymind.com/api/support/streamable-http',
        headers: { Authorization: 'Bearer ${SUPPORT_AGENT_API_KEY}' },
      },
    });

    const config = materializeContainerJson('ag-1');
    const filePath = path.join(TEST_DIR, 'groups/test-group/container.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(onDisk.mcpServers['copymind-support']).toEqual({
      type: 'http',
      url: 'https://app.copymind.com/api/support/streamable-http',
      headers: { Authorization: 'Bearer ${SUPPORT_AGENT_API_KEY}' },
    });
    expect(config.mcpServers['copymind-support']).toEqual(onDisk.mcpServers['copymind-support']);
  });
});
