import { createRedactor } from '@momonga/foundation';
import { ToolExecutionError } from '../types.ts';
import type { ForgeOperationName } from '../operations/spec.ts';
import { callForge } from './http.ts';
import type { ForgeAnswer, ForgeFetch, ForgeFields } from './http.ts';
import type { ForgeDescriptor } from './descriptor.ts';
import { hostedRemoteOf, parseRemoteUrl, splitRepository } from './remote.ts';

export type ForgeCredentialReference = { readonly env: string } | { readonly secret: string };

export type ForgeInstance = {
  readonly id: string;
  readonly descriptor: string;
  readonly hosts: readonly string[];
  readonly apiBaseUrl: string;
  readonly credential: ForgeCredentialReference;
};

export type ForgeRequest = {
  remoteUrl: string;
  operation: ForgeOperationName;
  args: Readonly<Record<string, string>>;
  signal: AbortSignal;
  boundMs: number;
};

export type ForgeGitCredential = { origin: string; username: string; password: string };

const GIT_TRANSPORT_SCHEME = 'https';
const GIT_REPOSITORY_ENDING = '.git';
const URL_FORM = /^[a-z][a-z0-9+.-]*:\/\//i;

const gitOriginOfHost = (host: string): string => new URL(`${GIT_TRANSPORT_SCHEME}://${host}`).origin;

export const gitOriginsOf = (instance: Pick<ForgeInstance, 'hosts'>): string[] => instance.hosts.map(gitOriginOfHost);

const canonicalHostOf = (host: string): string => new URL(`${GIT_TRANSPORT_SCHEME}://${host}`).host;

const originOfRemote = (remoteUrl: string): string | undefined => {
  const trimmed = remoteUrl.trim();
  return URL_FORM.test(trimmed) && URL.canParse(trimmed) ? new URL(trimmed).origin : undefined;
};

export type ForgeAccess = {
  request(request: ForgeRequest): Promise<ForgeAnswer>;
  gitCredential(remoteUrl: string, signal: AbortSignal): Promise<ForgeGitCredential | undefined>;
  gitDestination(remoteUrl: string): string | undefined;
};

export type ForgeAccessOptions = {
  descriptors: readonly ForgeDescriptor[];
  instances: readonly ForgeInstance[];
  readCredential(reference: ForgeCredentialReference, signal: AbortSignal): Promise<string>;
  fetch: ForgeFetch;
};

export const createForgeAccess = (options: ForgeAccessOptions): ForgeAccess => {
  const descriptorOf = (instance: ForgeInstance): ForgeDescriptor => {
    const descriptor = options.descriptors.find((candidate) => candidate.id === instance.descriptor);
    if (descriptor === undefined) throw new ToolExecutionError(`the forge ${instance.id} names the descriptor ${instance.descriptor}, which is not installed`);
    return descriptor;
  };
  return {
    gitDestination: (remoteUrl) => {
      const hosted = hostedRemoteOf(remoteUrl);
      const hostname = hosted === undefined ? undefined : canonicalHostOf(hosted.hostname);
      const origin = options.instances.flatMap(gitOriginsOf).find((candidate) => new URL(candidate).hostname === hostname);
      if (hosted === undefined || origin === undefined) return undefined;
      return `${origin}/${hosted.repo.split('/').map(encodeURIComponent).join('/')}${GIT_REPOSITORY_ENDING}`;
    },
    gitCredential: async (remoteUrl, signal) => {
      const origin = originOfRemote(remoteUrl);
      const instance = origin === undefined ? undefined : options.instances.find((candidate) => gitOriginsOf(candidate).includes(origin));
      if (origin === undefined || instance === undefined) return undefined;
      const descriptor = descriptorOf(instance);
      return { origin, username: descriptor.auth.gitUsername, password: await options.readCredential(instance.credential, signal) };
    },
    request: async ({ remoteUrl, operation, args, signal, boundMs }) => {
      const location = parseRemoteUrl(remoteUrl);
      const host = canonicalHostOf(location.host);
      const instance = options.instances.find((candidate) => candidate.hosts.map(canonicalHostOf).includes(host));
      if (instance === undefined) throw new ToolExecutionError(`no forge configured for host ${location.host}`);
      const descriptor = descriptorOf(instance);
      const credential = await options.readCredential(instance.credential, signal);
      const { owner, name } = splitRepository(location.repo);
      const redact = createRedactor({ credentials: [credential] }).whole;
      try {
        const answer = await callForge({ descriptor, apiBaseUrl: instance.apiBaseUrl, credential, variables: { owner, name, ...args }, operation, signal, boundMs, fetch: options.fetch });
        const clean = (fields: ForgeFields): ForgeFields => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, redact(value)]));
        return { status: answer.status, message: redact(answer.message), items: answer.items.map(clean), fields: clean(answer.fields) };
      } catch (error) {
        throw new ToolExecutionError(redact(error instanceof Error ? error.message : String(error)));
      }
    },
  };
};
