import { promisify } from 'node:util';
import { zstdCompress } from 'node:zlib';
import type { AdapterContext } from '@momonga/protocol';

export type PlanRequestWire = { encoding: 'identity' | 'zstd'; sessionHeaders: readonly string[] };

const compressZstd = promisify(zstdCompress);

export type EncodedBody = { body: string | Uint8Array; headers: Record<string, string> };

export const encodedRequestBody = async (json: string, wire: PlanRequestWire | undefined): Promise<EncodedBody> => {
  if (wire?.encoding !== 'zstd') return { body: json, headers: {} };
  return { body: await compressZstd(Buffer.from(json, 'utf8')), headers: { 'content-encoding': 'zstd' } };
};

export const sessionHeadersOf = (ctx: Pick<AdapterContext, 'sessionId'>, wire: PlanRequestWire | undefined): Record<string, string> => {
  const { sessionId } = ctx;
  if (wire === undefined || sessionId === undefined) return {};
  return Object.fromEntries(wire.sessionHeaders.map((name) => [name, sessionId]));
};
