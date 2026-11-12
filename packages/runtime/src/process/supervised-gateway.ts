import { SUPERVISOR_RESPONSE_BOUND_MS, createUdsClient, isRecord } from '@momonga/foundation';
import type { SocketResolver } from '@momonga/foundation';
import type { SupervisorChildState } from '@momonga/protocol';

export type GatewayStanding = { kind: 'restarting' | 'given-up'; state: SupervisorChildState };

const PROMISED: Readonly<Record<SupervisorChildState, boolean>> = {
  pending: true,
  starting: true,
  ready: true,
  stopping: true,
  backoff: true,
  'waiting-lock': true,
  'held-config': false,
  'held-version': false,
  external: false,
  stopped: false,
};

const isChildState = (value: unknown): value is SupervisorChildState => typeof value === 'string' && Object.hasOwn(PROMISED, value);

const gatewayStateOf = (health: unknown): { state: SupervisorChildState; draining: boolean } => {
  if (!isRecord(health) || !Array.isArray(health['children'])) throw new Error('the health of the supervisor is not a health answer');
  const gateway: unknown = health['children'].find((child: unknown) => isRecord(child) && child['role'] === 'gateway');
  if (!isRecord(gateway)) throw new Error('the health of the supervisor names no process that serves the models');
  const { state } = gateway;
  if (!isChildState(state)) throw new Error(`the health of the supervisor gives the process that serves the models the unknown state ${JSON.stringify(state)}`);
  return { state, draining: health['phase'] === 'draining' };
};

export const supervisedGatewayStanding =
  (resolveSocket: SocketResolver) =>
  async (signal: AbortSignal): Promise<GatewayStanding> => {
    const client = createUdsClient(resolveSocket, { connectTimeoutMs: SUPERVISOR_RESPONSE_BOUND_MS, headersTimeoutMs: SUPERVISOR_RESPONSE_BOUND_MS, bodyTimeoutMs: SUPERVISOR_RESPONSE_BOUND_MS });
    try {
      const response = await client.request({ method: 'GET', path: '/v1/health', signal });
      if (response.status !== 200) throw new Error(`the supervisor answered its health with status ${response.status}`);
      const { state, draining } = gatewayStateOf(await response.json());
      return { kind: !draining && PROMISED[state] ? 'restarting' : 'given-up', state };
    } finally {
      await client.close();
    }
  };
