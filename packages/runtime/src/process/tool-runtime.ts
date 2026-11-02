import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { canonicalJson, ensureSessionTmpDir as defaultEnsureSessionTmpDir, sha256Hex } from '@momonga/foundation';
import type { Clock, JsonLogger, MomongaPaths, ReapTiming } from '@momonga/foundation';
import { createFileCredentialStore, createMcpPool, inheritedEnvOf, mcpCredentialDirectory } from '@momonga/mcp';
import type { McpAuthorizingPool, McpPool, McpPoolOptions, McpRemotePorts } from '@momonga/mcp';
import type { Sandbox } from '@momonga/sandbox';
import type { RuntimeStore } from '@momonga/store';
import { createBuiltinTools, createPolicyFilesystem, createToolExecutor, createToolRegistry } from '@momonga/tools';
import type { ShellHost, ToolSet } from '@momonga/tools';
import type { PolicyFilesystem } from '@momonga/policy';
import type { ToolRuntimePort } from '../ports.ts';
import type { RunNotifier } from '../service/notifier.ts';
import type { ServiceTimers } from '../service/timers.ts';
import { createBackgroundJobs } from './background-jobs.ts';
import { createNodeJobMarkerFiles } from './job-marker-files.ts';
import type { BackgroundJobRegistry } from './background-jobs.ts';
import { MCP_CLOSE_GRACE_MS, SANDBOX_KILL_GRACE_MS } from './constants.ts';
import { createMcpAdmin, loadSessionMcpServers } from './mcp-admin.ts';
import type { McpAdmin } from './mcp-admin.ts';
import { createMcpPoolCache } from './mcp-pool-cache.ts';
import type { McpPoolCache } from './mcp-pool-cache.ts';
import { createSessionStates } from './session-states.ts';
import type { SessionStates } from './session-states.ts';
import type { SettingsComposition } from './settings-port.ts';
import { createPolicyFor, createRecoveryContextFor } from './tool-policy.ts';

export type ToolRuntimeOptions = {
  paths: MomongaPaths;
  home: string;
  store: RuntimeStore;
  notifier: Pick<RunNotifier, 'watchRun'>;
  clock: Clock;
  timers: ServiceTimers;
  logger: JsonLogger;
  report(error: unknown): void;
  sandbox: Sandbox;
  shellHost: ShellHost;
  settings: Pick<SettingsComposition, 'envFor' | 'takeUserSnapshot' | 'loadSessionSettings' | 'trustOracle'>;
  heartbeatMs: number;
  reapTiming: ReapTiming;
  createPool?: (options: McpPoolOptions) => McpPool;
  createAdminPool?: (options: McpPoolOptions) => McpAuthorizingPool;
  mcpRemote?: McpRemotePorts;
  ensureSessionTmpDir?: (paths: MomongaPaths, sessionId: string) => Promise<string>;
  policyFilesystem?: PolicyFilesystem;
};

export type ToolRuntime = {
  port: ToolRuntimePort;
  mcpPools: McpPoolCache;
  mcpAdmin: McpAdmin;
  sessionStates: SessionStates;
  jobs: BackgroundJobRegistry;
  inFlightKeys(): ReadonlySet<string>;
};

const dedupe = (notices: readonly string[]): string[] => [...new Set(notices)];

export const createToolRuntime = (options: ToolRuntimeOptions): ToolRuntime => {
  const { paths, home, store, notifier, clock, timers, logger, report, sandbox, settings, reapTiming } = options;
  if (!path.isAbsolute(home)) throw new TypeError(`home must be an absolute path, got ${home}`);
  const createPool = options.createPool ?? createMcpPool;
  const mcpRemote: McpRemotePorts = options.mcpRemote ?? {
    credentials: createFileCredentialStore(mcpCredentialDirectory(paths)),
    randomToken: () => randomBytes(32).toString('base64url'),
    openAuthorizationUrl: () => Promise.reject(new Error('the daemon never opens a browser; authorization URLs are handed to the client through the Run API')),
  };
  const ensureSessionTmpDir = options.ensureSessionTmpDir ?? defaultEnsureSessionTmpDir;

  const policyFilesystem = options.policyFilesystem ?? createPolicyFilesystem();
  const jobs = createBackgroundJobs({
    store,
    clock,
    timers,
    markerDir: paths.markers.tools,
    markerFiles: createNodeJobMarkerFiles(),
    killGraceMs: SANDBOX_KILL_GRACE_MS,
    reapTiming,
    onWarning: (message) => logger.warn(message),
    report,
  });
  const executor = createToolExecutor({
    heartbeatMs: options.heartbeatMs,
    jobs,
    fs: policyFilesystem,
    idempotency: store.idempotency,
    blobs: store.blobs,
    clock,
    processMarkerDir: paths.markers.tools,
    callLockDir: paths.callLocks,
    onWarning: (message) => logger.warn(message),
    reap: { timing: reapTiming },
  });
  const mcpAdmin = createMcpAdmin({
    home,
    store,
    clock,
    timers,
    logger,
    report,
    settings,
    remote: mcpRemote,
    createPool: options.createAdminPool ?? createMcpPool,
  });
  const mcpPools = createMcpPoolCache({ store, notifier, timers, logger, report });
  const sessionStates = createSessionStates({ clock, store, logger });
  const policyOptions = { paths, home, fs: policyFilesystem, sessionStates, ensureSessionTmpDir };
  const policyFor = createPolicyFor(policyOptions);
  const recoveryContextFor = createRecoveryContextFor(policyOptions);

  const toolSet: ToolRuntimePort['toolSet'] = async (runId, { signal, env, additionalTools, only }) => {
    const run = store.getRun(runId);
    if (run === undefined) throw new Error(`run ${runId} does not exist`);
    const session = store.getSession(run.sessionId);
    if (session === undefined) throw new Error(`session ${run.sessionId} does not exist`);
    const snapshot = settings.takeUserSnapshot();
    const trust = store.trust.decisionFor(session.cwd).decision;

    let acquiredHere = false;
    try {
      const loaded = await settings.loadSessionSettings(session.cwd, snapshot);
      const mcp = await loadSessionMcpServers({ home, settings }, session, env, snapshot.user);
      const sources: McpPool['sources'] = [];
      if (mcp.enabled.length > 0) {
        const servers = mcp.enabled;
        const key = sha256Hex(canonicalJson({ project: session.cwd, servers, trust: trust ?? 'unset', env: inheritedEnvOf(env) }));
        const acquired = mcpPools.acquire(runId, {
          key,
          create: () =>
            createPool({
              servers,
              projectDir: session.cwd,
              baseEnv: env,
              clock,
              timers,
              remote: mcpRemote,
              markers: { dir: paths.markers.mcp, onWarning: (message) => logger.warn(message) },
              closeGraceMs: MCP_CLOSE_GRACE_MS,
            }),
        });
        acquiredHere = acquired.changed;
        sources.push(...acquired.pool.sources);
      } else {
        mcpPools.release(runId);
      }

      const registry = createToolRegistry();
      for (const tool of createBuiltinTools()) registry.register(tool);
      for (const tool of additionalTools ?? []) registry.register(tool);
      for (const source of sources) registry.addSource(source);
      const set = await registry.snapshot({ signal, ...(only === undefined ? {} : { only }) });

      const notices = dedupe([
        ...loaded.warnings,
        ...mcp.warnings,
        ...mcp.failed.map((failure) => `MCP server ${failure.name} was skipped: ${failure.reason}`),
        ...mcp.pendingApproval.map((entry) => `MCP server ${entry.name} needs approval before it can run`),
        ...set.notices,
      ]);
      return { ...set, notices: Object.freeze(notices) } satisfies ToolSet;
    } catch (error) {
      if (acquiredHere) mcpPools.release(runId);
      throw signal.aborted ? signal.reason : error;
    }
  };

  const recoveryToolSet: ToolRuntimePort['recoveryToolSet'] = async ({ signal, additionalTools }) => {
    const registry = createToolRegistry();
    for (const tool of createBuiltinTools()) registry.register(tool);
    for (const tool of additionalTools ?? []) registry.register(tool);
    return registry.snapshot({ signal });
  };

  const port: ToolRuntimePort = {
    envFor: settings.envFor,
    toolSet,
    recoveryToolSet,
    policyFor,
    recoveryContextFor,
    executor,
    sandbox,
    shellHost: options.shellHost,
    markerDir: paths.markers.tools,
    sessionState: (session) => sessionStates.get(session),
  };

  return { port, mcpPools, mcpAdmin, sessionStates, jobs, inFlightKeys: () => new Set([...executor.inFlightKeys(), ...jobs.liveKeys()]) };
};
