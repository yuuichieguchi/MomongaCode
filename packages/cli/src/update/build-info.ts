import type { BuildUpdateInputs } from './source.ts';

declare const __MOMONGA_RELEASE_REPO__: string | undefined;
declare const __MOMONGA_TEAM_ID__: string | undefined;

export const buildUpdateInputs = (): BuildUpdateInputs => ({
  repo: typeof __MOMONGA_RELEASE_REPO__ === 'undefined' ? undefined : __MOMONGA_RELEASE_REPO__,
  teamId: typeof __MOMONGA_TEAM_ID__ === 'undefined' ? undefined : __MOMONGA_TEAM_ID__,
});
