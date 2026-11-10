import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { holderGroups } from '@momonga/foundation';
import { MCP_MODERN_SERVER_PATH, MODERN_FIXTURE_GRANDCHILD_ENV, MODERN_FIXTURE_RECORD_ENV, MODERN_FIXTURE_STDERR_ENV, REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import {
  entry,
  groupExists,
  legacyConfig,
  makeDir,
  makeExecutor,
  makePool,
  makeRecordFile,
  modernConfig,
  onCleanup,
  readRecords,
  waitForRecord,
  waitUntil,
} from './mcp-harness.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const makeLauncher = (recordFile: string) => {
  const dir = makeDir();
  const script = path.join(dir, 'launch-modern.sh');
  const counter = path.join(dir, 'launches.txt');
  const write = (body: string): void => {
    fs.writeFileSync(script, `#!/bin/sh\necho launch >> '${counter}'\n${body}\n`, { mode: 0o755 });
  };
  const healthy = (): void => write(`exec '${process.execPath}' '${MCP_MODERN_SERVER_PATH}'`);
  const broken = (): void => write('exit 1');
  const launches = (): number => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').split('\n').filter((line) => line !== '').length : 0);
  healthy();
  return { config: { command: script, env: { [MODERN_FIXTURE_RECORD_ENV]: recordFile } }, healthy, broken, launches };
};

describe('createMcpPool sources', () => {
  it('creates one source per server named mcp__<server>', () => {
    const harness = makePool([entry('modern', modernConfig(makeRecordFile())), entry('legacy', legacyConfig())]);
    expect(harness.pool.sources.map((source) => source.id)).toEqual(['mcp__modern', 'mcp__legacy']);
  });

  it('turns a failing server into a registry notice without affecting the others', async () => {
    const harness = makePool([
      entry('broken', { command: '/nonexistent/momonga-mcp-server' }),
      entry('modern', modernConfig(makeRecordFile())),
      entry('legacy', legacyConfig()),
    ]);
    const set = await harness.snapshot();
    const brokenNotices = set.notices.filter((notice) => notice.startsWith('Tool source "mcp__broken" failed to list tools: '));
    expect(brokenNotices).toHaveLength(1);
    expect(set.get('mcp__modern__echo')?.name).toBe('mcp__modern__echo');
    expect(set.get('mcp__legacy__echo')?.name).toBe('mcp__legacy__echo');
    const broken = harness.pool.diagnostics().find((diagnostics) => diagnostics.server === 'broken');
    expect(broken?.lastError).toContain('/nonexistent/momonga-mcp-server');
  });

  it('reports a remote server config without a credential store as a notice and never connects to it', async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    onCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as net.AddressInfo;
    const harness = makePool([entry('remote', { type: 'http', url: `http://127.0.0.1:${port}/mcp` }), entry('legacy', legacyConfig())]);
    const set = await harness.snapshot();
    const remoteNotices = set.notices.filter((notice) => notice.startsWith('Tool source "mcp__remote" failed to list tools: '));
    expect(remoteNotices).toHaveLength(1);
    expect(remoteNotices[0]).toMatch(/no credential store/i);
    expect(set.get('mcp__legacy__add')?.name).toBe('mcp__legacy__add');
    expect(connections).toBe(0);
  });
});

describe('createMcpPool diagnostics and close', () => {
  it('reports idle before the first listing and connected details after it', async () => {
    const harness = makePool([entry('modern', modernConfig(makeRecordFile())), entry('legacy', legacyConfig())]);
    expect(harness.pool.diagnostics()).toEqual([
      { server: 'modern', state: 'idle', pgid: undefined, protocolVersion: undefined, lastError: null, stderrTail: '' },
      { server: 'legacy', state: 'idle', pgid: undefined, protocolVersion: undefined, lastError: null, stderrTail: '' },
    ]);
    await harness.snapshot();
    const [modern, legacy] = harness.pool.diagnostics();
    expect(modern).toMatchObject({ server: 'modern', state: 'connected', protocolVersion: '2026-07-28', lastError: null });
    expect(legacy).toMatchObject({ server: 'legacy', state: 'connected', protocolVersion: '2025-11-25', lastError: null });
    expect(await groupExists(modern?.pgid as number)).toBe(true);
    expect(await groupExists(legacy?.pgid as number)).toBe(true);
    expect(modern?.pgid).not.toBe(legacy?.pgid);
  });

  it('captures server stderr in diagnostics and never in tool output', async () => {
    const marker = 'fixture-stderr-marker-line';
    const harness = makePool([entry('modern', modernConfig(makeRecordFile(), { [MODERN_FIXTURE_STDERR_ENV]: marker }))]);
    const set = await harness.snapshot();
    const result = await makeExecutor().resultOf(set, 'mcp__modern__echo', { text: 'hello' });
    expect(result.output).toBe('hello');
    expect(JSON.stringify(result)).not.toContain(marker);
    await waitUntil(() => (harness.pool.diagnostics()[0]?.stderrTail ?? '').includes(marker), 'stderr tail contains the marker');
  });

  it('close reaps every server process group including the fixture grandchild', async () => {
    const recordFile = makeRecordFile();
    const harness = makePool([entry('modern', modernConfig(recordFile, { [MODERN_FIXTURE_GRANDCHILD_ENV]: '1' })), entry('legacy', legacyConfig())]);
    await harness.snapshot();
    const grandchild = await waitForRecord(recordFile, (record) => record.type === 'grandchild');
    const grandchildPid = grandchild.type === 'grandchild' ? grandchild.pid : -1;
    expect(grandchildPid).toBeGreaterThan(1);
    const pgids = harness.pool.diagnostics().map((diagnostics) => diagnostics.pgid as number);
    const [grandchildGroup] = await holderGroups([grandchildPid], pgids, { signal: new AbortController().signal });
    expect(pgids).toContain(grandchildGroup);
    await harness.pool.close();
    for (const pgid of pgids) expect(await groupExists(pgid)).toBe(false);
    expect(harness.pool.diagnostics().map((diagnostics) => diagnostics.state)).toEqual(['closed', 'closed']);
  });
});

describe('createMcpPool crash and reconnect', () => {
  it('reports a crash naming the server and exit code, then reconnects on the next call', async () => {
    const recordFile = makeRecordFile();
    const harness = makePool([entry('modern', modernConfig(recordFile))]);
    const set = await harness.snapshot();
    const executor = makeExecutor();
    const crashed = await executor.resultOf(set, 'mcp__modern__crash', { code: 3 });
    expect(crashed.status).toBe('failed');
    expect(crashed.output.startsWith('MCP server "modern" failed: ')).toBe(true);
    expect(crashed.output).toMatch(/code 3/);
    const afterCrash = harness.pool.diagnostics()[0];
    expect(afterCrash?.state).toBe('disconnected');
    expect(afterCrash?.lastError).toMatch(/code 3/);
    const echoed = await executor.resultOf(set, 'mcp__modern__echo', { text: 'again' });
    expect(echoed.output).toBe('again');
    expect(readRecords(recordFile).filter((record) => record.type === 'ready')).toHaveLength(2);
    expect(harness.pool.diagnostics()[0]?.state).toBe('connected');
  });

  it('gives up after three failed reconnects, fails fast while open, and recovers after resetAfterMs', async () => {
    const recordFile = makeRecordFile();
    const launcher = makeLauncher(recordFile);
    const harness = makePool([entry('modern', launcher.config)]);
    const set = await harness.snapshot();
    const executor = makeExecutor();
    expect((await executor.resultOf(set, 'mcp__modern__echo', { text: 'first' })).output).toBe('first');
    expect(launcher.launches()).toBe(1);

    launcher.broken();
    expect((await executor.resultOf(set, 'mcp__modern__crash', { code: 3 })).status).toBe('failed');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await executor.resultOf(set, 'mcp__modern__echo', { text: 'retry' });
      expect(failed.status).toBe('failed');
      expect(failed.output.startsWith('MCP server "modern" ')).toBe(true);
    }
    expect(launcher.launches()).toBe(4);

    const fastFailed = await executor.resultOf(set, 'mcp__modern__echo', { text: 'open' });
    expect(fastFailed.status).toBe('failed');
    expect(fastFailed.output.startsWith('MCP server "modern" is unavailable: ')).toBe(true);
    expect(fastFailed.output.length).toBeGreaterThan('MCP server "modern" is unavailable: '.length);
    expect(launcher.launches()).toBe(4);
    expect(harness.pool.diagnostics()[0]?.state).toBe('unavailable');

    harness.clock.advance(59_999);
    expect((await executor.resultOf(set, 'mcp__modern__echo', { text: 'still open' })).output.startsWith('MCP server "modern" is unavailable: ')).toBe(true);
    expect(launcher.launches()).toBe(4);

    launcher.healthy();
    harness.clock.advance(1);
    expect((await executor.resultOf(set, 'mcp__modern__echo', { text: 'recovered' })).output).toBe('recovered');
    expect(launcher.launches()).toBe(5);
    expect(harness.pool.diagnostics()[0]?.state).toBe('connected');
  });
});
