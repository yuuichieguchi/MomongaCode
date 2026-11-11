import { createExecWithStdin, createGivenSecretStore, createOutboundDispatcher, findOutboundError, givenSecretStoreChildEnv, minimalChildEnv, outboundFetch } from '@momonga/foundation';
import type { HelperSelf, MomongaPaths, ProcessInspector, SecretStore } from '@momonga/foundation';
import type { PolicyHostPorts } from '@momonga/policy';
import { createForgeAccess, createOperationTools, createSandboxedArgvRunner, forgeCredentialOf, loadForgeDescriptors } from '@momonga/tools';
import type { AnyTool, ForgeCredentialReference, ForgeFetch, MarkerOwners, ProbeContext, ReconcileSandbox, ShellHost } from '@momonga/tools';
import type { SandboxBindings } from '../ports.ts';
import type { NetworkOf } from './network-derivation.ts';
import { toolSandboxPolicyOf } from './tool-policy.ts';
import type { UserSnapshot } from './settings-port.ts';

export type OperationToolsOptions = {
  paths: MomongaPaths;
  home: string;
  sandboxes: SandboxBindings;
  fs: PolicyHostPorts;
  network: NetworkOf;
  shellHost: ShellHost;
  owners: MarkerOwners;
  inspector: ProcessInspector;
  secretStore?: () => SecretStore;
  forgeFetch?: ForgeFetch;
  helperSelf?: HelperSelf;
};

export const outboundForgeFetch =
  (networkOf: NetworkOf): ForgeFetch =>
  async (url, { boundMs, ...init }) => {
    const { outbound } = await networkOf(init.signal);
    const dispatcher = createOutboundDispatcher(outbound, { connectReplyTimeoutMs: boundMs });
    try {
      const response = await outboundFetch(dispatcher)(url, init);
      const body = await response.arrayBuffer();
      return new Response(body.byteLength === 0 ? null : body, { status: response.status, headers: [...response.headers] });
    } catch (error) {
      throw findOutboundError(error) ?? error;
    } finally {
      await dispatcher.destroy();
    }
  };

export type ReconcileSandboxOptions = Pick<OperationToolsOptions, 'paths' | 'home' | 'sandboxes' | 'fs'>;

export const createReconcileSandbox =
  (options: ReconcileSandboxOptions) =>
  async (context: ProbeContext): Promise<ReconcileSandbox> => {
    const held = await options.sandboxes.acquire(context.signal);
    try {
      const sessionRoots = context.roots.filter((root) => root !== context.tmpDir);
      const sandboxPolicy = await toolSandboxPolicyOf(
        { paths: options.paths, home: options.home, fs: options.fs, ruleEnforcement: held.value.ruleEnforcement },
        { roots: sessionRoots, tmpDir: context.tmpDir, rules: [], gitConfigFiles: [], readableDirectories: [] },
        context.signal,
      );
      return { sandbox: held.value.sandbox, sandboxPolicy, release: held.release };
    } catch (error) {
      held.release();
      throw error;
    }
  };

export const forgeCredentialReader =
  (secretStore: () => SecretStore) =>
  async (reference: ForgeCredentialReference, signal: AbortSignal): Promise<string> => {
    if ('secret' in reference) return secretStore().read(reference.secret, signal);
    const value = process.env[reference.env];
    if (value === undefined || value === '') throw new Error(`the environment variable ${reference.env} named by a forge credential is not set in the runtime`);
    return value;
  };

export const createOperationToolSource = (options: OperationToolsOptions): ((snapshot: UserSnapshot) => AnyTool[]) => {
  const secretStore = options.secretStore ?? (() => createGivenSecretStore(createExecWithStdin({ ...minimalChildEnv(process.env), ...givenSecretStoreChildEnv(process.env) }), process.env));

  const reconcileSandbox = createReconcileSandbox(options);

  const readCredential = forgeCredentialReader(secretStore);

  const runArgv = createSandboxedArgvRunner({
    reconcileSandbox,
    shellHost: options.shellHost,
    outboundNetwork: async (signal) => (await options.network(signal)).outbound,
    markerDir: options.paths.markers.tools,
    credentialRoot: options.paths.tmp.spawn,
    ...(options.helperSelf === undefined ? {} : { credentialHelper: options.helperSelf }),
    owners: options.owners,
    inspector: options.inspector,
  });
  const fetch = options.forgeFetch ?? outboundForgeFetch(options.network);
  const descriptors = loadForgeDescriptors();

  return (snapshot) => {
    const { forges, operations } = snapshot.settings;
    return createOperationTools({
      runArgv,
      forge: createForgeAccess({
        descriptors,
        instances: (forges ?? []).map((forge) => ({ id: forge.id, descriptor: forge.descriptor, host: forge.host, apiBaseUrl: forge.apiBaseUrl, credential: forgeCredentialOf(forge) })),
        readCredential,
        fetch,
      }),
      settings: operations ?? {},
    });
  };
};
