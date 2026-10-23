import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpPool, McpPoolOptions } from '@momonga/mcp';
import { createSeatbeltSandbox } from '@momonga/sandbox';
import { waitFor } from '@momonga/testkit';
import {
  DECLARED_CREDENTIAL,
  HAS_SEATBELT,
  chatTargetSettings,
  createRun,
  createSession,
  makeFakePool,
  makeRuntimeFixture,
  makeTempHome,
  runBashThroughPort,
  signalNever,
  writeUserSettings,
} from './helpers.ts';

const SENTINEL = 'MOMONGA_ENV_TEST_SENTINEL';
const PROCESS_TIMEOUT = { timeout: 60_000 };

const withSentinel = async <T>(task: () => Promise<T>): Promise<T> => {
  process.env[SENTINEL] = 'leaked-from-process-env';
  try {
    return await task();
  } finally {
    delete process.env[SENTINEL];
  }
};

const dumpServer = (file: string) => ({
  command: '/bin/sh',
  args: ['-c', 'env > "$DUMP_FILE.partial" && mv "$DUMP_FILE.partial" "$DUMP_FILE"; exec sleep 30'],
  env: { DUMP_FILE: file, SEEN_DECLARED: `\${${DECLARED_CREDENTIAL}:-absent}`, SEEN_SENTINEL: `\${${SENTINEL}:-absent}` },
});

const mcpEnvDump = async (f: Awaited<ReturnType<typeof makeRuntimeFixture>>, runId: string, file: string): Promise<string> => {
  const controller = new AbortController();
  const session = f.store.getSession(f.store.getRun(runId)?.sessionId ?? '');
  if (session === undefined) throw new Error('missing session');
  const pending = f.toolRuntime.port.toolSet(runId, { signal: controller.signal, env: f.toolRuntime.port.envFor(session) });
  pending.catch(() => undefined);
  await waitFor(() => fs.existsSync(file), { description: 'the MCP server to dump its env' });
  controller.abort(new Error('done'));
  await pending.catch(() => undefined);
  return fs.readFileSync(file, 'utf8');
};

const realPools = async () => {
  const { createMcpPool } = await import('@momonga/mcp');
  return createMcpPool;
};

describe('tool env at use time (system timers)', () => {
  describe.runIf(HAS_SEATBELT)('real Seatbelt, real executor', () => {
    it('a process.env sentinel is absent from Bash env and the MCP env dump', PROCESS_TIMEOUT, async () => {
      const temp = await makeTempHome();
      const f = await makeRuntimeFixture({
        temp,
        sandbox: createSeatbeltSandbox({ tmpRoot: temp.paths.tmp.spawn, killGraceMs: 300 }),
        createPool: await realPools(),
      });
      const dump = path.join(temp.root, 'mcp-env.txt');
      writeUserSettings(temp.home, {});
      const session = createSession(f.store, temp.project, { env: { PATH: '/usr/bin:/bin', HOME: temp.home } });
      const runId = createRun(f.store, session.id);

      await withSentinel(async () => {
        const { outcome } = await runBashThroughPort(f, session, runId, 'env');
        expect(outcome.kind).toBe('result');
        const output = outcome.kind === 'result' ? outcome.result.output : '';
        expect(output).toContain('PATH=/usr/bin:/bin');
        expect(output).not.toContain(SENTINEL);

        writeUserSettings(temp.home, { mcpServers: { dump: dumpServer(dump) } });
        const mcpEnv = await mcpEnvDump(f, runId, dump);
        expect(mcpEnv).toContain('SEEN_SENTINEL=absent');
        expect(mcpEnv).not.toContain('leaked-from-process-env');
      });
    });

    it('a variable declared as apiKeyEnv after session create is stripped at use time from Bash and from MCP', PROCESS_TIMEOUT, async () => {
      const temp = await makeTempHome();
      const f = await makeRuntimeFixture({
        temp,
        sandbox: createSeatbeltSandbox({ tmpRoot: temp.paths.tmp.spawn, killGraceMs: 300 }),
        createPool: await realPools(),
      });
      const dump = path.join(temp.root, 'mcp-env.txt');
      writeUserSettings(temp.home, {});
      const session = createSession(f.store, temp.project, { env: { PATH: '/usr/bin:/bin', HOME: temp.home, [DECLARED_CREDENTIAL]: 'v' } });
      const runId = createRun(f.store, session.id);
      const before = await runBashThroughPort(f, session, runId, `printf '%s' "\${${DECLARED_CREDENTIAL}:-absent}"`);
      const beforeOutput = before.outcome.kind === 'result' ? before.outcome.result.output : '';
      expect(beforeOutput).toContain('v');
      expect(beforeOutput).not.toContain('absent');

      writeUserSettings(temp.home, chatTargetSettings(DECLARED_CREDENTIAL));

      const after = await runBashThroughPort(f, session, runId, `printf '%s' "\${${DECLARED_CREDENTIAL}:-absent}"`);
      expect(after.outcome.kind).toBe('result');
      expect(after.outcome.kind === 'result' ? after.outcome.result.output : '').toContain('absent');

      writeUserSettings(temp.home, { ...chatTargetSettings(DECLARED_CREDENTIAL), mcpServers: { dump: dumpServer(dump) } });
      const mcpEnv = await mcpEnvDump(f, runId, dump);
      expect(mcpEnv).toContain('SEEN_DECLARED=absent');
      expect(mcpEnv).not.toContain(`${DECLARED_CREDENTIAL}=`);
    });
  });

  it('the env passed to the pool key, MCP baseEnv (an injected createPool) and policy.env is the same frozen object per claim', async () => {
    const seen: McpPoolOptions[] = [];
    const f = await makeRuntimeFixture({
      createPool: (options): McpPool => {
        seen.push(options);
        return makeFakePool(options);
      },
    });
    writeUserSettings(f.temp.home, { mcpServers: { fx: { command: '/bin/echo' } } });
    const session = createSession(f.store, f.temp.project, { env: { PATH: '/usr/bin:/bin', PLAIN: '1' } });
    const runId = createRun(f.store, session.id);

    const env = f.toolRuntime.port.envFor(session);
    const policy = await f.toolRuntime.port.policyFor(session, { env });
    await f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env });

    expect(Object.isFrozen(env)).toBe(true);
    expect(policy.env).toBe(env);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.baseEnv).toBe(env);

    const nextClaimEnv = f.toolRuntime.port.envFor(session);
    expect(nextClaimEnv).toEqual(env);
  });
});
