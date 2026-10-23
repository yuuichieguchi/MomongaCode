import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, type ListChangedHandlers } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import {
  killPidsForCleanup,
  LEGACY_FIXTURE_PROTOCOL_VERSION,
  LEGACY_FIXTURE_TOOL_NAMES,
  MCP_LEGACY_SERVER_PATH,
  MCP_MODERN_SERVER_PATH,
  MODERN_FIXTURE_GRANDCHILD_ENV,
  MODERN_FIXTURE_IMAGE_BYTES,
  MODERN_FIXTURE_PROTOCOL_VERSION,
  MODERN_FIXTURE_RECORD_ENV,
  MODERN_FIXTURE_TOOL_NAMES,
  type ModernFixtureRecord,
} from '@momonga/testkit';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const makeRecordFile = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-mcp-fixture-'));
  const file = path.join(dir, 'record.jsonl');
  cleanups.push(() => {
    for (const entry of readRecords(file)) {
      if (entry.type === 'grandchild' && entry.pid > 1 && pidAlive(entry.pid)) killPidsForCleanup([entry.pid]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return file;
};

const readRecords = (file: string): ModernFixtureRecord[] => {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ModernFixtureRecord);
};

const waitForRecord = async (file: string, predicate: (entry: ModernFixtureRecord) => boolean): Promise<ModernFixtureRecord> => {
  const deadline = Date.now() + 10000;
  for (;;) {
    const found = readRecords(file).find(predicate);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`record not observed in ${file}: ${fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const connect = async (
  serverPath: string,
  env: Record<string, string>,
  mode: 'auto' | 'legacy' = 'auto',
  listChanged?: ListChangedHandlers,
): Promise<{ client: Client; transport: StdioClientTransport }> => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'ignore' });
  const client = new Client({ name: 'fixture-smoke', version: '1.0.0' }, {
    versionNegotiation: { mode },
    ...(listChanged === undefined ? {} : { listChanged }),
  });
  cleanups.push(() => client.close());
  await client.connect(transport);
  return { client, transport };
};

const textOf = (result: { content?: unknown }): string =>
  (result.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

describe('mcp-modern-server fixture over the SDK StdioClientTransport', () => {
  it('negotiates 2026-07-28 in the modern era and reports its server info', async () => {
    const { client } = await connect(MCP_MODERN_SERVER_PATH, { [MODERN_FIXTURE_RECORD_ENV]: makeRecordFile() });
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_FIXTURE_PROTOCOL_VERSION);
    expect(MODERN_FIXTURE_PROTOCOL_VERSION).toBe('2026-07-28');
    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getServerVersion()).toEqual({ name: 'momonga-modern-fixture', version: '1.0.0' });
  });

  it('lists every tool across three pages', async () => {
    const recordFile = makeRecordFile();
    const { client } = await connect(MCP_MODERN_SERVER_PATH, { [MODERN_FIXTURE_RECORD_ENV]: recordFile });
    const names: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor });
      names.push(...page.tools.map((tool) => tool.name));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(names).toEqual([...MODERN_FIXTURE_TOOL_NAMES]);
    const cursors = readRecords(recordFile)
      .filter((entry) => entry.type === 'list')
      .map((entry) => (entry.type === 'list' ? entry.cursor : undefined));
    expect(cursors).toEqual([null, '6', '12']);
  });

  it('exposes annotations and the draft-07 schema as given', async () => {
    const { client } = await connect(MCP_MODERN_SERVER_PATH, { [MODERN_FIXTURE_RECORD_ENV]: makeRecordFile() });
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === 'read_only')?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find((tool) => tool.name === 'draft07')?.inputSchema['$schema']).toBe('http://json-schema.org/draft-07/schema#');
  });

  it('calls echo, add, fail, image and structured with the specified results', async () => {
    const { client } = await connect(MCP_MODERN_SERVER_PATH, { [MODERN_FIXTURE_RECORD_ENV]: makeRecordFile() });
    expect(textOf(await client.callTool({ name: 'echo', arguments: { text: 'hello' } }))).toBe('hello');
    expect(textOf(await client.callTool({ name: 'add', arguments: { a: 2, b: 40 } }))).toBe('42');
    const failed = await client.callTool({ name: 'fail', arguments: {} });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toBe('fixture failure');
    const image = await client.callTool({ name: 'image', arguments: {} });
    expect(image.content).toEqual([
      { type: 'image', mimeType: 'image/png', data: Buffer.from(MODERN_FIXTURE_IMAGE_BYTES).toString('base64') },
    ]);
    const structured = await client.callTool({ name: 'structured', arguments: {} });
    expect(structured.content).toEqual([]);
    expect(structured.structuredContent).toEqual({ answer: 42, label: 'forty-two' });
    expect(textOf(await client.callTool({ name: 'dotted.name/with-slash', arguments: {} }))).toBe('dotted');
  });

  it('records the received _meta traceparent', async () => {
    const recordFile = makeRecordFile();
    const { client } = await connect(MCP_MODERN_SERVER_PATH, { [MODERN_FIXTURE_RECORD_ENV]: recordFile });
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    await client.callTool({ name: 'echo', arguments: { text: 'x' }, _meta: { traceparent } });
    const call = readRecords(recordFile).find((entry) => entry.type === 'call' && entry.tool === 'echo');
    expect(call?.type === 'call' ? call.meta : undefined).toEqual({ traceparent });
  });

  it('records a cancellation of slow when the caller aborts', async () => {
    const recordFile = makeRecordFile();
    const { client } = await connect(MCP_MODERN_SERVER_PATH, { [MODERN_FIXTURE_RECORD_ENV]: recordFile });
    const controller = new AbortController();
    const pending = client.callTool({ name: 'slow', arguments: {} }, { signal: controller.signal });
    const settled = pending.then(
      () => 'resolved',
      () => 'rejected',
    );
    await waitForRecord(recordFile, (entry) => entry.type === 'call' && entry.tool === 'slow');
    controller.abort();
    expect(await settled).toBe('rejected');
    const cancelled = await waitForRecord(recordFile, (entry) => entry.type === 'cancelled');
    expect(cancelled).toMatchObject({ type: 'cancelled', tool: 'slow' });
  });

  it('adds a tool after trigger_list_changed and notifies a client listChanged handler', async () => {
    let changed: string[] | undefined;
    const { client } = await connect(MCP_MODERN_SERVER_PATH, { [MODERN_FIXTURE_RECORD_ENV]: makeRecordFile() }, 'auto', {
      tools: {
        onChanged: (error, tools) => {
          if (error === null && tools !== null) changed = tools.map((tool) => tool.name);
        },
      },
    });
    await client.listTools();
    await client.callTool({ name: 'trigger_list_changed', arguments: {} });
    const deadline = Date.now() + 10000;
    while (changed === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(changed).toEqual([...MODERN_FIXTURE_TOOL_NAMES, 'added_later']);
    expect(textOf(await client.callTool({ name: 'added_later', arguments: {} }))).toBe('added later');
  });

  it('exits mid-call on crash, closing the connection', async () => {
    const { client, transport } = await connect(MCP_MODERN_SERVER_PATH, { [MODERN_FIXTURE_RECORD_ENV]: makeRecordFile() });
    const closed = new Promise<void>((resolve) => {
      const previous = transport.onclose;
      transport.onclose = () => {
        previous?.();
        resolve();
      };
    });
    await expect(client.callTool({ name: 'crash', arguments: { code: 7 } })).rejects.toThrow();
    await closed;
  });

  it('spawns a sleep grandchild when asked and records its pid', async () => {
    const recordFile = makeRecordFile();
    await connect(MCP_MODERN_SERVER_PATH, { [MODERN_FIXTURE_RECORD_ENV]: recordFile, [MODERN_FIXTURE_GRANDCHILD_ENV]: '1' });
    const grandchild = await waitForRecord(recordFile, (entry) => entry.type === 'grandchild');
    expect(grandchild.type === 'grandchild' && grandchild.pid > 1 && pidAlive(grandchild.pid)).toBe(true);
  });

  it('rejects a 2025-era client', async () => {
    await expect(connect(MCP_MODERN_SERVER_PATH, { [MODERN_FIXTURE_RECORD_ENV]: makeRecordFile() }, 'legacy')).rejects.toThrow(
      /Unsupported protocol version/,
    );
  });
});

describe('mcp-legacy-server fixture over the SDK StdioClientTransport', () => {
  it('negotiates 2025-11-25 in the legacy era even when the client probes for modern', async () => {
    const { client } = await connect(MCP_LEGACY_SERVER_PATH, {});
    expect(client.getNegotiatedProtocolVersion()).toBe(LEGACY_FIXTURE_PROTOCOL_VERSION);
    expect(LEGACY_FIXTURE_PROTOCOL_VERSION).toBe('2025-11-25');
    expect(client.getProtocolEra()).toBe('legacy');
    expect(client.getServerVersion()).toEqual({ name: 'momonga-legacy-fixture', version: '1.0.0' });
  });

  it('lists and calls its tools', async () => {
    const { client } = await connect(MCP_LEGACY_SERVER_PATH, {}, 'legacy');
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...LEGACY_FIXTURE_TOOL_NAMES]);
    expect(textOf(await client.callTool({ name: 'echo', arguments: { text: 'legacy' } }))).toBe('legacy');
    expect(textOf(await client.callTool({ name: 'add', arguments: { a: 1, b: 2 } }))).toBe('3');
    const unknown = await client.callTool({ name: 'missing', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toBe('unknown tool missing');
  });

  it('does not import the MCP SDK', () => {
    expect(fs.readFileSync(MCP_LEGACY_SERVER_PATH, 'utf8')).not.toMatch(/@modelcontextprotocol/);
  });
});
