import { CONTROL_REQUEST_TIMEOUT_MS, createUdsClient, fixedSocket, parseOutsideJson } from '@momonga/foundation';
import { parseInterruptedWork } from '@momonga/protocol';
import type { InterruptedWorkItem } from '@momonga/protocol';
import { HEALTH_BODY_MAX_BYTES } from './lock-watch.ts';
import type { ChildRole } from './launcher.ts';

export type GenerationCounts = { steps?: number; jobs?: number; calls?: number; interrupts?: InterruptedWorkItem[] };

export type ChildCountsReader = (role: ChildRole, socketPath: string) => Promise<GenerationCounts>;

const HEALTH_PATHS = { runtime: '/v1/health', gateway: '/v1/momonga/health' } as const satisfies Record<ChildRole, string>;

const countOf = (body: Readonly<Record<string, unknown>>, name: string): number | undefined => {
  const value = body[name];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};

const readBounded = async (body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<string | undefined> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) return undefined;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

export const countsOfHealthBody = (role: ChildRole, body: Readonly<Record<string, unknown>>): GenerationCounts => {
  if (role === 'gateway') {
    const calls = countOf(body, 'activeRequests');
    return calls === undefined ? {} : { calls };
  }
  const steps = countOf(body, 'steps');
  const jobs = countOf(body, 'jobs');
  const interrupts = parseInterruptedWork(body['interrupts']);
  return {
    ...(steps === undefined ? {} : { steps }),
    ...(jobs === undefined ? {} : { jobs }),
    ...(interrupts === undefined ? {} : { interrupts }),
  };
};

export const readChildCounts: ChildCountsReader = async (role, socketPath) => {
  const client = createUdsClient(fixedSocket(socketPath), { connectTimeoutMs: CONTROL_REQUEST_TIMEOUT_MS, headersTimeoutMs: CONTROL_REQUEST_TIMEOUT_MS, bodyTimeoutMs: CONTROL_REQUEST_TIMEOUT_MS });
  try {
    const response = await client.request({ method: 'GET', path: HEALTH_PATHS[role] });
    const text = await readBounded(response.body, HEALTH_BODY_MAX_BYTES);
    if (response.status !== 200 || text === undefined) return {};
    const parsed: unknown = parseOutsideJson(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return countsOfHealthBody(role, parsed as Readonly<Record<string, unknown>>);
  } finally {
    await client.destroy();
  }
};
