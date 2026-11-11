import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { credentialEnvNames, stopValuesOfSettings } from '@momonga/config';
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
  generationMarkerDirectories,
  inspectProcessLock,
  generationLayout,
  generationOfDirectoryName,
  nodeFileSystem,
  releaseSessionScratch,
  hostInspectorPorts,
  ruleEnforcementOf,
  sha256Hex,
} from '@momonga/foundation';
import type { Clock, CredentialSecretStore, JsonLogger, KernelLockMechanism, LockCapabilityProbe, MomongaPaths, OutboundNetwork, ProcessInspector, ReapTiming, RolePort, RuleEnforcement, SecretStore, SessionScratch } from '@momonga/foundation';
import { createMcpPool, inheritedEnvOf, mcpCredentialDirectory } from '@momonga/mcp';
import type { McpAuthorizingPool, McpPool, McpPoolOptions, McpRemotePorts } from '@momonga/mcp';
import type { SandboxBindings } from '../ports.ts';
import type { RuntimeStore } from '@momonga/store';
import { createBuiltinTools, createGitWorkTreeObserver, createHostRipgrepLocator, createMarkerOwners, createPolicyFilesystem, createToolExecutor, createToolRegistry } from '@momonga/tools';
import type { BundledRipgrepResolver, ForgeFetch, MarkerOwners, ShellHost, ToolSet, UserPolicy, WorkTreeObserver } from '@momonga/tools';
import type { PolicyHostFilesystem } from '@momonga/policy';
import type { ToolRuntimePort } from '../ports.ts';
import type { RunNotifier } from '../service/notifier.ts';
import type { ServiceTimers } from '../service/timers.ts';
import { createBackgroundJobs } from './background-jobs.ts';
import { createOperationToolSource } from './operation-tools.ts';
import { createNodeJobMarkerFiles } from './job-marker-files.ts';
import type { BackgroundJobRegistry } from './background-jobs.ts';
import { SANDBOX_KILL_GRACE_MS } from './constants.ts';
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
  sharedPaths: MomongaPaths;
  generation: number;
  role: Pick<RolePort, 'current'>;
  onJobSettled?: () => void;
  onAuthorizationEnded?: () => void;
  home: string;
  version: string;
  store: RuntimeStore;
  notifier: Pick<RunNotifier, 'watchRun'>;
  clock: Clock;
  timers: ServiceTimers;
  logger: JsonLogger;
  report(error: unknown): void;
  sandboxes: SandboxBindings;
  forgeSecretStore?: () => SecretStore;
  forgeEnvironment?: Readonly<Record<string, string | undefined>>;
  forgeFetch?: ForgeFetch;
  shellHost: ShellHost;
  settings: Pick<SettingsComposition, 'envFor' | 'takeUserSnapshot' | 'admitUserSnapshot' | 'keptLayers' | 'loadSessionSettings' | 'trustOracle'>;
  reapTiming: ReapTiming;
  leaseMs: number;
  heartbeatMs: number;
  createPool?: (options: McpPoolOptions) => McpPool;
  createAdminPool?: (options: McpPoolOptions) => McpAuthorizingPool;
  mcpRemote?: McpRemotePorts;
  network: OutboundNetwork;
  credentialSecretStore?: CredentialSecretStore;
  ensureSessionTmpDir?: (paths: MomongaPaths, sessionId: string) => Promise<SessionScratch>;
  policyFilesystem?: PolicyHostFilesystem;
  bundledRipgrep?: BundledRipgrepResolver;
  owners?: MarkerOwners;
};

export type ToolRuntime = {
  port: ToolRuntimePort;
  userPolicy: UserPolicy;
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
    network: options.network,
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
    generation: options.generation,
    jobsDir: paths.jobs,
    role: options.role,
    ...(options.onJobSettled === undefined ? {} : { onSettled: options.onJobSettled }),
    markerDirOf: (ownerGeneration) => generationMarkerDirectories(options.sharedPaths, ownerGeneration).tools,
    ownerAlive: async (ownerGeneration) =>
      (await inspectProcessLock(generationLayout(home, ownerGeneration).locks.runtime, options.kernelLock === undefined ? {} : { mechanism: options.kernelLock })).state !== 'free',
    markerFiles: createNodeJobMarkerFiles(lockCapability),
    killGraceMs: SANDBOX_KILL_GRACE_MS,
    reapTiming,
    onWarning: (message) => logger.warn(message),
    report,
  });
  const executor = createToolExecutor({
    jobs,
    outboundNetwork: options.network,
    fs: policyFilesystem,
    leaseMs: options.leaseMs,
    heartbeatMs: options.heartbeatMs,
    idempotency: store.idempotency,
    blobs: store.blobs,
    clock,
    processMarkerDir: paths.markers.tools,
    earlierMarkerDirs: async () =>
      (await nodeFileSystem.readdir(options.sharedPaths.markers.root))
        .map(generationOfDirectoryName)
        .filter((generation): generation is number => generation !== undefined)
        .map((generation) => generationMarkerDirectories(options.sharedPaths, generation).tools),
    owners,
    callLockDir: paths.callLocks,
    ...(options.kernelLock === undefined ? {} : { kernelLock: options.kernelLock }),
    onWarning: (message) => logger.warn(message),
    reap: { timing: reapTiming, inspector },
  });
  const readCloseGraceMs = (): number => stopValuesOfSettings(settings.takeUserSnapshot().settings).mcpCloseGraceMs;
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
    clientVersion: options.version,
    readCloseGraceMs,
    readConnectTimeoutMs: () => settings.takeUserSnapshot().settings.mcp.connectTimeoutMs,
    markers: { dir: paths.markers.mcp, onWarning: (message) => logger.warn(message) },
    ...(options.onAuthorizationEnded === undefined ? {} : { onAuthorizationEnded: options.onAuthorizationEnded }),
  });
  const mcpPools = createMcpPoolCache({ store, notifier, timers, logger, report, readCloseGraceMs });
  const sessionStates = createSessionStates({ clock, store, logger, releaseScratch: (sessionId) => releaseSessionScratch(path.join(paths.tmp.sessions, sessionId)) });
  const policyOptions = { paths, home, fs: policyFilesystem, sessionStates, ensureSessionTmpDir };
  const policyBuilders = new Map<RuleEnforcement, EnforcedPolicyFor>();
  const policyFor: ToolRuntimePort['policyFor'] = async (session, request) => {
    const builder = policyBuilders.get(request.ruleEnforcement) ?? createPolicyFor({ ...policyOptions, ruleEnforcement: request.ruleEnforcement });
    policyBuilders.set(request.ruleEnforcement, builder);
    const { sandboxNetwork, sandboxUnixSockets } = settings.takeUserSnapshot().settings;
    return { ...(await builder(session, { ...request, unixSocketAllow: sandboxUnixSockets.allow })), sandboxNetwork };
  };
  const recoveryContextFor = createRecoveryContextFor(policyOptions);
  const operationTools = createOperationToolSource({
    paths,
    home,
    sandboxes,
    fs: policyFilesystem,
    network: options.network,
    shellHost: options.shellHost,
    owners,
    inspector,
    ...(options.forgeSecretStore === undefined ? {} : { secretStore: options.forgeSecretStore }),
    ...(options.forgeEnvironment === undefined ? {} : { environment: options.forgeEnvironment }),
    ...(options.forgeFetch === undefined ? {} : { forgeFetch: options.forgeFetch }),
  });

  const toolSet: ToolRuntimePort['toolSet'] = async (runId, { signal, env, additionalTools, only }) => {
    const run = store.getRun(runId);
    if (run === undefined) throw new Error(`run ${runId} does not exist`);
    const session = store.getSession(run.sessionId);
    if (session === undefined) throw new Error(`session ${run.sessionId} does not exist`);
    const snapshot = settings.takeUserSnapshot();
    const trust = (await store.trust.decisionAsked(session.cwd, signal)).decision;

    let acquiredHere = false;
    try {
      const loaded = await settings.loadSessionSettings(session.cwd, snapshot);
      const mcp = await loadSessionMcpServers({ home, settings }, session, env, snapshot.user, 'read', signal);
      const sources: McpPool['sources'] = [];
      if (mcp.enabled.length > 0) {
        const servers = mcp.enabled;
        const { toolIdleTimeoutMs, toolTotalTimeoutMs, connectTimeoutMs } = loaded.settings.mcp;
        const callBounds = {
          ...(toolIdleTimeoutMs === undefined ? {} : { toolIdleTimeoutMs }),
          ...(toolTotalTimeoutMs === undefined ? {} : { toolTotalTimeoutMs }),
          ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
        };
        const { credentials } = loaded.settings;
        const credentialNames = credentialEnvNames(loaded.settings.models);
        const key = sha256Hex(canonicalJson({ project: session.cwd, servers, trust: trust ?? 'unset', env: inheritedEnvOf(env), credentials, credentialNames, ...(Object.keys(callBounds).length === 0 ? {} : { callBounds }) }));
        const acquired = mcpPools.acquire(runId, {
          key,
          create: () =>
            createPool({
              servers,
              projectDir: session.cwd,
              baseEnv: env,
              clock,
              clientVersion: options.version,
              credentials,
              credentialNames,
              timers,
              remote: mcpRemote,
              markers: { dir: paths.markers.mcp, onWarning: (message) => logger.warn(message) },
              closeGraceMs: readCloseGraceMs,
              ...callBounds,
            }),
        });
        acquiredHere = acquired.changed;
        sources.push(...acquired.pool.sources);
      } else {
        mcpPools.release(runId);
      }

      const registry = createToolRegistry();
      for (const tool of createBuiltinTools()) registry.register(tool);
      for (const tool of operationTools(snapshot)) registry.register(tool);
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
    for (const tool of operationTools(settings.takeUserSnapshot())) registry.register(tool);
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

  return { port, userPolicy: executor, mcpPools, mcpAdmin, sessionStates, jobs, owners, inspector };
};
