import type { Capabilities, CountTokensRequest, CountTokensResult } from '@momonga/protocol';
import { createGatewayClient } from '@momonga/runtime';
import type { GatewayClient } from '@momonga/runtime';
import { registerE2eCleanup } from './home.ts';
import { SUPERVISOR_APP_VERSION } from './stack.ts';
import { E2E_MARGIN_MS } from './wait.ts';

export const E2E_MODEL_ALIAS = 'default';

export type GatewayCountClient = {
  readonly gateway: GatewayClient;
  count(body: unknown): Promise<CountTokensResult>;
  capabilities(): Promise<Capabilities>;
};

const wallClock = { now: (): number => Date.now() };

export const createGatewayCountClient = (gatewaySocket: string): GatewayCountClient => {
  const gateway = createGatewayClient({ socketPath: gatewaySocket, clock: wallClock, version: SUPERVISOR_APP_VERSION });
  registerE2eCleanup(() => gateway.destroy());
  const signal = (): AbortSignal => AbortSignal.timeout(E2E_MARGIN_MS);
  return {
    gateway,
    count: (body) => gateway.countTokens(body as CountTokensRequest, { signal: signal() }),
    capabilities: () => gateway.capabilities(E2E_MODEL_ALIAS, { signal: signal() }),
  };
};
