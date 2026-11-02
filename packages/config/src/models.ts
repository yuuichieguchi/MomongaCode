import path from 'node:path';
import { canonicalPath, comparableContains, isLoopbackHost } from '@momonga/foundation';
import { layoutOf } from './layout.ts';
import type {
  ChatCompletionsTarget,
  FmTarget,
  ModelAlias,
  ModelsSettings,
  ResolvedChatCompletionsTarget,
  ResolvedFmTarget,
  ResolvedModelTarget,
} from './settings.ts';

export type ResolvedModels = {
  aliases: Record<string, ModelAlias>;
  targets: Record<string, ResolvedModelTarget>;
};

export type ResolveModelsOptions = { source: string; home: string; warnings: string[] };

const DEFAULT_FM_NAME = 'fm';
const DEFAULT_ALIAS = 'default';

const resolveFm = (target: FmTarget): ResolvedFmTarget => ({
  adapter: 'fm',
  model: target.model ?? 'default',
  toolCalling: target.toolCalling ?? 'auto',
  maxConcurrency: target.maxConcurrency ?? 1,
  admissionTimeoutMs: target.admissionTimeoutMs ?? 30000,
});

const checkBaseUrl = (baseUrl: string, where: string): void => {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new Error(`${where}: baseUrl ${JSON.stringify(baseUrl)} is not a valid URL`, { cause: error });
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
  if (!secure) throw new Error(`${where}: baseUrl ${JSON.stringify(baseUrl)} must use https: (http: is only allowed for loopback hosts)`);
  if (url.username !== '' || url.password !== '') throw new Error(`${where}: baseUrl must not contain userinfo`);
  if (baseUrl.includes('?') || baseUrl.includes('#')) throw new Error(`${where}: baseUrl must not contain a query or fragment`);
};

const checkSocketPath = (socketPath: string, home: string, where: string): void => {
  if (!path.isAbsolute(socketPath)) throw new Error(`${where}: socketPath ${JSON.stringify(socketPath)} must be an absolute path`);
  if (comparableContains(canonicalPath(layoutOf(home).run), canonicalPath(socketPath))) {
    throw new Error(`${where}: socketPath ${socketPath} must not be inside ${layoutOf(home).run}`);
  }
};

const resolveChatCompletions = (target: ChatCompletionsTarget, home: string, where: string): ResolvedChatCompletionsTarget => {
  const { baseUrl, socketPath } = target;
  if ((baseUrl === undefined) === (socketPath === undefined)) {
    throw new Error(`${where}: exactly one of baseUrl and socketPath is required`);
  }
  if (baseUrl !== undefined) checkBaseUrl(baseUrl, where);
  if (socketPath !== undefined) checkSocketPath(socketPath, home, where);
  const maxConcurrency = target.maxConcurrency ?? 4;
  return {
    adapter: 'chat-completions',
    model: target.model,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(socketPath === undefined ? {} : { socketPath }),
    ...(target.apiKeyEnv === undefined ? {} : { apiKeyEnv: target.apiKeyEnv }),
    ...(target.provider === undefined ? {} : { provider: target.provider }),
    toolCalling: target.toolCalling ?? 'native',
    capabilities: {
      structuredOutput: 'none',
      streaming: true,
      stopSequences: true,
      imageInput: false,
      parallelToolCalls: false,
      schemaDialect: 'json-schema-2020-12',
      tokenCounting: 'estimated',
      usageReported: true,
      source: 'config',
      ...target.capabilities,
      maxConcurrency,
    },
    maxConcurrency,
    admissionTimeoutMs: target.admissionTimeoutMs ?? 30000,
  };
};

export const resolveModels = (models: ModelsSettings | undefined, { source, home, warnings }: ResolveModelsOptions): ResolvedModels => {
  const configured = Object.entries(models?.targets ?? {});
  const targets: Record<string, ResolvedModelTarget> = {};
  for (const [name, target] of configured) {
    const where = `${source}: models.targets.${name}`;
    targets[name] = target.adapter === 'fm' ? resolveFm(target) : resolveChatCompletions(target, home, where);
  }
  if (configured.length === 0) targets[DEFAULT_FM_NAME] = resolveFm({ adapter: 'fm' });

  const aliases: Record<string, ModelAlias> = { ...models?.aliases };
  for (const [alias, value] of Object.entries(aliases)) {
    for (const member of [value].flat()) {
      if (!Object.hasOwn(targets, member)) {
        throw new Error(`${source}: models.aliases.${alias} names target ${JSON.stringify(member)}, which is not defined in models.targets`);
      }
    }
  }
  if (!Object.hasOwn(aliases, DEFAULT_ALIAS)) {
    const first = Object.keys(targets)[0] as string;
    aliases[DEFAULT_ALIAS] = [first];
    if (configured.length > 0) {
      warnings.push(`${source}: models.aliases has no "default" alias; using the first target ${JSON.stringify(first)}`);
    }
  }
  return { aliases, targets };
};

export const credentialEnvNames = (settings: { models: { targets: Record<string, ResolvedModelTarget> } }): string[] => {
  const names = new Set<string>();
  for (const target of Object.values(settings.models.targets)) {
    if (target.adapter === 'chat-completions' && target.apiKeyEnv !== undefined) names.add(target.apiKeyEnv);
  }
  return [...names].sort();
};
