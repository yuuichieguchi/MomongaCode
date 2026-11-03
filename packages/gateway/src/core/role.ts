import { RUN_ROLE } from '@momonga/observability';
import { HEADER_ROLES, ROLE_HEADER } from '@momonga/protocol';
import type { HeaderRole } from '@momonga/protocol';
import { invalidRequest } from './errors.ts';

export const COMPACTION_ROLE = 'compaction';

const isHeaderRole = (value: string): value is HeaderRole => (HEADER_ROLES as readonly string[]).includes(value);

export const roleOfHeader = (value: string | undefined): string => {
  if (value === undefined) return RUN_ROLE;
  if (!isHeaderRole(value)) {
    throw invalidRequest('invalid_role', `the ${ROLE_HEADER} header must be one of ${HEADER_ROLES.join(', ')}`, ROLE_HEADER);
  }
  return value;
};
