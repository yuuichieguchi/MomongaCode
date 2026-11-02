import { LOCAL_REQUEST_HEADERS_TIMEOUT_MS, createUdsClient } from '@momonga/foundation';
import type { SupervisorChildHealth } from '@momonga/protocol';
import type { IdleShutdownOutcome } from './control-server.ts';

const DRAIN_ENDPOINT = '/v1/drain-if-idle';

export type IdleShutdownInput = {
  runtime: Pick<SupervisorChildHealth, 'state'>;
  runtimeSocketPath: string;
  requestTimeoutMs?: number;
};

export const shutdownIfIdle = async ({
  runtime,
  runtimeSocketPath,
  requestTimeoutMs = LOCAL_REQUEST_HEADERS_TIMEOUT_MS,
}: IdleShutdownInput): Promise<IdleShutdownOutcome> => {
  if (runtime.state !== 'ready') return { kind: 'busy', reason: `the runtime is ${runtime.state}, so the supervisor cannot show it is idle` };
  const client = createUdsClient(runtimeSocketPath, { headersTimeoutMs: requestTimeoutMs, bodyTimeoutMs: requestTimeoutMs });
  try {
    const response = await client.request({ method: 'POST', path: DRAIN_ENDPOINT });
    const text = await response.text();
    if (response.status === 202) return { kind: 'accepted' };
    if (response.status === 409) return { kind: 'busy', reason: `the runtime has an active run: ${text}` };
    throw new Error(`POST ${DRAIN_ENDPOINT} answered ${response.status}: ${text}`);
  } finally {
    await client.close();
  }
};
