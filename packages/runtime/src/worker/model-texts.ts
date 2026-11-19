import type { ModelRole } from '@momonga/config';
import { modelSettingsPath } from '@momonga/protocol';

const ROLE_JOBS: Readonly<Record<ModelRole, string>> = { compaction: 'summaries', reflection: 'reflection', analysis: 'analysis' };

export { sessionModelNotConfiguredText } from '@momonga/protocol';

export const roleModelNotConfiguredText = (role: ModelRole, stored: string): string =>
  `The model for ${ROLE_JOBS[role]} ("${stored}") is not configured any more. Choose another with ${modelSettingsPath('Models for other roles')}.`;
