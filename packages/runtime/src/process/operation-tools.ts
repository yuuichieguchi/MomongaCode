import { createExecWithStdin, createGivenSecretStore, createOutboundDispatcher, findOutboundError, givenSecretStoreChildEnv, minimalChildEnv, outboundFetch } from '@momonga/foundation';
import type { HelperSelf, MomongaPaths, ProcessInspector, SecretStore } from '@momonga/foundation';
import type { PolicyHostPorts } from '@momonga/policy';
import { createForgeAccess, createOperationTools, createSandboxedArgvRunner, loadForgeDescriptors } from '@momonga/tools';
import type { AnyTool, ForgeAccess, ForgeCredentialReference, ForgeFetch, MarkerOwners, ProbeContext, ReconcileSandbox, ShellHost } from '@momonga/tools';
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
  drainIdleMs(): number;
};

export const outboundForgeFetch =
  (networkOf: NetworkOf): ForgeFetch =>
  async (url, { boundMs, ...init }) => {
    const { outbound } = await networkOf(init.signal);
    const dispatcher = createOutboundDispatcher(outbound, { connectReplyTimeoutMs: boundMs });
    let response: Response;
    try {
      response = await outboundFetch(dispatcher)(url, init);
    } catch (error) {
      await dispatcher.destroy();
      throw findOutboundError(error) ?? error;
    }
    const answered = { status: response.status, headers: [...response.headers] };
    if (response.body === null) {
      await dispatcher.destroy();
      return new Response(null, answered);
    }
    const source = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const step = await source.read().catch(async (error: unknown) => {
          await dispatcher.destroy();
          throw findOutboundError(error) ?? error;
        });
        if (step.done) {
          controller.close();
          await dispatcher.destroy();
        } else controller.enqueue(step.value);
      },
      cancel: async (reason) => {
        await source.cancel(reason);
        await dispatcher.destroy();
      },
    });
    return new Response(body, answered);
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

export type OperationToolSource = { tools(snapshot: UserSnapshot): AnyTool[]; forge(snapshot: UserSnapshot): ForgeAccess };

export const createOperationToolSource = (options: OperationToolsOptions): OperationToolSource => {
  const secretStore = options.secretStore ?? (() => createGivenSecretStore(createExecWithStdin({ ...minimalChildEnv(process.env), ...givenSecretStoreChildEnv(process.env) }), process.env));

  const reconcileSandbox = createReconcileSandbox(options);

  const readCredential = forgeCredentialReader(secretStore);

  const runArgv = createSandboxedArgvRunner({
    reconcileSandbox,
    shellHost: options.shellHost,
    outboundNetwork: async (signal) => (await options.network(signal)).outbound,
    markerDir: options.paths.markers.tools,
    drainIdleMs: options.drainIdleMs,
    credentialRoot: options.paths.tmp.spawn,
    ...(options.helperSelf === undefined ? {} : { credentialHelper: options.helperSelf }),
    owners: options.owners,
    inspector: options.inspector,
  });
  const fetch = options.forgeFetch ?? outboundForgeFetch(options.network);
  const descriptors = loadForgeDescriptors();

  const forge = (snapshot: UserSnapshot): ForgeAccess => createForgeAccess({ descriptors, instances: snapshot.settings.forges ?? [], readCredential, fetch });

  return {
    forge,
    tools: (snapshot) => createOperationTools({ runArgv, forge: forge(snapshot), settings: snapshot.settings.operations ?? {} }),
  };
};
