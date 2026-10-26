import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { RunState } from '@momonga/protocol';

export const isLoop = (state: RunState, threshold: number): boolean => {
  const current = state.loopOpen;
  if (current === undefined) return false;
  const previous = state.loopGroups.slice(-(threshold - 1));
  if (previous.length < threshold - 1) return false;
  const signature = sha256Hex(canonicalJson(current.calls));
  const first = previous[0]?.outputSignature;
  return first !== undefined && previous.every((group) => group.signature === signature && group.outputSignature === first);
};
