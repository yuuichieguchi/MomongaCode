import { nodeFileSystem } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { createManagedConnection } from '@momonga/mcp';
import type { McpServerConfig } from '@momonga/config';
import { createFakeClock, TEST_STDIO_LAUNCH } from '@momonga/testkit';
import { BASE_ENV, entry, makeDir, makeExecutor, makePool, makeRecordFile, modernConfig } from './mcp-harness.ts';

const WEAK = /could be guessed/i;
const SHORT = /too short to (be )?hid/i;

const credentialNotices = (notices: readonly string[]): string[] => notices.filter((notice) => WEAK.test(notice) || SHORT.test(notice));

const modernWithEnv = async (env: Record<string, string>) => {
  const harness = makePool([entry('modern', modernConfig(makeRecordFile(), env))]);
  const set = await harness.snapshot();
  return { harness, set };
};

const noticesOfConstruction = (config: McpServerConfig): string[] => {
  const notices: string[] = [];
  const connection = createManagedConnection({ launch: TEST_STDIO_LAUNCH, files: nodeFileSystem,
    clientVersion: '0.0.0-test',
    name: 'remote',
    config,
    scope: 'user',
    projectDir: makeDir(),
    baseEnv: BASE_ENV,
    clock: createFakeClock(1_000_000),
    onNotice: (message) => notices.push(message),
  });
  void connection.close();
  return notices;
};

describe('MCP credential values configured in a stdio env are redacted', () => {
  it('replaces an env credential value in tool output before the model sees it', async () => {
    const { set } = await modernWithEnv({ DB_PASSWORD: 'hunter2hunter2' });
    const result = await makeExecutor().resultOf(set, 'mcp__modern__echo', { text: 'leak hunter2hunter2 end' });
    expect(result.output).toBe('leak [REDACTED] end');
  });

  it('replaces a common env credential value in tool output while accepting it', async () => {
    const { set } = await modernWithEnv({ API_TOKEN: 'password' });
    const result = await makeExecutor().resultOf(set, 'mcp__modern__echo', { text: 'x password y' });
    expect(result.output).toBe('x [REDACTED] y');
  });
});

describe('MCP credential notices', () => {
  it('accepts a common env credential and gives one English notice that it could be guessed', async () => {
    const { set } = await modernWithEnv({ API_TOKEN: '12345678' });
    expect(set.tools.map((tool) => tool.name)).toContain('mcp__modern__echo');
    const notices = credentialNotices(set.notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(WEAK);
    expect(notices[0]).toContain('"modern"');
    expect(notices[0]).toContain('API_TOKEN');
    expect(notices[0]).not.toContain('12345678');
  });

  it('gives the guessable notice once per server and session, not on every listing', async () => {
    const { harness, set } = await modernWithEnv({ API_TOKEN: '12345678' });
    const again = await harness.snapshot();
    expect(credentialNotices([...set.notices, ...again.notices])).toHaveLength(1);
  });

  it('accepts a 7-character env credential and gives a notice that it is too short to hide', async () => {
    const { set } = await modernWithEnv({ SECRET_KEY: 'Zq7#vK2' });
    expect(set.tools.map((tool) => tool.name)).toContain('mcp__modern__echo');
    const notices = credentialNotices(set.notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(SHORT);
    expect(notices[0]).toContain('SECRET_KEY');
    expect(notices[0]).not.toContain('Zq7#vK2');
  });

  it('gives no credential notice for a long value outside the common-password list', async () => {
    const { set } = await modernWithEnv({ API_TOKEN: 'correct-horse-battery-staple-7f' });
    expect(credentialNotices(set.notices)).toEqual([]);
  });

  it('gives the guessable notice for a common HTTP header value without refusing the server', () => {
    const credential = credentialNotices(noticesOfConstruction({ type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { 'X-Api-Key': 'password' } }));
    expect(credential).toHaveLength(1);
    expect(credential[0]).toMatch(WEAK);
    expect(credential[0]).toContain('"remote"');
    expect(credential[0]).toContain('X-Api-Key');
    expect(credential[0]).not.toContain('password');
  });

  it('gives the too-short notice for a short HTTP header credential', () => {
    const credential = credentialNotices(noticesOfConstruction({ type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { 'X-Api-Key': 'Zq7#vK2' } }));
    expect(credential).toHaveLength(1);
    expect(credential[0]).toMatch(SHORT);
    expect(credential[0]).not.toContain('Zq7#vK2');
  });
});
