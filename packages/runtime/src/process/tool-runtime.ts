import { randomBytes } from 'node:crypto';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { credentialNamesOf, stopValuesOfSettings } from '@momonga/config';
import {
  canonicalJson,
  createEncryptedCredentialStore,
  createExecWithStdin,
  givenCredentialSecretStore,
  givenSecretStoreChildEnv,
  minimalChildEnv,
  generationMarkerDirectories,
  inspectProcessLock,
  generationLayout,
  generationOfDirectoryName,
  nodeFileSystem,
  releaseSessionScratch,
  ruleEnforcementOf,
  sha256Hex,
  layoutProcessInspector,
  systemRandom,
} from '@momonga/foundation';
import type { Clock, CredentialSecretStore, HelperSelf, JsonLogger, KernelLockMechanism, LockCapabilityProbe, MomongaPaths, ProcessInspector, Timing, RolePort, RuleEnforcement, SandboxNetworkSetting, SecretStore, SessionScratch } from '@momonga/foundation';
import { createMcpPool, inheritedEnvOf, mcpCredentialDirectory, systemResolver } from '@momonga/mcp';
import type { McpAuthorizingPool, McpPool, McpPoolOptions, McpRemotePorts, StdioLaunch } from '@momonga/mcp';
import type { SandboxBindings } from '../ports.ts';
import type { RuntimeStore, Session } from '@momonga/store';
import { holdSandbox } from '../worker/held-sandbox.ts';
import { createBuiltinTools, offeredBashOf, createGitWorkTreeObserver, createHostRipgrepLocator, createMarkerOwners, createPolicyFilesystem, createToolExecutor, createToolRegistry } from '@momonga/tools';
import type { BuiltinToolOffer, BundledRipgrepResolver, ForgeAccess, ForgeFetch, MarkerOwners, ShellHost, ToolSet, UserPolicy, WorkTreeObserver } from '@momonga/tools';
import type { PolicyHostFilesystem } from '@momonga/policy';
import type { ToolEnv, ToolRuntimePort } from '../ports.ts';
import type { RunNotifier } from '../service/notifier.ts';
import type { ServiceTimers } from '../service/timers.ts';
import { createBackgroundJobs } from './background-jobs.ts';
import { createOperationToolSource } from './operation-tools.ts';
import type { UserSnapshot } from './settings-port.ts';
import { createNodeJobMarkerFiles } from './job-marker-files.ts';
import type { BackgroundJobRegistry } from './background-jobs.ts';
import { SANDBOX_KILL_GRACE_MS } from './constants.ts';
import { createMcpAdmin, loadSessionMcpServers } from './mcp-admin.ts';
import type { McpAdmin } from './mcp-admin.ts';
import { createMcpPoolCache } from './mcp-pool-cache.ts';
import type { NetworkOf } from './network-derivation.ts';
import type { McpPoolCache } from './mcp-pool-cache.ts';
import { createSessionStates } from './session-states.ts';
import type { SessionStates } from './session-states.ts';
import type { SettingsComposition } from './settings-port.ts';
import { createPolicyFor, createRecoveryContextFor } from './tool-policy.ts';
import type { EnforcedPolicyFor } from './tool-policy.ts';

export const sandboxNetworkOf = (session: Pick<Session, 'sandboxNetwork'>, setting: SandboxNetworkSetting): SandboxNetworkSetting => session.sandboxNetwork ?? setting;

export type ToolRuntimeOptions = {
  mcpLaunch: StdioLaunch;
  lockCapability: LockCapabilityProbe;
  kernelLock: KernelLockMechanism;
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
  forgeFetch?: ForgeFetch;
  helperSelf?: HelperSelf;
  shellHost: ShellHost;
  settings: Pick<SettingsComposition, 'envFor' | 'referenceEnvFor' | 'takeUserSnapshot' | 'userSnapshot' | 'admitUserSnapshot' | 'keptLayers' | 'loadSessionSettings' | 'trustOracle'>;
  reapTiming: Timing;
  leaseMs: number;
  heartbeatMs: number;
  createPool?: (options: McpPoolOptions) => McpPool;
  createAdminPool?: (options: McpPoolOptions) => McpAuthorizingPool;
  mcpRemote?: Omit<McpRemotePorts, 'network'>;
  network: NetworkOf;
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
  forgeOf(snapshot: UserSnapshot): ForgeAccess;
};

const dedupe = (notices: readonly string[]): string[] => [...new Set(notices)];

export const createToolRuntime = (options: ToolRuntimeOptions): ToolRuntime => {
  const { paths, home, store, notifier, clock, timers, logger, report, sandboxes, settings, reapTiming } = options;
  if (!path.isAbsolute(home)) throw new TypeError(`home must be an absolute path, got ${home}`);
  const createPool = options.createPool ?? createMcpPool;
  const mcpRemote: Omit<McpRemotePorts, 'network'> = options.mcpRemote ?? {
    credentials: createEncryptedCredentialStore({
      directory: mcpCredentialDirectory(paths),
      stateDirectory: paths.state,
      secretStore: options.credentialSecretStore ?? givenCredentialSecretStore(createExecWithStdin({ ...minimalChildEnv(process.env), ...givenSecretStoreChildEnv(process.env) }), process.env),
      plaintextTokenFiles: () => settings.takeUserSnapshot().settings.credentials.plaintextTokenFiles,
      lock: options.kernelLock,
    }),
    randomToken: () => randomBytes(32).toString('base64url'),
    openAuthorizationUrl: () => Promise.reject(new Error('the daemon never opens a browser; authorization URLs are handed to the client through the Run API')),
    resolver: systemResolver,
  };

  const policyFilesystem = options.policyFilesystem ?? createPolicyFilesystem();
  const { lockCapability, kernelLock } = options;
  const inspector = layoutProcessInspector(lockCapability);
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
      (await inspectProcessLock(generationLayout(home, ownerGeneration).locks.runtime, { mechanism: kernelLock })).state !== 'free',
    markerFiles: createNodeJobMarkerFiles(lockCapability),
    files: nodeFileSystem,
    inspector,
    killGraceMs: SANDBOX_KILL_GRACE_MS,
    reapTiming,
    onWarning: (message) => logger.warn(message),
    report,
  });
  const executor = createToolExecutor({
    jobs,
    hostParallelism: availableParallelism(),
    outboundNetwork: async (signal) => (await options.network(signal)).outbound,
    fs: policyFilesystem,
    leaseMs: options.leaseMs,
    heartbeatMs: options.heartbeatMs,
    idempotency: store.idempotency,
    blobs: store.blobs,
    clock,
    shellHost: options.shellHost,
    random: systemRandom,
    files: nodeFileSystem,
    processMarkerDir: paths.markers.tools,
    earlierMarkerDirs: async () =>
      (await nodeFileSystem.readdir(options.sharedPaths.markers.root))
        .map(generationOfDirectoryName)
        .filter((generation): generation is number => generation !== undefined)
        .map((generation) => generationMarkerDirectories(options.sharedPaths, generation).tools),
    owners,
    callLockDir: paths.callLocks,
    layout: paths,
    kernelLock,
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
    network: options.network,
    createPool: options.createAdminPool ?? createMcpPool,
    clientVersion: options.version,
    readCloseGraceMs,
    readConnectTimeoutMs: () => settings.takeUserSnapshot().settings.mcp.connectTimeoutMs,
    markers: { dir: paths.markers.mcp, inspector, onWarning: (message) => logger.warn(message) },
    launch: options.mcpLaunch,
    ...(options.onAuthorizationEnded === undefined ? {} : { onAuthorizationEnded: options.onAuthorizationEnded }),
  });
  const mcpPools = createMcpPoolCache({ store, notifier, timers, logger, report, readCloseGraceMs });
  const sessionStates = createSessionStates({ clock, store, logger, releaseScratch: (sessionId) => releaseSessionScratch(path.join(paths.tmp.sessions, sessionId)) });
  const policyOptions = { paths, home, fs: policyFilesystem, sessionStates, lock: kernelLock, ...(options.ensureSessionTmpDir === undefined ? {} : { ensureSessionTmpDir: options.ensureSessionTmpDir }) };
  const policyBuilders = new Map<RuleEnforcement, EnforcedPolicyFor>();
  const policyFor: ToolRuntimePort['policyFor'] = async (session, request) => {
    const builder = policyBuilders.get(request.ruleEnforcement) ?? createPolicyFor({ ...policyOptions, ruleEnforcement: request.ruleEnforcement });
    policyBuilders.set(request.ruleEnforcement, builder);
    const { sandboxNetwork, sandboxUnixSockets } = settings.takeUserSnapshot().settings;
    return { ...(await builder(session, { ...request, unixSocketAllow: sandboxUnixSockets.allow })), sandboxNetwork: sandboxNetworkOf(session, sandboxNetwork) };
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
    ...(options.forgeFetch === undefined ? {} : { forgeFetch: options.forgeFetch }),
    ...(options.helperSelf === undefined ? {} : { helperSelf: options.helperSelf }),
  });

  const builtinOfferOf = async (session: Session, env: ToolEnv, signal: AbortSignal): Promise<BuiltinToolOffer> => {
    const held = await holdSandbox(sandboxes, signal);
    const kind = held.sandbox.kind;
    held.done();
    return { sandbox: kind, sandboxNetwork: sandboxNetworkOf(session, settings.takeUserSnapshot().settings.sandboxNetwork), bash: await offeredBashOf(options.shellHost, env) };
  };

  const toolSet: ToolRuntimePort['toolSet'] = async (runId, { signal, env, additionalTools, only }) => {
    const run = store.getRun(runId);
    if (run === undefined) throw new Error(`run ${runId} does not exist`);
    const session = store.getSession(run.sessionId);
    if (session === undefined) throw new Error(`session ${run.sessionId} does not exist`);
    const snapshot = await settings.userSnapshot(signal);
    const trust = (await store.trust.decisionAsked(session.cwd, signal)).decision;
    const network = await options.network(signal);

    let acquiredHere = false;
    try {
      const loaded = await settings.loadSessionSettings(session.cwd, snapshot, signal);
      const mcp = await loadSessionMcpServers({ home, settings }, session, env, snapshot, 'read', signal);
      const sources: McpPool['sources'] = [];
      if (mcp.enabled.length > 0) {
        const servers = mcp.enabled;
        const { toolIdleTimeoutNetworkMs, toolIdleTimeoutStdioMs, toolTotalTimeoutMs, connectTimeoutMs } = loaded.settings.mcp;
        const callBounds = {
          ...(toolIdleTimeoutNetworkMs === undefined ? {} : { toolIdleTimeoutNetworkMs }),
          ...(toolIdleTimeoutStdioMs === undefined ? {} : { toolIdleTimeoutStdioMs }),
          ...(toolTotalTimeoutMs === undefined ? {} : { toolTotalTimeoutMs }),
          ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
        };
        const { credentials } = loaded.settings;
        const credentialNames = credentialNamesOf(loaded.settings);
        const key = sha256Hex(canonicalJson({ project: session.cwd, servers, trust: trust ?? 'unset', env: inheritedEnvOf(env), credentials, credentialNames, network: network.identity, ...(Object.keys(callBounds).length === 0 ? {} : { callBounds }) }));
        const acquired = mcpPools.acquire(runId, {
          key,
          create: () =>
            createPool({
              servers,
              projectDir: session.cwd,
              baseEnv: env,
              files: nodeFileSystem,
              launch: options.mcpLaunch,
              clock,
              clientVersion: options.version,
              credentials,
              credentialNames,
              timers,
              remote: { ...mcpRemote, network: network.outbound },
              markers: { dir: paths.markers.mcp, inspector, onWarning: (message) => logger.warn(message) },
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
      for (const tool of createBuiltinTools(await builtinOfferOf(session, env, signal))) registry.register(tool);
      if (trust === 'trusted') for (const tool of operationTools.tools(snapshot)) registry.register(tool);
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

  const recoveryToolSet: ToolRuntimePort['recoveryToolSet'] = async ({ signal, session, env, additionalTools }) => {
    const registry = createToolRegistry();
    for (const tool of createBuiltinTools(await builtinOfferOf(session, env, signal))) registry.register(tool);
    for (const tool of operationTools.tools(await settings.userSnapshot(signal))) registry.register(tool);
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
      const created = createGitWorkTreeObserver({ storeRoot: path.join(paths.state, 'observer'), cwd: session.cwd, trusted });
      observers.set(key, created);
      return created;
    },
  };

  return { port, userPolicy: executor, mcpPools, mcpAdmin, sessionStates, jobs, owners, inspector, forgeOf: operationTools.forge };
};
