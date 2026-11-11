import { canonicalJson, sha256Hex } from '@momonga/foundation';

export const APPROVAL_DIGEST_PATTERN = '^[0-9a-f]{64}$';

export const approvalDigestOf = (item: unknown): string => sha256Hex(canonicalJson(item));

export const hookGroupApprovalDigestOf = (event: string, group: unknown): string => approvalDigestOf({ event, group });
