import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { RunState } from '@momonga/protocol';

export const loopSignatureOf = (state: RunState, threshold: number): string | undefined => {
  const current = state.loopOpen;
  if (current === undefined) return undefined;
  const previous = state.loopGroups.slice(-(threshold - 1));
  if (previous.length < threshold - 1) return undefined;
  const signature = sha256Hex(canonicalJson(current.calls));
  const first = previous[0]?.outputSignature;
  const repeats = first !== undefined && previous.every((group) => group.signature === signature && group.outputSignature === first);
  return repeats ? signature : undefined;
};

