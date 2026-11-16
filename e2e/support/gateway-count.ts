import type { Capabilities, CountTokensRequest, CountTokensResult, CreateResponseBody } from '@momonga/protocol';
import { createGatewayClient } from '@momonga/runtime';
import type { GatewayClient } from '@momonga/runtime';
import { registerE2eCleanup } from './home.ts';
import { SUPERVISOR_APP_VERSION, UPSTREAM_MODEL_REF } from './stack.ts';
import { E2E_MARGIN_MS } from './wait.ts';
import { fixedSocket } from '@momonga/foundation';

export const E2E_MODEL = UPSTREAM_MODEL_REF;

export type GatewayCountClient = {
  readonly gateway: GatewayClient;
  count(body: unknown): Promise<CountTokensResult>;
  capabilities(): Promise<Capabilities>;
};

export const countRequestOf = (body: CreateResponseBody): CountTokensRequest => {
  if (body.input === undefined || body.input === null) throw new Error('a recorded create body has no input to count');
  return {
    model: body.model,
    input: body.input,
    ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
    ...(body.tools === undefined || body.tools === null ? {} : { tools: body.tools }),
    ...(body.tool_choice === undefined || body.tool_choice === null ? {} : { tool_choice: body.tool_choice }),
    ...(body.momonga?.fence === undefined ? {} : { momonga: { fence: body.momonga.fence } }),
  };
};

const wallClock = { now: (): number => Date.now() };

export const createGatewayCountClient = (gatewaySocket: string): GatewayCountClient => {
  const gateway = createGatewayClient({ resolveSocket: fixedSocket(gatewaySocket), clock: wallClock, version: SUPERVISOR_APP_VERSION });
  registerE2eCleanup(() => gateway.destroy());
  const signal = (): AbortSignal => AbortSignal.timeout(E2E_MARGIN_MS);
  return {
    gateway,
    count: (body) => gateway.countTokens(countRequestOf(body as CreateResponseBody), { signal: signal() }),
    capabilities: () => gateway.capabilities(E2E_MODEL, { signal: signal() }),
  };
};
