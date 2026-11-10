import { canonicalJson, sha256Hex } from '@momonga/foundation';

export type CallIdentity = { kind: 'keyed'; key: string; digest: string } | { kind: 'unkeyed'; nonce: string };

export const upstreamCallKey = (call: CallIdentity, target: string): string =>
  sha256Hex(canonicalJson(call.kind === 'keyed' ? ['keyed', call.key, call.digest, target] : ['unkeyed', call.nonce, target]));
