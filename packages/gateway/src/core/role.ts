import { RUN_ROLE } from '@momonga/observability';
import { invalidRequest } from './errors.ts';

export const COMPACTION_ROLE = 'compaction';

const ROLE_OF_PURPOSE: Readonly<Record<string, string>> = {
  reflection: 'reflection',
  guideline: 'analysis',
  permission_classifier: 'classifier',
};

export const roleOfMetadata = (metadata: Record<string, string> | null | undefined): string => {
  const purpose = metadata?.['purpose'];
  if (purpose === undefined) return RUN_ROLE;
  const role = ROLE_OF_PURPOSE[purpose];
  if (role === undefined) throw invalidRequest('invalid_metadata', `metadata.purpose ${JSON.stringify(purpose)} names no known role`, 'metadata.purpose');
  return role;
};
