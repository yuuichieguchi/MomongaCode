import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadMcpServers } from '@momonga/config';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { createMcpPool, inheritedEnvOf } from '@momonga/mcp';
import type { McpPool, McpPoolOptions } from '@momonga/mcp';
import * as runtime from '@momonga/runtime';
import type { RuntimeStore } from '@momonga/store';
import { MCP_MODERN_SERVER_PATH, waitFor } from '@momonga/testkit';
import type { ToolSource } from '@momonga/tools';
import {
  POOL_IDLE_CLOSE_MS,
  POOL_REFERENCE_AUDIT_MS,
  createRun,
  createSession,
  flushMicrotasks,
  inertSandbox,
  makeDir,
  makeFakePool,
  makeRuntimeFixture,
  signalNever,
  writeJson,
  writeUserSettings,
} from './helpers.ts';
import type { RuntimeFixture } from './helpers.ts';

const PROCESS_TIMEOUT = { timeout: 60_000 };

const fixtureServer = { command: process.execPath, args: [MCP_MODERN_SERVER_PATH] };

const toolEnv = (pathValue = '/usr/bin:/bin', extra: Record<string, string> = {}): Readonly<Record<string, string>> => Object.freeze({ PATH: pathValue, ...extra });

type Counting = { created: McpPoolOptions[]; createPool(options: McpPoolOptions): McpPool };

const countingRealPools = (): Counting => {
  const created: McpPoolOptions[] = [];
  return {
    created,
    createPool: (options) => {
      created.push(options);
      return createMcpPool(options);
    },
  };
};

const realFixture = async (): Promise<RuntimeFixture & { counting: Counting }> => {
  const counting = countingRealPools();
  const fixture = await makeRuntimeFixture({ createPool: counting.createPool });
  return { ...fixture, counting };
};

const markerCount = (f: RuntimeFixture): number => fs.readdirSync(f.temp.paths.markers.mcp).length;

const newRun = (f: RuntimeFixture, cwd = f.temp.project): string => createRun(f.store, createSession(f.store, cwd).id);

const claimRun = (store: RuntimeStore, runId: string) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const claim = store.claim(`worker-${attempt}`);
    if (claim === null) break;
    if (claim.runId === runId) return claim;
  }
  throw new Error(`run ${runId} could not be claimed`);
};

const finishRun = (store: RuntimeStore, runId: string): void => {
  const result = store.transition(claimRun(store, runId), ['RUNNING'], 'COMPLETED');
  if (result.kind !== 'ok') throw new Error(`run ${runId} did not complete: ${JSON.stringify(result)}`);
};

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

const gatedSource = (): { source: ToolSource; listing: () => boolean } => {
  let listing = false;
  return {
    listing: () => listing,
    source: {
      id: 'mcp__gated',
      list: (options) =>
        new Promise((_resolve, reject) => {
          listing = true;
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        }),
    },
  };
};

describe('MCP pools through toolSet (real fixture processes; fake timers for the idle close)', () => {
  it('two runs in one project share one pool (one spawn)', PROCESS_TIMEOUT, async () => {
    const f = await realFixture();
    writeUserSettings(f.temp.home, { mcpServers: { fx: fixtureServer } });
    const first = newRun(f);
    const second = newRun(f);

    const a = await f.toolRuntime.port.toolSet(first, { signal: signalNever(), env: toolEnv() });
    const b = await f.toolRuntime.port.toolSet(second, { signal: signalNever(), env: toolEnv() });

    expect(f.counting.created).toHaveLength(1);
    expect(markerCount(f)).toBe(1);
    expect(f.toolRuntime.mcpPools.size()).toBe(1);
    expect(a.tools.map((tool) => tool.name)).toContain('mcp__fx__echo');
    expect(b.digest).toBe(a.digest);
    expect(f.counting.created[0]?.closeGraceMs).toBe(1000);
    expect(f.counting.created[0]?.markers?.dir).toBe(f.temp.paths.markers.mcp);
    expect(f.counting.created[0]?.projectDir).toBe(f.temp.project);
  });

  it('offers the tools of the servers a session carries and reports a name the user settings already use', PROCESS_TIMEOUT, async () => {
    const f = await realFixture();
    writeUserSettings(f.temp.home, { mcpServers: { taken: fixtureServer } });
    const session = createSession(f.store, f.temp.project, { mcpServers: { fx: fixtureServer, taken: fixtureServer } });

    const set = await f.toolRuntime.port.toolSet(createRun(f.store, session.id), { signal: signalNever(), env: toolEnv() });

    expect(set.tools.map((tool) => tool.name)).toContain('mcp__fx__echo');
    expect(set.notices.filter((notice) => notice.startsWith('MCP server taken was skipped: '))).toHaveLength(1);
    expect(f.counting.created).toHaveLength(1);
    expect(f.counting.created[0]?.servers.map((server) => [server.name, server.scope])).toEqual([
      ['taken', 'user'],
      ['fx', 'session'],
    ]);
  });

  describe('a new pool for the next run after', () => {
    it('an approval change', PROCESS_TIMEOUT, async () => {
      const f = await makeRuntimeFixture();
      f.store.trust.set(f.temp.project, 'trusted');
      writeJson(path.join(f.temp.project, '.mcp.json'), { mcpServers: { a: fixtureServer, b: fixtureServer } });
      writeUserSettings(f.temp.home, { enabledMcpjsonServers: ['a'] });
      await f.toolRuntime.port.toolSet(newRun(f), { signal: signalNever(), env: toolEnv() });

      writeUserSettings(f.temp.home, { enabledMcpjsonServers: ['a', 'b'] });
      await f.toolRuntime.port.toolSet(newRun(f), { signal: signalNever(), env: toolEnv() });

      expect(f.pools.pools).toHaveLength(2);
      expect(f.pools.pools[0]?.options?.servers.map((server) => server.name)).toEqual(['a']);
      expect(f.pools.pools[1]?.options?.servers.map((server) => server.name)).toEqual(['a', 'b']);
    });

    it('a trust change', async () => {
      const f = await makeRuntimeFixture();
      writeUserSettings(f.temp.home, { mcpServers: { fx: fixtureServer } });
      await f.toolRuntime.port.toolSet(newRun(f), { signal: signalNever(), env: toolEnv() });
      await f.toolRuntime.port.toolSet(newRun(f), { signal: signalNever(), env: toolEnv() });
      expect(f.pools.pools).toHaveLength(1);

      f.store.trust.set(f.temp.project, 'untrusted');
      await f.toolRuntime.port.toolSet(newRun(f), { signal: signalNever(), env: toolEnv() });

      expect(f.pools.pools).toHaveLength(2);
    });

    it('an inherited env change', async () => {
      const f = await makeRuntimeFixture();
      writeUserSettings(f.temp.home, { mcpServers: { fx: fixtureServer } });
      await f.toolRuntime.port.toolSet(newRun(f), { signal: signalNever(), env: toolEnv('/usr/bin:/bin') });
      await f.toolRuntime.port.toolSet(newRun(f), { signal: signalNever(), env: toolEnv('/usr/bin:/bin', { NOT_INHERITED: 'x' }) });
      expect(f.pools.pools).toHaveLength(1);

      await f.toolRuntime.port.toolSet(newRun(f), { signal: signalNever(), env: toolEnv('/usr/bin:/bin:/usr/sbin') });

      expect(f.pools.pools).toHaveLength(2);
    });
  });

  it('an idle pool closes after 5 minutes and its marker is removed', PROCESS_TIMEOUT, async () => {
    const f = await realFixture();
    writeUserSettings(f.temp.home, { mcpServers: { fx: fixtureServer } });
    const runId = newRun(f);
    await f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env: toolEnv() });
    expect(markerCount(f)).toBe(1);

    finishRun(f.store, runId);
    await flushMicrotasks();
    expect(f.toolRuntime.mcpPools.release(runId)).toBe(false);
    f.timers.advance(POOL_IDLE_CLOSE_MS - 1);
    await flushMicrotasks();
    expect(f.toolRuntime.mcpPools.size()).toBe(1);

    f.timers.advance(1);
    await waitFor(() => markerCount(f) === 0, { description: 'the MCP marker to be removed after the idle close' });
    expect(f.toolRuntime.mcpPools.size()).toBe(0);
  });

  it('the reference is held while WAITING_HUMAN', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { mcpServers: { fx: fixtureServer } });
    const runId = newRun(f);
    await f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env: toolEnv() });
    const claim = claimRun(f.store, runId);
    expect(f.store.transition(claim, ['RUNNING'], 'WAITING_HUMAN').kind).toBe('ok');

    await flushMicrotasks();
    f.timers.advance(POOL_REFERENCE_AUDIT_MS);
    await flushMicrotasks();

    expect(f.pools.pools[0]?.closes).toBe(0);
    expect(f.toolRuntime.mcpPools.release(runId)).toBe(true);
  });

  it('concurrent toolSet calls create one pool', PROCESS_TIMEOUT, async () => {
    const f = await realFixture();
    writeUserSettings(f.temp.home, { mcpServers: { fx: fixtureServer } });
    const runs = [newRun(f), newRun(f), newRun(f)];

    const sets = await Promise.all(runs.map((runId) => f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env: toolEnv() })));

    expect(f.counting.created).toHaveLength(1);
    expect(markerCount(f)).toBe(1);
    expect(new Set(sets.map((set) => set.digest)).size).toBe(1);
  });

  it('a failed server and a server pending approval become run notices, in order', async () => {
    const f = await makeRuntimeFixture();
    f.store.trust.set(f.temp.project, 'trusted');
    writeJson(path.join(f.temp.project, '.mcp.json'), { mcpServers: { waiting: fixtureServer } });
    writeUserSettings(f.temp.home, { mcpServers: { broken: { command: 'x', args: ['${MOMONGA_TEST_UNSET_VARIABLE}'] }, fx: fixtureServer } });

    const set = await f.toolRuntime.port.toolSet(newRun(f), { signal: signalNever(), env: toolEnv() });

    const skipped = set.notices.findIndex((notice) => notice.startsWith('MCP server broken was skipped: '));
    const pending = set.notices.indexOf('MCP server waiting needs approval before it can run');
    expect(skipped).toBeGreaterThanOrEqual(0);
    expect(pending).toBeGreaterThan(skipped);
    expect(Object.isFrozen(set.notices)).toBe(true);
  });

  it('settings and MCP warnings are deduplicated in notices', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {
      mcpServers: { fx: fixtureServer },
      models: {
        targets: { m: { adapter: 'chat-completions', model: 'x', baseUrl: 'https://api.example.com/v1', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } } },
        aliases: { other: 'm' },
      },
    });

    const set = await f.toolRuntime.port.toolSet(newRun(f), { signal: signalNever(), env: toolEnv() });

    const aliasNotices = set.notices.filter((notice) => notice.includes('has no "default" alias'));
    expect(aliasNotices).toHaveLength(1);
    expect(new Set(set.notices).size).toBe(set.notices.length);
  });

  it('a throwing toolSet holds no new reference', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { mcpServers: { fx: fixtureServer } });

    const missing = await rejectionOf(f.toolRuntime.port.toolSet('no-such-run', { signal: signalNever(), env: toolEnv() }));

    expect(missing).toBeInstanceOf(Error);
    expect(missing).not.toBeInstanceOf(ConfigError);
    expect(f.pools.pools).toHaveLength(0);
    expect(f.toolRuntime.mcpPools.size()).toBe(0);
  });

  it('a failing toolSet of a later claim keeps the reference an earlier claim of the same run took (acquiredHere)', async () => {
    const gate = gatedSource();
    let pool: McpPool | undefined;
    const f = await makeRuntimeFixture({
      createPool: () => {
        pool = { ...makeFakePool(), sources: [] };
        return pool;
      },
    });
    writeUserSettings(f.temp.home, { mcpServers: { fx: fixtureServer } });
    const runId = newRun(f);
    await f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env: toolEnv() });
    if (pool === undefined) throw new Error('expected a pool');
    pool.sources.push(gate.source);

    const controller = new AbortController();
    const reason = new Error('the later claim was abandoned');
    const later = f.toolRuntime.port.toolSet(runId, { signal: controller.signal, env: toolEnv() });
    await waitFor(gate.listing, { description: 'the later claim to start listing' });
    controller.abort(reason);

    expect(await rejectionOf(later)).toBe(reason);
    expect(f.toolRuntime.mcpPools.release(runId)).toBe(true);
  });

  it('a failing toolSet that took a reference releases it', async () => {
    const gate = gatedSource();
    const f = await makeRuntimeFixture({ createPool: () => ({ ...makeFakePool(), sources: [gate.source] }) });
    writeUserSettings(f.temp.home, { mcpServers: { fx: fixtureServer } });
    const runId = newRun(f);
    const controller = new AbortController();
    const reason = new Error('the claim was abandoned');

    const pending = f.toolRuntime.port.toolSet(runId, { signal: controller.signal, env: toolEnv() });
    await waitFor(gate.listing, { description: 'the claim to start listing' });
    expect(f.toolRuntime.mcpPools.size()).toBe(1);
    controller.abort(reason);

    expect(await rejectionOf(pending)).toBe(reason);
    expect(f.toolRuntime.mcpPools.release(runId)).toBe(false);
    expect(f.timers.pending().map((timer) => timer.delayMs)).toEqual([POOL_IDLE_CLOSE_MS]);
  });

  it("a session in a subdirectory of a trusted project loads the project's .mcp.json, and a decision on home is not inherited", async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { enableAllProjectMcpServers: true });
    const sub = makeDir(f.temp.project, 'pkg');
    writeJson(path.join(sub, '.mcp.json'), { mcpServers: { proj: fixtureServer } });
    f.store.trust.set(f.temp.project, 'trusted');
    const inHome = makeDir(f.temp.home, 'code', 'app');
    writeJson(path.join(inHome, '.mcp.json'), { mcpServers: { homeproj: fixtureServer } });
    f.store.trust.set(f.temp.home, 'trusted');

    await f.toolRuntime.port.toolSet(newRun(f, sub), { signal: signalNever(), env: toolEnv() });
    const homeSet = await f.toolRuntime.port.toolSet(newRun(f, inHome), { signal: signalNever(), env: toolEnv() });

    expect(f.pools.pools).toHaveLength(1);
    expect(f.pools.pools[0]?.options?.servers.map((server) => server.name)).toEqual(['proj']);
    expect(f.pools.pools[0]?.options?.projectDir).toBe(sub);
    expect(homeSet.notices.some((notice) => notice.includes(`project ${inHome} is not trusted`))).toBe(true);
  });

  it('a run with no enabled servers holds no reference, and the no-servers branch releases a reference left by an earlier claim', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { mcpServers: { fx: fixtureServer } });
    const runId = newRun(f);
    await f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env: toolEnv() });

    writeUserSettings(f.temp.home, {});
    const set = await f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env: toolEnv() });
    const fresh = newRun(f);
    await f.toolRuntime.port.toolSet(fresh, { signal: signalNever(), env: toolEnv() });

    expect(set.tools.some((tool) => tool.name.startsWith('mcp__'))).toBe(false);
    expect(f.toolRuntime.mcpPools.release(runId)).toBe(false);
    expect(f.toolRuntime.mcpPools.release(fresh)).toBe(false);
    expect(f.pools.pools).toHaveLength(1);
    f.timers.advance(POOL_IDLE_CLOSE_MS);
    await flushMicrotasks();
    expect(f.pools.pools[0]?.closes).toBe(1);
  });

  it('an aborted signal rejects toolSet promptly during a slow connect', PROCESS_TIMEOUT, async () => {
    const f = await realFixture();
    writeUserSettings(f.temp.home, { mcpServers: { mute: { command: '/bin/sh', args: ['-c', 'exec sleep 30'] } } });
    const controller = new AbortController();
    const reason = new Error('cancelled while connecting');

    const pending = f.toolRuntime.port.toolSet(newRun(f), { signal: controller.signal, env: toolEnv() });
    await waitFor(() => markerCount(f) === 1, { description: 'the slow server to be spawned' });
    controller.abort(reason);

    expect(await rejectionOf(pending)).toBe(reason);
  });

  it('the pool key hash is never logged', PROCESS_TIMEOUT, async () => {
    const f = await realFixture();
    writeUserSettings(f.temp.home, { mcpServers: { fx: fixtureServer } });
    const runId = newRun(f);
    await f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env: toolEnv() });
    finishRun(f.store, runId);
    await flushMicrotasks();
    f.timers.advance(POOL_IDLE_CLOSE_MS);
    await waitFor(() => markerCount(f) === 0, { description: 'the idle pool to close' });

    const mcp = await loadMcpServers({ home: f.temp.home, projectDir: f.temp.project, trust: { isTrusted: () => false }, env: toolEnv() });
    const key = sha256Hex(canonicalJson({ project: f.temp.project, servers: mcp.enabled, trust: 'unset', env: inheritedEnvOf(toolEnv()) }));
    const logged = JSON.stringify(f.logger.entries);
    expect(mcp.enabled.map((server) => server.name)).toEqual(['fx']);
    expect(logged).not.toContain(key);
    expect(logged).not.toMatch(/[0-9a-f]{64}/);
  });

  it('recoveryToolSet connects no MCP server and holds no reference', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { mcpServers: { fx: fixtureServer } });

    const set = await f.toolRuntime.port.recoveryToolSet({ signal: signalNever() });

    expect(set.tools.length).toBeGreaterThan(0);
    expect(set.tools.some((tool) => tool.name.startsWith('mcp__'))).toBe(false);
    expect(f.pools.pools).toHaveLength(0);
    expect(f.toolRuntime.mcpPools.size()).toBe(0);
  });

  it('a relative home raises TypeError in createToolRuntime', async () => {
    const f = await makeRuntimeFixture();
    let error: unknown;
    try {
      runtime.createToolRuntime({
        paths: f.temp.paths,
        home: 'relative/home',
        store: f.store,
        notifier: f.notifier,
        clock: f.clock,
        timers: f.timers,
        logger: f.logger,
        report: f.reporter.report,
        sandbox: inertSandbox,
        settings: f.composition,
        reapTiming: f.reapTiming,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain('relative/home');
  });
});
