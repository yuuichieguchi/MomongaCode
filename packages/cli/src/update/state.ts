import { isRecord } from '@momonga/foundation';

export const BACKGROUND_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type BackgroundOutcome =
  | { kind: 'up_to_date' }
  | { kind: 'installed'; version: string }
  | { kind: 'installed_not_restarted'; version: string; code: string; message: string; remediation: string }
  | { kind: 'failed'; code: string; message: string };

export type UpdateState = { checkedAt: number; outcome: BackgroundOutcome; announced: boolean };

const parseOutcome = (value: unknown): BackgroundOutcome | undefined => {
  if (!isRecord(value)) return undefined;
  if (value['kind'] === 'up_to_date') return { kind: 'up_to_date' };
  if (value['kind'] === 'installed' && typeof value['version'] === 'string') return { kind: 'installed', version: value['version'] };
  if (
    value['kind'] === 'installed_not_restarted' &&
    typeof value['version'] === 'string' &&
    typeof value['code'] === 'string' &&
    typeof value['message'] === 'string' &&
    typeof value['remediation'] === 'string'
  ) {
    return { kind: 'installed_not_restarted', version: value['version'], code: value['code'], message: value['message'], remediation: value['remediation'] };
  }
  if (value['kind'] === 'failed' && typeof value['code'] === 'string' && typeof value['message'] === 'string') {
    return { kind: 'failed', code: value['code'], message: value['message'] };
  }
  return undefined;
};

export const parseUpdateState = (value: unknown): UpdateState => {
  if (isRecord(value) && typeof value['checkedAt'] === 'number' && typeof value['announced'] === 'boolean') {
    const outcome = parseOutcome(value['outcome']);
    if (outcome !== undefined) return { checkedAt: value['checkedAt'], outcome, announced: value['announced'] };
  }
  throw new Error('the update state file is not valid; remove it to reset the background update check');
};
