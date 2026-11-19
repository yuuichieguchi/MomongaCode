import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { TestContext } from 'vitest';
import type { UserModels } from '@momonga/config';
import { fixedSocket, momongaLayout } from '@momonga/foundation';
import { TARGET_PROBING_MESSAGE, parseCanon } from '@momonga/protocol';
import type { Capabilities, ProbingCapabilities, UnavailableCapabilities } from '@momonga/protocol';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { createGatewayClient } from '../src/client/gateway-client.ts';
import { userModelsAt } from './user-models.ts';

export const LISTED_CONTEXT_WINDOW = 400000;
export const LISTED_MAX_OUTPUT_TOKENS = 64000;

export const LISTED_PLAN: Capabilities = {
  contextWindow: LISTED_CONTEXT_WINDOW,
  maxOutputTokens: LISTED_MAX_OUTPUT_TOKENS,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: false,
  imageInput: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 4,
  source: 'config',
};

export const UNAVAILABLE_PLAN: UnavailableCapabilities = {
  toolCalling: {
    state: 'unavailable',
    status: 412,
    type: 'invalid_request',
    code: 'capabilities_unknown',
    message:
      'the model plan-model cannot be used yet: the settings give no context window and output limit for it, and the model list of its account reports none; momonga models --catalog reads the list',
    param: 'model',
  },
  source: 'unprobed',
};

export const PROBING_PLAN: ProbingCapabilities = { toolCalling: { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 5, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare toolCalling for the model in its settings' } }, source: 'unprobed' };

export const PLAN_MODEL = 'plan-model';
export const PLAN_PROVIDER = 'chatgpt';
export const PLAN_TARGET = `${PLAN_PROVIDER}/${PLAN_MODEL}`;

export const PRODUCT_WRITTEN_PLAN_CONNECTION = { adapter: 'open-responses', plan: { profile: PLAN_PROVIDER }, models: [{ id: PLAN_MODEL }] } as const;

export const productWrittenPlanModels = (context: TestContext): UserModels => {
  const home = withTempDir(context, { asHome: true });
  const file = momongaLayout(home, process.platform, process.env).settingsFile;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ models: { connections: [PRODUCT_WRITTEN_PLAN_CONNECTION] } }), { mode: 0o600 });
  return userModelsAt(home);
};

export const listingEntry = (id: string, memberCapabilities: Record<string, unknown>) => {
  const named = parseCanon(id);
  if (named === undefined) throw new Error(`${id} is not the full reference of a model`);
  return {
    id,
    object: 'model',
    provider: named.provider,
    ownName: named.ownName,
    naming: 'account',
    billing: 'plan',
    capabilities: Object.values(memberCapabilities)[0],
    state: 'available',
    chain: Object.entries(memberCapabilities).map(([model, capabilities], index) => ({
      model,
      counter: String(index + 1).repeat(64),
      billing: 'plan',
      adapter: 'open-responses',
      answers: 'model',
      upstream: parseCanon(model)?.ownName ?? model,
      capabilities,
    })),
  };
};

export type FakeModelsGateway = { socketPath: string; requests: { method: string; url: string }[]; firstRequest: Promise<'requested'> };

export const serveModelsListing = async (context: TestContext, answer: readonly unknown[] | 'never'): Promise<FakeModelsGateway> => {
  const socketPath = path.join(withTempDir(context), 'g.sock');
  const requests: { method: string; url: string }[] = [];
  let arrived: (value: 'requested') => void = () => undefined;
  const firstRequest = new Promise<'requested'>((resolve) => {
    arrived = resolve;
  });
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method ?? '', url: request.url ?? '' });
    arrived('requested');
    if (answer === 'never') return;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: answer, start: null, roles: {} }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  registerCleanup(context, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { socketPath, requests, firstRequest };
};

export const MODELS_LISTING_REQUEST = { method: 'GET', url: '/v1/momonga/models' };

export const absentGatewaySocket = (context: TestContext): string => path.join(withTempDir(context), 'absent.sock');

export const modelsFailureOn = async (socketPath: string): Promise<Error> => {
  const client = createGatewayClient({ resolveSocket: fixedSocket(socketPath) });
  try {
    await client.models();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  } finally {
    await client.close();
  }
  throw new Error(`a gateway answered on ${socketPath}`);
};
