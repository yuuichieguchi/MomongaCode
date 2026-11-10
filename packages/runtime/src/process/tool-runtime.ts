import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { credentialEnvNames } from '@momonga/config';
import {
  canonicalJson,
  createEncryptedCredentialStore,
  createExecWithStdin,
  createLockCapability,
  givenCredentialSecretStore,
  givenSecretStoreChildEnv,
  minimalChildEnv,
  hostProcessInspector,
  ensureSessionTmpDir as defaultEnsureSessionTmpDir,
  hostInspectorPorts,
  ruleEnforcementOf,
  sha256Hex,
} from '@momonga/foundation';
import type { Clock, CredentialSecretStore, JsonLogger, KernelLockMechanism, LockCapabilityProbe, MomongaPaths, ProcessInspector, ReapTiming, RuleEnforcement } from '@momonga/foundation';
import { createMcpPool, inheritedEnvOf, mcpCredentialDirectory } from '@momonga/mcp';
import type { McpAuthorizingPool, McpPool, McpPoolOptions, McpRemotePorts } from '@momonga/mcp';
import type { SandboxBindings } from '../ports.ts';
import type { RuntimeStore } from '@momonga/store';
import { createBuiltinTools, createGitWorkTreeObserver, createHostRipgrepLocator, createMarkerOwners, createPolicyFilesystem, createToolExecutor, createToolRegistry } from '@momonga/tools';
import type { BundledRipgrepResolver, MarkerOwners, ShellHost, ToolSet, WorkTreeObserver } from '@momonga/tools';
import type { PolicyHostFilesystem } from '@momonga/policy';
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
import type { EnforcedPolicyFor } from './tool-policy.ts';

export type ToolRuntimeOptions = {
  lockCapability?: LockCapabilityProbe;
  kernelLock?: KernelLockMechanism;
  paths: MomongaPaths;
  home: string;
  store: RuntimeStore;
  notifier: Pick<RunNotifier, 'watchRun'>;
  clock: Clock;
  timers: ServiceTimers;
  logger: JsonLogger;
  report(error: unknown): void;
  sandboxes: SandboxBindings;
  shellHost: ShellHost;
  settings: Pick<SettingsComposition, 'envFor' | 'takeUserSnapshot' | 'admitUserSnapshot' | 'keptLayers' | 'loadSessionSettings' | 'trustOracle'>;
  reapTiming: ReapTiming;
  leaseMs: number;
  heartbeatMs: number;
  createPool?: (options: McpPoolOptions) => McpPool;
  createAdminPool?: (options: McpPoolOptions) => McpAuthorizingPool;
  mcpRemote?: McpRemotePorts;
  credentialSecretStore?: CredentialSecretStore;
  ensureSessionTmpDir?: (paths: MomongaPaths, sessionId: string) => Promise<string>;
  policyFilesystem?: PolicyHostFilesystem;
  bundledRipgrep?: BundledRipgrepResolver;
  owners?: MarkerOwners;
};

export type ToolRuntime = {
  port: ToolRuntimePort;
  mcpPools: McpPoolCache;
  mcpAdmin: McpAdmin;
  sessionStates: SessionStates;
  jobs: BackgroundJobRegistry;
  owners: MarkerOwners;
  inspector: ProcessInspector;
};

const dedupe = (notices: readonly string[]): string[] => [...new Set(notices)];

export const createToolRuntime = (options: ToolRuntimeOptions): ToolRuntime => {
  const { paths, home, store, notifier, clock, timers, logger, report, sandboxes, settings, reapTiming } = options;
  if (!path.isAbsolute(home)) throw new TypeError(`home must be an absolute path, got ${home}`);
  const createPool = options.createPool ?? createMcpPool;
  const mcpRemote: McpRemotePorts = options.mcpRemote ?? {
    credentials: createEncryptedCredentialStore({
      directory: mcpCredentialDirectory(paths),
      stateDirectory: paths.state,
      secretStore: options.credentialSecretStore ?? givenCredentialSecretStore(createExecWithStdin({ ...minimalChildEnv(process.env), ...givenSecretStoreChildEnv(process.env) }), process.env),
      plaintextTokenFiles: () => settings.takeUserSnapshot().settings.credentials.plaintextTokenFiles,
    }),
    randomToken: () => randomBytes(32).toString('base64url'),
    openAuthorizationUrl: () => Promise.reject(new Error('the daemon never opens a browser; authorization URLs are handed to the client through the Run API')),
  };
  const ensureSessionTmpDir = options.ensureSessionTmpDir ?? defaultEnsureSessionTmpDir;

  const policyFilesystem = options.policyFilesystem ?? createPolicyFilesystem();
  const lockCapability = options.lockCapability ?? createLockCapability({ proofDir: paths.lockProof });
  const inspector = hostProcessInspector({ ...hostInspectorPorts(), capability: lockCapability });
  const owners = options.owners ?? createMarkerOwners();
  const jobs = createBackgroundJobs({
    store,
    owners,
    clock,
    timers,
    markerDir: paths.markers.tools,
    markerFiles: createNodeJobMarkerFiles(lockCapability),
    killGraceMs: SANDBOX_KILL_GRACE_MS,
    reapTiming,
    onWarning: (message) => logger.warn(message),
    report,
  });
  const executor = createToolExecutor({
    jobs,
    fs: policyFilesystem,
    leaseMs: options.leaseMs,
    heartbeatMs: options.heartbeatMs,
    idempotency: store.idempotency,
    blobs: store.blobs,
    clock,
    processMarkerDir: paths.markers.tools,
    owners,
    callLockDir: paths.callLocks,
    ...(options.kernelLock === undefined ? {} : { kernelLock: options.kernelLock }),
    onWarning: (message) => logger.warn(message),
    reap: { timing: reapTiming, inspector },
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
    markers: { dir: paths.markers.mcp, onWarning: (message) => logger.warn(message) },
  });
  const mcpPools = createMcpPoolCache({ store, notifier, timers, logger, report });
  const sessionStates = createSessionStates({ clock, store, logger });
  const policyOptions = { paths, home, fs: policyFilesystem, sessionStates, ensureSessionTmpDir };
  const policyBuilders = new Map<RuleEnforcement, EnforcedPolicyFor>();
  const policyFor: ToolRuntimePort['policyFor'] = (session, request) => {
    const builder = policyBuilders.get(request.ruleEnforcement) ?? createPolicyFor({ ...policyOptions, ruleEnforcement: request.ruleEnforcement });
    policyBuilders.set(request.ruleEnforcement, builder);
    return builder(session, request);
  };
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
      const mcp = await loadSessionMcpServers({ home, settings }, session, env, snapshot.user, 'read');
      const sources: McpPool['sources'] = [];
      if (mcp.enabled.length > 0) {
        const servers = mcp.enabled;
        const callBounds = loaded.settings.mcp;
        const { credentials } = loaded.settings;
        const credentialNames = credentialEnvNames(loaded.settings);
        const key = sha256Hex(canonicalJson({ project: session.cwd, servers, trust: trust ?? 'unset', env: inheritedEnvOf(env), credentials, credentialNames, ...(Object.keys(callBounds).length === 0 ? {} : { callBounds }) }));
        const acquired = mcpPools.acquire(runId, {
          key,
          create: () =>
            createPool({
              servers,
              projectDir: session.cwd,
              baseEnv: env,
              clock,
              credentials,
              credentialNames,
              timers,
              remote: mcpRemote,
              markers: { dir: paths.markers.mcp, onWarning: (message) => logger.warn(message) },
              closeGraceMs: MCP_CLOSE_GRACE_MS,
              ...(callBounds.toolIdleTimeoutMs === undefined ? {} : { toolIdleTimeoutMs: callBounds.toolIdleTimeoutMs }),
              ...(callBounds.toolTotalTimeoutMs === undefined ? {} : { toolTotalTimeoutMs: callBounds.toolTotalTimeoutMs }),
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

  const observers = new Map<string, WorkTreeObserver>();

  const port: ToolRuntimePort = {
    envFor: settings.envFor,
    toolSet,
    recoveryToolSet,
    policyFor,
    recoveryContextFor,
    executor,
    sandboxes,
    ripgrepLocator: (env) =>
      createHostRipgrepLocator({
        setting: settings.takeUserSnapshot().settings.tools.ripgrep,
        env,
        ...(options.bundledRipgrep === undefined ? {} : { bundled: options.bundledRipgrep }),
      }),
    shellHost: options.shellHost,
    markerDir: paths.markers.tools,
    owners,
    lockCapability,
    inspector,
    sessionState: (session) => sessionStates.get(session),
    workTreeObserver: (session, trusted) => {
      const key = `${trusted ? 'trusted' : 'untrusted'}\n${session.cwd}`;
      const known = observers.get(key);
      if (known !== undefined) return known;
      const created = createGitWorkTreeObserver({ storeDir: path.join(paths.state, 'observer', sha256Hex(session.cwd)), workTree: session.cwd, trusted });
      observers.set(key, created);
      return created;
    },
  };

  return { port, mcpPools, mcpAdmin, sessionStates, jobs, owners, inspector };
};
