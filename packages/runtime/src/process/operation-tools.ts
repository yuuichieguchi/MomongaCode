import os from 'node:os';
import { createExecWithStdin, createGivenSecretStore, createOutboundDispatcher, findOutboundError, givenSecretStoreChildEnv, minimalChildEnv, outboundFetch, protectedSetFor } from '@momonga/foundation';
import type { MomongaPaths, OutboundNetwork, ProcessInspector, SecretStore } from '@momonga/foundation';
import { askedBy, computeFileRules } from '@momonga/policy';
import type { PolicyHostPorts } from '@momonga/policy';
import { buildSandboxPolicy, createForgeAccess, createOperationTools, createSandboxedArgvRunner, forgeCredentialOf, loadForgeDescriptors } from '@momonga/tools';
import type { AnyTool, ForgeCredentialReference, ForgeFetch, MarkerOwners, ProbeContext, ReconcileSandbox, ShellHost } from '@momonga/tools';
import type { SandboxBindings } from '../ports.ts';
import type { UserSnapshot } from './settings-port.ts';

export type OperationToolsOptions = {
  paths: MomongaPaths;
  home: string;
  sandboxes: SandboxBindings;
  fs: PolicyHostPorts;
  network: OutboundNetwork;
  shellHost: ShellHost;
  owners: MarkerOwners;
  inspector: ProcessInspector;
  secretStore?: () => SecretStore;
  environment?: Readonly<Record<string, string | undefined>>;
  forgeFetch?: ForgeFetch;
};

const outboundForgeFetch =
  (network: OutboundNetwork): ForgeFetch =>
  async (url, { boundMs, ...init }) => {
    const dispatcher = createOutboundDispatcher(network, { connectReplyTimeoutMs: boundMs });
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

export const createOperationToolSource = (options: OperationToolsOptions): ((snapshot: UserSnapshot) => AnyTool[]) => {
  const environment = options.environment ?? process.env;
  const secretStore = options.secretStore ?? (() => createGivenSecretStore(createExecWithStdin({ ...minimalChildEnv(process.env), ...givenSecretStoreChildEnv(process.env) }), process.env));

  const reconcileSandbox = async (context: ProbeContext): Promise<ReconcileSandbox> => {
    const held = await options.sandboxes.acquire(context.signal);
    const roots = [...context.roots];
    const ports = askedBy(options.fs, context.signal);
    const sandboxPolicy = await buildSandboxPolicy(
      {
        roots,
        home: options.home,
        ...(context.tmpDir === undefined ? {} : { tmpDir: context.tmpDir }),
        sessionsTmpRoot: options.paths.tmp.sessions,
        fileRules: await computeFileRules([], roots, context.tmpDir ?? null, held.value.ruleEnforcement, ports),
        protectedSet: await protectedSetFor(roots, ports),
        network: 'deny',
      },
      context.signal,
    );
    return { sandbox: held.value.sandbox, sandboxPolicy, release: held.release };
  };

  const readCredential = async (reference: ForgeCredentialReference, signal: AbortSignal): Promise<string> => {
    if ('secret' in reference) return secretStore().read(reference.secret, signal);
    const value = environment[reference.env];
    if (value === undefined || value === '') throw new Error(`the environment variable ${reference.env} named by a forge credential is not set in the runtime`);
    return value;
  };

  const runArgv = createSandboxedArgvRunner({ reconcileSandbox, shellHost: options.shellHost, outboundNetwork: options.network, markerDir: options.paths.markers.tools, credentialRoot: os.tmpdir(), owners: options.owners, inspector: options.inspector });
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
