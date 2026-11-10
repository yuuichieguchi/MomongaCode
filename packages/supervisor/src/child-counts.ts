import { CONTROL_REQUEST_TIMEOUT_MS, createUdsClient, fixedSocket, parseOutsideJson } from '@momonga/foundation';
import { HEALTH_BODY_MAX_BYTES } from './lock-watch.ts';
import type { ChildRole } from './launcher.ts';

export type GenerationCounts = { steps?: number; jobs?: number; calls?: number };

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

const withoutUndefined = (counts: { steps: number | undefined; jobs: number | undefined; calls: number | undefined }): GenerationCounts => ({
  ...(counts.steps === undefined ? {} : { steps: counts.steps }),
  ...(counts.jobs === undefined ? {} : { jobs: counts.jobs }),
  ...(counts.calls === undefined ? {} : { calls: counts.calls }),
});

export const readChildCounts: ChildCountsReader = async (role, socketPath) => {
  const client = createUdsClient(fixedSocket(socketPath), { headersTimeoutMs: CONTROL_REQUEST_TIMEOUT_MS, bodyTimeoutMs: CONTROL_REQUEST_TIMEOUT_MS });
  try {
    const response = await client.request({ method: 'GET', path: HEALTH_PATHS[role] });
    const text = await readBounded(response.body, HEALTH_BODY_MAX_BYTES);
    if (response.status !== 200 || text === undefined) return {};
    const parsed: unknown = parseOutsideJson(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const body = parsed as Readonly<Record<string, unknown>>;
    return role === 'runtime'
      ? withoutUndefined({ steps: countOf(body, 'steps'), jobs: countOf(body, 'jobs'), calls: undefined })
      : withoutUndefined({ steps: undefined, jobs: undefined, calls: countOf(body, 'activeRequests') });
  } finally {
    await client.destroy();
  }
};
