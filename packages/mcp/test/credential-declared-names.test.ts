import { nodeFileSystem } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { createManagedConnection } from '@momonga/mcp';
import { createFakeClock, TEST_STDIO_LAUNCH } from '@momonga/testkit';
import { BASE_ENV, entry, makeDir, makeExecutor, makePool, makeRecordFile, modernConfig } from './mcp-harness.ts';

const DECLARED = 'PROVIDER_ENDPOINT_ID';

const constructionNotices = (credentialNames: readonly string[]): string[] => {
  const notices: string[] = [];
  const connection = createManagedConnection({ launch: TEST_STDIO_LAUNCH, files: nodeFileSystem,
    clientVersion: '0.0.0-test',
    name: 'local',
    config: { command: process.execPath, args: [], env: { [DECLARED]: 'Zq7#vK2' } },
    scope: 'user',
    projectDir: makeDir(),
    baseEnv: BASE_ENV,
    clock: createFakeClock(1_000_000),
    credentialNames,
    onNotice: (message) => notices.push(message),
  });
  void connection.close();
  return notices.filter((notice) => /too short to hide/.test(notice));
};

describe('a declared credential name in an MCP server env is a credential, as in the session', () => {
  it('treats a declared name the name heuristic rejects as a credential', () => {
    const notices = constructionNotices([DECLARED]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(DECLARED);
  });

  it('does not treat the same name as a credential when it is not declared', () => {
    expect(constructionNotices([])).toEqual([]);
  });

  it('redacts the value of a declared name from tool output through the pool', async () => {
    const harness = makePool([entry('modern', modernConfig(makeRecordFile(), { [DECLARED]: 'opaque-value-1234' }))], { credentialNames: [DECLARED] });
    const set = await harness.snapshot();
    const result = await makeExecutor().resultOf(set, 'mcp__modern__echo', { text: 'a opaque-value-1234 b' });
    expect(result.output).toBe('a [REDACTED] b');
  });
});
