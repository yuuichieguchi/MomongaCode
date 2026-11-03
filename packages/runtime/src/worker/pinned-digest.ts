import { canonicalJson, isRecord, sha256Hex } from '@momonga/foundation';

export const pinnedDigestOf = (body: unknown): string => {
  if (!isRecord(body) || !Array.isArray(body['input'])) throw new Error('a model request body has no input list');
  const layers = body['input'].filter((item: unknown) => isRecord(item) && (item['role'] === 'system' || item['role'] === 'developer'));
  return sha256Hex(canonicalJson({ input: layers, tools: body['tools'] ?? null }));
};
