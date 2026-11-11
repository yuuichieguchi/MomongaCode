import { describe, expect, it, vi } from 'vitest';
import type { McpAuthorizingPool, McpPoolOptions } from '@momonga/mcp';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { mutableRole } from '../shared/mutable-role.ts';
import { launchRuntime, startStack, waitForCondition } from '../process/run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const AUTHORIZE_URL = 'https://auth.example.test/authorize?state=1';

const personAnswers = () => {
  let answer: () => void = () => undefined;
  const createAdminPool = (options: McpPoolOptions): McpAuthorizingPool =>
    ({
      sources: [],
      diagnostics: () => [],
      authState: async () => ({ state: 'required' }),
      close: async () => undefined,
      authorize: async (_server: string, signal: AbortSignal) => {
        await options.remote?.openAuthorizationUrl(new URL(AUTHORIZE_URL), signal);
        await new Promise<void>((resolve, reject) => {
          answer = resolve;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    }) as unknown as McpAuthorizingPool;
  return { createAdminPool, answer: () => answer() };
};

describe('a retiring runtime holds the authorization a person has not answered yet', () => {
  it('does not leave while the attempt waits for the person, still answers its state, and leaves once the person has answered', async () => {
    const stack = await startStack({}, { mcpServers: { docs: { type: 'http', url: 'https://mcp.example.test/mcp' } } });
    const role = mutableRole('serving');
    const person = personAnswers();
    let shutdowns = 0;
    const launched = await launchRuntime(stack.temp, {
      role: role.port,
      createAdminPool: person.createAdminPool,
      requestShutdown: () => {
        shutdowns += 1;
      },
    });
    const session = await launched.createSession();
    const authorization = `/v1/sessions/${session.id}/mcp/servers/docs/authorization`;
    const started = await launched.http('POST', authorization);
    expect(started.status).toBe(202);
    expect(started.json).toMatchObject({ authorization: { server: 'docs', status: 'awaiting_user', url: AUTHORIZE_URL } });

    role.set('retiring');
    await waitForCondition(() => launched.logger.entries.some((entry) => entry.msg === 'generation.retiring'), 'the retiring runtime to learn its role');

    expect(launched.logger.entries.some((entry) => entry.msg === 'generation.retired')).toBe(false);
    expect(shutdowns).toBe(0);
    expect((await launched.http('GET', authorization)).json).toMatchObject({ authorization: { status: 'awaiting_user' } });

    person.answer();
    await waitForCondition(() => shutdowns === 1, 'the retiring runtime to leave once the person has answered');
    expect(launched.logger.entries.filter((entry) => entry.msg === 'generation.retired')).toHaveLength(1);
  });
});
