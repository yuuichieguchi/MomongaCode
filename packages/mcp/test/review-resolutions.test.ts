import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import type { McpStdioServerConfig } from '@momonga/config';
import {
  FIXTURE_EXTRA_TOOLS_ENV,
  FIXTURE_HOSTILE_TITLE,
  MCP_MODERN_SERVER_PATH,
  MODERN_FIXTURE_RECORD_ENV,
  REAL_PROCESS_TEST_TIMEOUT_MS,
  killPidsForCleanup,
  nestedNotSchema,
} from '@momonga/testkit';
import {
  callRecords,
  entry,
  legacyConfig,
  makeDir,
  makeExecutor,
  makePool,
  makeRecordFile,
  modernConfig,
  onCleanup,
  pidAlive,
  readRecords,
  waitUntil,
} from './mcp-harness.ts';

const hash8 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 8);

const extras = (...names: string[]): Record<string, string> => ({ [FIXTURE_EXTRA_TOOLS_ENV]: names.join(',') });

const turns = async (count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

const makeLauncher = (body: (counter: string) => string) => {
  const dir = makeDir();
  const script = path.join(dir, 'launch.sh');
  const counter = path.join(dir, 'launches.txt');
  fs.writeFileSync(script, `#!/bin/sh\necho $$ >> '${counter}'\n${body(counter)}\n`, { mode: 0o755 });
  const pids = (): number[] =>
    fs.existsSync(counter)
      ? fs
          .readFileSync(counter, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map(Number)
      : [];
  return { config: { command: script } satisfies McpStdioServerConfig, pids };
};

describe('schemas carrying $id across re-listing', () => {
  it('keeps a modern tool with $id input and output schemas across list_changed re-lists and still calls it', async () => {
    const recordFile = makeRecordFile();
    const harness = makePool([entry('modern', modernConfig(recordFile, extras('with_id')))]);
    const executor = makeExecutor();
    const first = await harness.snapshot();
    expect(first.get('mcp__modern__with_id')?.name).toBe('mcp__modern__with_id');
    await executor.resultOf(first, 'mcp__modern__trigger_list_changed', {});
    const second = await harness.snapshot();
    await executor.resultOf(second, 'mcp__modern__trigger_list_changed', {});
    const third = await harness.snapshot();
    for (const set of [second, third]) {
      expect(set.get('mcp__modern__with_id')?.name).toBe('mcp__modern__with_id');
      expect(set.notices.filter((notice) => notice.includes('with_id'))).toEqual([]);
    }
    const result = await executor.resultOf(third, 'mcp__modern__with_id', { v: 'x' });
    expect(result).toMatchObject({ status: 'completed', output: '{"v":"x"}' });
  });

  it('keeps a legacy tool with $id schemas on every re-list and still calls it', async () => {
    const config = { ...legacyConfig(), env: extras('with_id') };
    const harness = makePool([entry('legacy', config)]);
    const executor = makeExecutor();
    let last;
    for (let round = 0; round < 3; round += 1) {
      last = await harness.snapshot();
      expect(last.get('mcp__legacy__with_id')?.name).toBe('mcp__legacy__with_id');
      expect(last.notices).toEqual([]);
      expect((await executor.resultOf(last, 'mcp__legacy__with_id', { v: `r${round}` })).output).toBe(`{"v":"r${round}"}`);
    }
  });
});

const LIST_MESSAGE_WRAPPING = 4;

const notChainAt = (messageDepth: number): string => `deep_not_${messageDepth - LIST_MESSAGE_WRAPPING}`;

const depthNoticesOf = (notices: readonly string[]): string[] => notices.filter((notice) => notice.includes('modern') && /depth/i.test(notice));

describe('a tools/list reply is measured as one message from its JSON-RPC root', () => {
  it('counts the message, result, tools array and tool as four levels around the input schema', () => {
    expect(JSON.stringify({ id: 1, result: { tools: [{ inputSchema: nestedNotSchema(1) }] } })).toBe('{"id":1,"result":{"tools":[{"inputSchema":{"type":"object"}}]}}');
  });

  it(`lists every tool when the reply is exactly ${MAX_JSON_DEPTH} deep`, async () => {
    const name = notChainAt(MAX_JSON_DEPTH);
    const set = await makePool([entry('modern', modernConfig(makeRecordFile(), extras(name)))]).snapshot();
    expect(set.get(`mcp__modern__${name}`)?.name).toBe(`mcp__modern__${name}`);
    expect(set.get('mcp__modern__echo')?.name).toBe('mcp__modern__echo');
    expect(depthNoticesOf(set.notices)).toEqual([]);
  });

  it.each([MAX_JSON_DEPTH + 1, 3000])('fails the whole listing when one schema makes the reply %i deep, with one notice naming the server and the depth', async (messageDepth) => {
    const name = notChainAt(messageDepth);
    const set = await makePool([entry('modern', modernConfig(makeRecordFile(), extras(name)))]).snapshot();
    expect(set.get(`mcp__modern__${name}`)).toBeUndefined();
    expect(set.get('mcp__modern__echo')).toBeUndefined();
    const notices = depthNoticesOf(set.notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(String(MAX_JSON_DEPTH));
  });
});

describe('server text sanitizing', () => {
  it('removes escape sequences, including OSC hyperlinks and an unterminated OSC, plus C1, bidi and zero-width characters from the description', async () => {
    const set = await makePool([entry('modern', modernConfig(makeRecordFile(), extras('hostile_title')))]).snapshot();
    expect(set.get('mcp__modern__hostile_title')?.description).toBe('DescC1isowjendemb\nkeep\ttab link tail!');
  });

  it('removes control, bidi and zero-width characters from the title, makes it one line and caps it at 200', async () => {
    const set = await makePool([entry('modern', modernConfig(makeRecordFile(), extras('hostile_title')))]).snapshot();
    const cleaned = `RedBoldC1BidiZeroBom Next Tab${'T'.repeat(300)}`;
    expect(FIXTURE_HOSTILE_TITLE.length).toBeGreaterThan(cleaned.length);
    const outcome = await makeExecutor().run(set, 'mcp__modern__hostile_title', {}, { rules: [] });
    expect(outcome?.kind).toBe('needs_approval');
    expect(outcome?.kind === 'needs_approval' ? outcome.title : undefined).toBe(`modern: ${cleaned.slice(0, 199)}…`);
  });
});

describe('server text sanitizing, 8-bit CSI, unterminated CSI and lone surrogates', () => {
  it('removes an 8-bit CSI and an unterminated trailing CSI and replaces a lone surrogate in the description', async () => {
    const set = await makePool([entry('modern', modernConfig(makeRecordFile(), extras('hostile_text_more')))]).snapshot();
    expect(set.get('mcp__modern__hostile_text_more')?.description).toBe('AB\ufffdC');
  });

  it('replaces a lone surrogate and removes an 8-bit CSI in the title', async () => {
    const set = await makePool([entry('modern', modernConfig(makeRecordFile(), extras('hostile_text_more')))]).snapshot();
    const outcome = await makeExecutor().run(set, 'mcp__modern__hostile_text_more', {}, { rules: [] });
    expect(outcome?.kind === 'needs_approval' ? outcome.title : undefined).toBe('modern: T\ufffdUV');
  });
});

describe('deterministic hashed names', () => {
  it('gives a.b, a/b and a_b three distinct names without collision notices', async () => {
    const recordFile = makeRecordFile();
    const set = await makePool([entry('modern', modernConfig(recordFile, extras('a.b', 'a/b', 'a_b')))]).snapshot();
    const dot = `mcp__modern__a_b_${hash8('a.b')}`;
    const slash = `mcp__modern__a_b_${hash8('a/b')}`;
    expect(set.tools.map((tool) => tool.name).slice(-3)).toEqual([dot, slash, 'mcp__modern__a_b']);
    expect(set.notices.filter((notice) => notice.includes('a_b'))).toEqual([]);
    const executor = makeExecutor();
    expect((await executor.resultOf(set, dot, {})).output).toBe('a.b');
    expect((await executor.resultOf(set, slash, {})).output).toBe('a/b');
    expect((await executor.resultOf(set, 'mcp__modern__a_b', {})).output).toBe('a_b');
    expect(callRecords(recordFile, 'a.b')).toHaveLength(1);
    expect(callRecords(recordFile, 'a/b')).toHaveLength(1);
    expect(callRecords(recordFile, 'a_b')).toHaveLength(1);
  });
});

describe('close during backoff and connect', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('resolves promptly during a reconnect backoff and spawns nothing after close began', async () => {
    const launcher = makeLauncher(() => 'exit 1');
    const harness = makePool([entry('flaky', launcher.config)], { random: () => 0.999 });
    const [source] = harness.pool.sources;
    await expect(source?.list()).rejects.toThrow();
    await expect(source?.list()).rejects.toThrow();
    expect(launcher.pids()).toHaveLength(2);
    const pending = (source?.list() as Promise<unknown>).then(
      () => 'resolved',
      () => 'rejected',
    );
    await turns(20);
    const startedAt = performance.now();
    await harness.pool.close();
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(await pending).toBe('rejected');
    expect(launcher.pids()).toHaveLength(2);
  });

  it('aborts an in-flight connect on close and reaps the half-started server', async () => {
    const launcher = makeLauncher(() => 'exec sleep 600');
    const harness = makePool([entry('stuck', launcher.config)], { connectTimeoutMs: 60_000 });
    onCleanup(() => killPidsForCleanup(launcher.pids()));
    const [source] = harness.pool.sources;
    const pending = (source?.list() as Promise<unknown>).then(
      () => 'resolved',
      () => 'rejected',
    );
    await waitUntil(() => launcher.pids().length === 1, 'launcher started');
    const startedAt = performance.now();
    await harness.pool.close();
    expect(performance.now() - startedAt).toBeLessThan(5000);
    expect(await pending).toBe('rejected');
    expect(pidAlive(launcher.pids()[0] as number)).toBe(false);
  });
});

describe('close aborting the first connect', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('leaves no abort error and no failure behind in diagnostics', async () => {
    const launcher = makeLauncher(() => 'exec sleep 600');
    const harness = makePool([entry('stuck', launcher.config)], { connectTimeoutMs: 60_000 });
    onCleanup(() => killPidsForCleanup(launcher.pids()));
    const pending = (harness.pool.sources[0]?.list() as Promise<unknown>).catch(() => undefined);
    await waitUntil(() => launcher.pids().length === 1, 'launcher started');
    await harness.pool.close();
    await pending;
    expect(harness.pool.diagnostics()[0]).toMatchObject({ server: 'stuck', state: 'closed', lastError: null });
  });
});

describe('lastError after reconnect', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('clears lastError once the server reconnects successfully', async () => {
    const recordFile = makeRecordFile();
    const harness = makePool([entry('modern', modernConfig(recordFile))]);
    const set = await harness.snapshot();
    const executor = makeExecutor();
    await executor.resultOf(set, 'mcp__modern__crash', { code: 3 });
    expect(harness.pool.diagnostics()[0]?.lastError).toMatch(/code 3/);
    expect((await executor.resultOf(set, 'mcp__modern__echo', { text: 'back' })).output).toBe('back');
    expect(harness.pool.diagnostics()[0]).toMatchObject({ state: 'connected', lastError: null });
    expect(readRecords(recordFile).filter((record) => record.type === 'ready')).toHaveLength(2);
  });
});

describe('server name length', () => {
  it('rejects a server whose prefix leaves no room for a tool name, naming the limit, without spawning', async () => {
    const name = 'n'.repeat(48);
    const launcher = makeLauncher(() => `exec '${process.execPath}' '${MCP_MODERN_SERVER_PATH}'`);
    const harness = makePool([entry(name, { ...launcher.config, env: { [MODERN_FIXTURE_RECORD_ENV]: makeRecordFile() } })]);
    const set = await harness.snapshot();
    const notices = set.notices.filter((notice) => notice.startsWith(`Tool source "mcp__${name}" failed to list tools: `));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('64');
    expect(launcher.pids()).toEqual([]);
  });

  it('accepts the longest server name that still leaves room for one character and the hash suffix', async () => {
    const name = 'n'.repeat(47);
    const set = await makePool([entry(name, modernConfig(makeRecordFile()))]).snapshot();
    expect(set.notices.filter((notice) => notice.includes('failed to list tools'))).toEqual([]);
    expect(set.get(`mcp__${name}__echo`)?.name).toBe(`mcp__${name}__echo`);
  });
});
