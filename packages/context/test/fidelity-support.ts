import { tokenMatcherOf } from '@momonga/protocol';
import type { ClaimedToken } from '@momonga/protocol';
import type { FidelityRecord } from '@momonga/context';

export const attestedIn = (claims: readonly ClaimedToken[], record: FidelityRecord, cwd: string): string[] =>
  claims
    .filter(({ token, claim }) => {
      const texts = claim === 'executed' ? [...record.executedLeaves, ...record.executedText] : [...record.executedLeaves, ...record.executedText, ...record.statedText];
      const matcher = tokenMatcherOf(token, cwd);
      return texts.some((text) => matcher.matches(text, true));
    })
    .map(({ token }) => token);
