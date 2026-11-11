import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import type { ResolvedModel, UserModels } from '@momonga/config';
import { momongaLayout } from '@momonga/foundation';
import { TARGET_PROBING_MESSAGE, notListedMessage } from '@momonga/protocol';
import { withTempDir } from '@momonga/testkit';
import { ContextHostError, liveSettingsFor } from '../src/eval/context-host.ts';
import type { PlanRelay } from '../src/eval/context-host.ts';
import { LISTED_CONTEXT_WINDOW, LISTED_MAX_OUTPUT_TOKENS, LISTED_PLAN, PLAN_MODEL, PLAN_TARGET, PROBING_PLAN, UNAVAILABLE_PLAN, productWrittenPlanModels } from './fake-models-listing.ts';

const GATE_SOCKET = '/tmp/gate-home/.momonga/run/gateway.sock';

const OLD_SENTENCE = 'has no known context window or output limit';

const CLI_SOURCES = path.resolve(import.meta.dirname, '../src');

const relayed = (models: UserModels, listed: PlanRelay['listed']) => liveSettingsFor(models, [PLAN_TARGET], { planRelaySocket: GATE_SOCKET, listed });

const writtenOf = (settings: ReturnType<typeof relayed>): { connection: Record<string, unknown> | undefined; entry: Record<string, unknown> | undefined } => {
  const connection: Record<string, unknown> | undefined = settings.models.connections?.[0];
  const entry: Record<string, unknown> | undefined = settings.models.connections?.[0]?.models?.[0];
  return { connection, entry };
};

const refusalOf = (context: TestContext, listed: PlanRelay['listed']): unknown => {
  try {
    relayed(productWrittenPlanModels(context), listed);
  } catch (error) {
    return error;
  }
  throw new Error('the relay target was built');
};

const sourceFilesIn = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesIn(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });

describe('the eval relay of a plan target written by the product (P6.10, K4)', () => {
  it('the settings of a product-written plan target carry no context window and no output limit', (context) => {
    const resolved = productWrittenPlanModels(context).resolved.models.get(PLAN_TARGET);
    expect(resolved?.capabilities).not.toHaveProperty('contextWindow');
    expect(resolved?.capabilities).not.toHaveProperty('maxOutputTokens');
  });

  it('rewrites a plan target into an open-responses target through the gate home gateway socket, with the context window and output limit of the listing, billing plan, and no plan', (context) => {
    const settings = relayed(productWrittenPlanModels(context), { [PLAN_TARGET]: LISTED_PLAN });
    const { connection, entry } = writtenOf(settings);
    expect(connection).toBeDefined();
    expect(connection).not.toHaveProperty('plan');
    expect(connection).not.toHaveProperty('apiKeyEnv');
    expect(connection).not.toHaveProperty('apiKeySecret');
    expect(connection).not.toHaveProperty('baseUrl');
    expect(connection).toMatchObject({ adapter: 'open-responses', provider: 'chatgpt', socketPath: GATE_SOCKET, billing: 'plan' });
    expect(entry).toMatchObject({ id: PLAN_MODEL, toolCalling: 'native', maxConcurrency: 4, admissionTimeoutMs: 30000 });
    expect(entry?.['capabilities']).toMatchObject({ contextWindow: LISTED_CONTEXT_WINDOW, maxOutputTokens: LISTED_MAX_OUTPUT_TOKENS });
    expect(entry?.['capabilities']).not.toHaveProperty('maxConcurrency');
    expect(settings.models.start).toBe(PLAN_TARGET);
    expect(settings.credentials).toEqual([]);
  });

  it('a capability field that the settings and the listing both have is the one of the listing', (context) => {
    const models = productWrittenPlanModels(context);
    expect(models.resolved.models.get(PLAN_TARGET)?.capabilities).toMatchObject({ structuredOutput: 'none' });
    const settings = relayed(models, { [PLAN_TARGET]: LISTED_PLAN });
    expect(writtenOf(settings).entry?.['capabilities']).toMatchObject({ structuredOutput: 'json_schema' });
  });

  describe('the image pair comes from one side', () => {
    const IMAGE_TOKENS = { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 };

    const withResolvedImage = (models: UserModels, pair: Record<string, unknown>): UserModels => {
      const resolved = models.resolved.models.get(PLAN_TARGET);
      if (resolved === undefined) throw new Error('the plan model was not resolved');
      return { ...models, resolved: { ...models.resolved, models: new Map<string, ResolvedModel>([...models.resolved.models, [PLAN_TARGET, { ...resolved, capabilities: { ...resolved.capabilities, ...pair } } as ResolvedModel]]) } };
    };

    const relayedCapabilities = (models: UserModels, listed: PlanRelay['listed']) => {
      const settings = relayed(models, listed);
      const capabilities = writtenOf(settings).entry?.['capabilities'];
      if (typeof capabilities !== 'object' || capabilities === null) throw new Error('the relayed model was written without capabilities');
      return { settings, capabilities: { ...capabilities } as Record<string, unknown> };
    };

    it('the pair of the listing entry when the entry states imageInput, and the relayed settings pass the real loader', async (context) => {
      const models = withResolvedImage(productWrittenPlanModels(context), { imageInput: false });
      const { settings, capabilities } = relayedCapabilities(models, { [PLAN_TARGET]: { ...LISTED_PLAN, imageInput: true, imageTokens: IMAGE_TOKENS } });
      expect({ imageInput: capabilities['imageInput'], imageTokens: capabilities['imageTokens'] }).toEqual({ imageInput: true, imageTokens: IMAGE_TOKENS });
      const home = withTempDir(context, { asHome: true });
      const file = momongaLayout(home).settingsFile;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ models: settings.models }), { mode: 0o600 });
      const loaded = (await loadUserSettings({ home, signal: new AbortController().signal })).settings.models.models.get(PLAN_TARGET);
      if (loaded === undefined || !('capabilities' in loaded) || loaded.capabilities === undefined) throw new Error('the relayed model was not loaded with capabilities');
      const loadedCapabilities: Record<string, unknown> = { ...loaded.capabilities };
      expect({ imageInput: loadedCapabilities['imageInput'], imageTokens: loadedCapabilities['imageTokens'] }).toEqual({ imageInput: true, imageTokens: IMAGE_TOKENS });
    });

    it('the pair of the resolved target when the entry states no imageInput', (context) => {
      const models = withResolvedImage(productWrittenPlanModels(context), { imageInput: true, imageTokens: IMAGE_TOKENS });
      const { imageInput: _imageInput, imageTokens: _imageTokens, ...silent } = LISTED_PLAN;
      const { capabilities } = relayedCapabilities(models, { [PLAN_TARGET]: silent as PlanRelay['listed'][string] });
      expect({ imageInput: capabilities['imageInput'], imageTokens: capabilities['imageTokens'] }).toEqual({ imageInput: true, imageTokens: IMAGE_TOKENS });
    });
  });

  it('the relayed settings pass the real settings schema', async (context) => {
    const settings = relayed(productWrittenPlanModels(context), { [PLAN_TARGET]: LISTED_PLAN });
    const home = withTempDir(context, { asHome: true });
    const file = momongaLayout(home).settingsFile;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ models: settings.models }), { mode: 0o600 });
    const loaded = await loadUserSettings({ home, signal: new AbortController().signal });
    const target = loaded.settings.models.models.get(PLAN_TARGET);
    if (target === undefined || !('capabilities' in target) || target.capabilities === undefined) throw new Error('the relayed model was not loaded with capabilities');
    expect({ contextWindow: target.capabilities.contextWindow, maxOutputTokens: target.capabilities.maxOutputTokens }).toEqual({
      contextWindow: LISTED_CONTEXT_WINDOW,
      maxOutputTokens: LISTED_MAX_OUTPUT_TOKENS,
    });
  });

  it('a target the listing gives as unavailable is refused with the message of the listing', (context) => {
    const refusal = refusalOf(context, { [PLAN_TARGET]: UNAVAILABLE_PLAN });
    expect(refusal).toBeInstanceOf(ContextHostError);
    expect((refusal as Error).message).toBe(notListedMessage(UNAVAILABLE_PLAN));
  });

  it('a target the listing gives as being measured is refused with the probing message', (context) => {
    const refusal = refusalOf(context, { [PLAN_TARGET]: PROBING_PLAN });
    expect(refusal).toBeInstanceOf(ContextHostError);
    expect((refusal as Error).message).toBe(TARGET_PROBING_MESSAGE);
  });

  it('a target the listing does not hold is refused by name', (context) => {
    const refusal = refusalOf(context, {});
    expect(refusal).toBeInstanceOf(ContextHostError);
    expect((refusal as Error).message).toBe(`the model ${PLAN_MODEL} is not in the model list of the running gateway`);
  });

  it('no source of the CLI holds the sentence about an unknown context window or output limit', () => {
    const holders = sourceFilesIn(CLI_SOURCES).filter((file) => fs.readFileSync(file, 'utf8').includes(OLD_SENTENCE));
    expect(holders.map((file) => path.relative(CLI_SOURCES, file))).toEqual([]);
  });
});
