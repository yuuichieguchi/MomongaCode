import type { PlanProfile, PlanProfileOAuth } from '@momonga/config';
import { PLAN_PROFILE_UNKNOWN_CODE } from '@momonga/protocol';
import { invalidRequest } from '../core/errors.ts';
import { ownEntry } from './own-entry.ts';

export const planProfileNamed = (profiles: Readonly<Record<string, PlanProfile>>, id: string): PlanProfile => {
  const profile = ownEntry(profiles, id);
  if (profile === undefined) throw invalidRequest(PLAN_PROFILE_UNKNOWN_CODE, `no plan profile is named ${JSON.stringify(id)}`, 'profile');
  return profile;
};

export const requireOAuth = (profile: PlanProfile): PlanProfileOAuth => {
  if (profile.oauth === undefined) {
    const hint = profile.externalCli === undefined ? '' : `; run ${profile.externalCli.loginCommand}`;
    throw invalidRequest('external_cli_managed', `${profile.displayName} does not use browser OAuth sign-in${hint}`, 'profile');
  }
  return profile.oauth;
};
