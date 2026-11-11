import { FIRST_GENERATION, fixedRolePort } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import type { McpAuthorizingPool, McpPoolOptions } from '@momonga/mcp';
import * as runtime from '@momonga/runtime';
import { FAKE_LEASE, unconfiguredDerivedNetworkOf, testLocks, testKernelLock } from '@momonga/testkit';
import { nodeShellHost } from '@momonga/tools';
import { createSession, inertSandbox, makeRuntimeFixture } from './helpers.ts';

describe('the MCP admin probe pool launches its servers with the MCP process marker (design 19.6 point 13)', () => {
  it('hands the admin pool the markers directory of the MCP session pool', async () => {
    const f = await makeRuntimeFixture();
    const created: McpPoolOptions[] = [];
    const createAdminPool = (options: McpPoolOptions): McpAuthorizingPool => {
      created.push(options);
      return { sources: [], diagnostics: () => [], authState: async () => ({ state: 'authorized' }), authorize: async () => undefined, close: async () => undefined } as unknown as McpAuthorizingPool;
    };
    const toolRuntime = runtime.createToolRuntime({
      kernelLock: testKernelLock(),
      lockCapability: testLocks().capability,
      version: '0.0.0-test',
      network: unconfiguredDerivedNetworkOf,
      paths: f.temp.paths,
      sharedPaths: f.temp.paths,
      generation: FIRST_GENERATION,
      role: fixedRolePort('serving'),
      home: f.temp.home,
      store: f.store,
      notifier: f.notifier,
      clock: f.clock,
      timers: f.timers,
      logger: f.logger,
      report: f.reporter.report,
      sandboxes: runtime.fixedSandboxBindings(inertSandbox),
      shellHost: nodeShellHost(),
      settings: f.composition,
      reapTiming: f.reapTiming,
      ...FAKE_LEASE,
      createAdminPool,
    } as Parameters<typeof runtime.createToolRuntime>[0]);
    const session = createSession(f.store, f.temp.project, { mcpServers: { local: { command: 'node', args: ['server.js'] } } });
    await toolRuntime.mcpAdmin.servers(session.id, new AbortController().signal);
    expect(created).toHaveLength(1);
    expect(created[0]?.markers?.dir).toBe(f.temp.paths.markers.mcp);
    expect(typeof created[0]?.markers?.onWarning).toBe('function');
    await toolRuntime.mcpAdmin.close(0);
  });
});
