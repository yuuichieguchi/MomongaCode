import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'vitest';
import type { ResolvedModel } from '@momonga/config';
import { momongaLayout } from '@momonga/foundation';
import type { Capabilities, ChainMemberEntry, LocalServerDetection, MomongaModelEntry, MomongaModelList, UnavailableCapabilities } from '@momonga/protocol';
import { withTempDir, testKernelLock } from '@momonga/testkit';
import type { DetectRequest, ModelsShell } from '../src/commands/models.ts';
import { userModelsAt } from './user-models.ts';

export const OLLAMA_ADDRESS = 'http://127.0.0.1:11434';
export const LMSTUDIO_ADDRESS = 'http://127.0.0.1:1234/v1';

const ollamaConnection = (models: readonly Record<string, unknown>[]) => ({ adapter: 'ollama', baseUrl: OLLAMA_ADDRESS, models });

const lmstudioConnection = (extra: Record<string, unknown> = {}) => ({
  adapter: 'chat-completions',
  provider: 'lmstudio',
  baseUrl: LMSTUDIO_ADDRESS,
  billing: 'local',
  maxConcurrency: 1,
  ...extra,
  models: [{ id: 'gemma-3-4b', capabilities: { contextWindow: 4096, maxOutputTokens: 1024 } }],
});

const GEMMA_ON_OLLAMA = { id: 'gemma-3-4b:latest', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } };
const QWEN_ON_OLLAMA = { id: 'qwen3.8:27b', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } };

export const S1 = { models: { connections: [ollamaConnection([{ id: 'devstral-small-2:latest', capabilities: { contextWindow: 131072, maxOutputTokens: 32768 } }])] } };

export const S2 = { models: { connections: [ollamaConnection([GEMMA_ON_OLLAMA]), lmstudioConnection()] } };

export const S3 = {
  models: {
    connections: [
      { adapter: 'open-responses', plan: { profile: 'chatgpt' }, models: [{ id: 'gpt-5.5' }] },
      { adapter: 'open-responses', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'gpt-5.5', capabilities: { contextWindow: 400000, maxOutputTokens: 128000 } }] },
    ],
    start: 'chatgpt/gpt-5.5',
    fallback: ['openai/gpt-5.5'],
    billingChanges: [{ from: 'plan', to: 'metered' }],
  },
};

export const LLAMA_SERVER = { command: '/opt/llama/bin/llama-server', args: ['--socket', '{socket}'], readyPath: '/health' };

export const S4 = {
  models: {
    servers: { 'llama-server': LLAMA_SERVER },
    connections: [{ adapter: 'managed', server: 'llama-server', models: [{ id: 'qwen3-coder-30b', capabilities: { contextWindow: 65536, maxOutputTokens: 16384 } }] }],
  },
};

export const threeModels = (models: Record<string, unknown> = {}, qwen: Record<string, unknown> = {}) => ({
  models: { connections: [ollamaConnection([GEMMA_ON_OLLAMA, { ...QWEN_ON_OLLAMA, ...qwen }]), lmstudioConnection()], ...models },
});

export const THREE_DISPLAYS = 'ollama/gemma-3-4b, qwen3.8:27b, lmstudio/gemma-3-4b';

export type ShellHome = { home: string; settingsFile: string };

export const homeWith = (context: TestContext, settings: unknown | undefined): ShellHome => {
  const home = withTempDir(context, { asHome: true });
  const { settingsFile } = momongaLayout(home, process.platform, process.env);
  if (settings !== undefined) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 });
  }
  return { home, settingsFile };
};

export const bytesOf = (file: string): string | undefined => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);

export const documentOf = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

const UNKNOWN_NUMBERS: UnavailableCapabilities = {
  toolCalling: { state: 'unavailable', status: 412, type: 'invalid_request', code: 'capabilities_unknown', message: 'the numbers of this model are not known', param: 'model' },
  source: 'unprobed',
};

const capabilitiesOf = (model: ResolvedModel): Capabilities | UnavailableCapabilities => {
  const declared = model.capabilities;
  if (declared?.contextWindow === undefined || declared.maxOutputTokens === undefined) return UNKNOWN_NUMBERS;
  return {
    contextWindow: declared.contextWindow,
    maxOutputTokens: declared.maxOutputTokens,
    toolCalling: 'native',
    structuredOutput: 'json_schema',
    streaming: true,
    stopSequences: true,
    imageInput: false,
    schemaDialect: 'json-schema-2020-12',
    tokenCounting: 'estimated',
    usageReported: true,
    maxConcurrency: model.maxConcurrency,
    source: 'config',
  };
};

const memberOf = (model: ResolvedModel, index: number): ChainMemberEntry => ({
  model: model.canon,
  counter: String(index + 1).repeat(64),
  billing: model.billing,
  adapter: model.adapter,
  answers: model.answers ?? 'model',
  upstream: model.ownName,
  ...('plan' in model ? { plan: model.plan } : {}),
  capabilities: capabilitiesOf(model),
});

export const listingOf = (home: string): MomongaModelList => {
  const { resolved } = userModelsAt(home);
  const modelOf = (canon: string): ResolvedModel => resolved.models.get(canon) as ResolvedModel;
  const data = [...resolved.models.values()].map(
    (model): MomongaModelEntry => ({
      id: model.canon,
      object: 'model',
      provider: model.provider,
      ownName: model.ownName,
      ...(model.defaultTag === undefined ? {} : { defaultTag: model.defaultTag }),
      billing: model.billing,
      capabilities: capabilitiesOf(model),
      state: 'available',
      chain: (resolved.chains.get(model.canon) ?? [model.canon]).map((canon, index) => memberOf(modelOf(canon), index)),
    }),
  );
  return { object: 'list', data, start: resolved.start ?? null, roles: resolved.roles };
};

export type ShellHarness = { shell: ModelsShell; stdout: string[]; stderr: string[]; detections: DetectRequest[]; listings: number[]; out(): string; err(): string };

export type ShellFakes = {
  found?: (request: DetectRequest) => readonly LocalServerDetection[];
  listing?: () => MomongaModelList;
  programModel?: string;
  interrupt?: AbortSignal;
};

export const shellOf = ({ home, settingsFile }: ShellHome, fakes: ShellFakes = {}): ShellHarness => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const detections: DetectRequest[] = [];
  const listings: number[] = [];
  const shell: ModelsShell = {
    stdout: { write: (text) => void stdout.push(text) },
    stderr: { write: (text) => void stderr.push(text) },
    home,
    lock: testKernelLock,
    settingsFile,
    platform: 'linux',
    interrupt: fakes.interrupt ?? new AbortController().signal,
    files: {
      readText: (file) => fs.promises.readFile(file, 'utf8'),
      readTextIfPresent: async (file) => (fs.existsSync(file) ? fs.promises.readFile(file, 'utf8') : undefined),
    },
    listing: async () => {
      listings.push(listings.length);
      return (fakes.listing ?? (() => listingOf(home)))();
    },
    detect: async (request) => {
      detections.push(request);
      return (fakes.found ?? (() => []))(request);
    },
    programModel: async () => {
      if (fakes.programModel === undefined) throw new Error('the program was started, but this case gives no model for it');
      return fakes.programModel;
    },
  };
  return { shell, stdout, stderr, detections, listings, out: () => stdout.join(''), err: () => stderr.join('') };
};

export const ollamaFound = (address: string, ids: readonly string[]): LocalServerDetection => ({
  kind: 'ollama',
  provider: address === OLLAMA_ADDRESS ? 'ollama' : `ollama-${new URL(address).hostname}-${new URL(address).port}`,
  address,
  models: ids.map((id) => ({ id, tools: 'unknown' as const })),
});
