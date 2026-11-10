import type { ModelRole } from '@momonga/config';

const ROLE_JOBS: Readonly<Record<ModelRole, string>> = { compaction: 'summaries', reflection: 'reflection', analysis: 'analysis' };

export const sessionModelNotConfiguredText = (stored: string): string => `The model "${stored}" of this session is not configured any more. Choose another with /model.`;

export const roleModelNotConfiguredText = (role: ModelRole, stored: string): string =>
  `The model for ${ROLE_JOBS[role]} ("${stored}") is not configured any more. Choose another with /models role.`;
