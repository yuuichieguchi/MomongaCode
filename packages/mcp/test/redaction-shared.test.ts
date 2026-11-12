import { describe, expect, it } from 'vitest';
import { nodeFileSystem, REDACTED_MARKER } from '@momonga/foundation';
import { createManagedConnection } from '@momonga/mcp';
import { createFakeClock, TEST_STDIO_LAUNCH } from '@momonga/testkit';
import { BASE_ENV, makeDir } from './mcp-harness.ts';

const SECRET = 'workspace secret/value+1';

describe('an MCP connection redacts through the one foundation redactor', () => {
  it('masks a configured secret in its URL-encoded form with the shared marker', async () => {
    const connection = createManagedConnection({
      launch: TEST_STDIO_LAUNCH,
      files: nodeFileSystem,
      clientVersion: '0.0.0-test',
      name: 'local',
      config: { command: process.execPath, args: [], env: { API_TOKEN: SECRET } },
      scope: 'user',
      projectDir: makeDir(),
      baseEnv: BASE_ENV,
      clock: createFakeClock(1_000_000),
      credentialNames: [],
    });
    expect(connection.redact(`error at /x?t=${encodeURIComponent(SECRET)} and ${SECRET}`)).toBe(`error at /x?t=${REDACTED_MARKER} and ${REDACTED_MARKER}`);
    await connection.close();
  });
});
