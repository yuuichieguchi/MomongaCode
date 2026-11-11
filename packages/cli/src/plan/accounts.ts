import { PLAN_DISABLED_STATE, PLAN_STORE_UNREADABLE_STATE, PLAN_STORE_UNWRITABLE_STATE } from '@momonga/protocol';
import type { PlanAccountState, PlanAccountView, PlanProfileView } from '@momonga/protocol';

const STATE_WORDS: Readonly<Record<PlanAccountState, string>> = {
  active: 'active',
  needs_sign_in: 'sign-in required',
  [PLAN_DISABLED_STATE]: 'plan use not enabled',
  registered: 'signed out',
  signing_out: 'signing out',
  [PLAN_STORE_UNREADABLE_STATE]: 'record unreadable',
  [PLAN_STORE_UNWRITABLE_STATE]: 'record not writable',
};

const PAUSED_WORD = 'paused by limit';

export type SavedAccountAction = 'activate' | 'sign-in' | 'replace' | 'none';

const SAVED_ACCOUNT_ACTIONS: Readonly<Record<PlanAccountState, SavedAccountAction>> = {
  active: 'activate',
  needs_sign_in: 'sign-in',
  registered: 'sign-in',
  [PLAN_DISABLED_STATE]: 'sign-in',
  [PLAN_STORE_UNREADABLE_STATE]: 'replace',
  [PLAN_STORE_UNWRITABLE_STATE]: 'none',
  signing_out: 'none',
};

export const accountStateWord = (account: PlanAccountView): string => (account.state === 'active' && account.paused !== undefined ? PAUSED_WORD : STATE_WORDS[account.state]);

export const savedAccountAction = (account: PlanAccountView): SavedAccountAction => SAVED_ACCOUNT_ACTIONS[account.state];

export const accountRowLabel = (account: PlanAccountView): string => [account.label, account.email, accountStateWord(account)].filter((part) => part !== undefined).join(' · ');

export const accountsOf = (profile: string, records: readonly PlanAccountView[]): readonly PlanAccountView[] => records.filter((record) => record.profile === profile);

export const nextAccountLabel = (profile: string, records: readonly PlanAccountView[]): string => {
  const taken = new Set(accountsOf(profile, records).map((record) => record.label));
  if (!taken.has(profile)) return profile;
  let ordinal = 2;
  while (taken.has(`${profile}-${ordinal}`)) ordinal += 1;
  return `${profile}-${ordinal}`;
};

export const profileStateText = (profile: PlanProfileView, records: readonly PlanAccountView[]): string => {
  const active = accountsOf(profile.id, records).find((record) => record.active);
  if (active === undefined) return 'not signed in';
  return active.state === 'active' && active.paused === undefined ? `signed in as ${active.label}` : accountStateWord(active);
};

export const profileOf = (profiles: readonly PlanProfileView[], id: string): PlanProfileView => {
  const found = profiles.find((profile) => profile.id === id);
  if (found === undefined) throw new Error(`unknown subscription provider ${JSON.stringify(id)}; the providers are ${profiles.map((profile) => profile.id).join(', ')}`);
  return found;
};

export const SANDBOX_OFF_NOTICE: readonly string[] = [
  'The sandbox is off on this host, so a shell command run by the agent could read the saved sign-in.',
  'What still protects it: each command needs your approval unless a rule allows it, and the deny rules refuse commands whose text reads the MomongaCode state directory.',
  'What does not: a disguised command that the auto mode classifier approves.',
];
