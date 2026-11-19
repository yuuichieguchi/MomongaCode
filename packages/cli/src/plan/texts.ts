import { PLAN_REVOCATION_CONFIRMED, PLAN_REVOCATION_NONE, PLAN_REVOCATION_UNCONFIRMED, WORDS, messageOf, signOutCommand } from '@momonga/protocol';
import type { PlanAccountRef, PlanSignInIdentity, PlanSignOutResponse, Surface } from '@momonga/protocol';
import { couldNotOpenBrowser } from '../browser-text.ts';
import { reconsentCommand, signInCommandOf } from '../policy-messages.ts';

export const SENSITIVE_URL_LINE = 'Open this URL (it is sensitive: do not share it):';

export const sensitiveUrlLines = (url: URL): string[] => [SENSITIVE_URL_LINE, url.href];

export const noBrowserHintLine = (plan: PlanAccountRef, reconsent: boolean): string =>
  `If no browser window opens, press Ctrl-C and run ${reconsent ? reconsentCommand(plan) : signInCommandOf('cli', plan)} --no-browser to get the sign-in URL.`;

export const signedInLine = (account: { label: string; email?: string }): string => `Signed in as ${account.label}${account.email === undefined ? '' : ` (${account.email})`}`;

const identityText = (identity: PlanSignInIdentity): string => identity.email ?? `the account id ${identity.subject}`;

export const IDENTITY_CANCEL_LABEL = 'Cancel';

export const IDENTITY_SAVE_LABEL = 'Save this account';

export const IDENTITY_CHOICES = [IDENTITY_CANCEL_LABEL, IDENTITY_SAVE_LABEL] as const;

export const IDENTITY_CANCEL = IDENTITY_CHOICES.indexOf(IDENTITY_CANCEL_LABEL);

export const IDENTITY_SAVE = IDENTITY_CHOICES.indexOf(IDENTITY_SAVE_LABEL);

export const identityQuestion = (surface: Surface, profile: { messages: { identityLabel: string } }, account: string, identity: PlanSignInIdentity): string =>
  messageOf('signInIdentityQuestion', surface, { provider: profile.messages.identityLabel, identity: identityText(identity), account });

export const identityNotConfirmedLine = (surface: Surface, plan: PlanAccountRef & { account: string }, identity: PlanSignInIdentity): string =>
  messageOf('signInIdentityNotConfirmed', surface, { identity: identityText(identity), account: plan.account, command: signInCommandOf(surface, plan) });

export const recordUnreadableLine = (surface: Surface, account: { profile: string; label: string; cause?: string }): string =>
  messageOf('planRecordUnreadable', surface, { account: account.label, cause: account.cause, signInCommand: signInCommandOf(surface, { profile: account.profile, account: account.label }) });

export const tryAgainLine = (surface: Surface, plan: PlanAccountRef): string => `Run ${signInCommandOf(surface, plan)} to try again.`;

export const signInFailureLine = (surface: Surface, plan: PlanAccountRef, failure: { message: string }): string => `${failure.message} ${tryAgainLine(surface, plan)}`;

export const browserNotOpenedLine = (message: string): string => `${couldNotOpenBrowser(message)} Open the URL above to continue.`;

export const cancelledText = (what: string): string => `${what} cancelled`;

export const cancelledLine = (what: string): string => `momonga: ${cancelledText(what)}`;

export const SIGN_IN_WORD = 'sign-in';

export const codeNotAcceptedLine = (surface: Surface, profile: { id: string; messages: { identityLabel: string } }, account: string): string =>
  `${profile.messages.identityLabel} did not accept the sign-in code (invalid_grant). ${tryAgainLine(surface, { profile: profile.id, account })}`;

export const planDisabledLines = (surface: Surface, profile: { id: string; messages: { planNotEnabledMessage: string } }, account: string): string[] =>
  surface !== 'tui' ? [`${profile.messages.planNotEnabledMessage} · Run ${reconsentCommand({ profile: profile.id, account })} to enable it`] : [profile.messages.planNotEnabledMessage];

export const signedOutLines = (profile: { messages: { identityLabel: string } }, label: string, report: PlanSignOutResponse): string[] => {
  switch (report.revocation) {
    case PLAN_REVOCATION_NONE:
      return [`${label} was already signed out.`];
    case PLAN_REVOCATION_CONFIRMED:
      return [`Signed out ${label}`, 'Remote revocation confirmed.'];
    case PLAN_REVOCATION_UNCONFIRMED:
      return [`Signed out ${label}`, `Remote revocation was not confirmed; disconnect the app in ${profile.messages.identityLabel} Settings: ${report.usageUrl}`];
  }
};

export const NO_ACCOUNT_SAVED_TEXT = 'no subscription account is saved';

export const NO_PROVIDER_TEXT = 'no subscription provider is available';

export const SIGN_OUT_LABEL_NEEDED_LINE = `Name the account to sign out: ${signOutCommand('<account>')}. ${WORDS.command} auth status lists the saved accounts.`;

const PROVIDER_LIST = new Intl.ListFormat('en', { type: 'conjunction' });

export const resetHostWarning = (profiles: readonly { messages: { identityLabel: string } }[]): string => {
  const providers = PROVIDER_LIST.format(profiles.map((profile) => profile.messages.identityLabel));
  return `This computer will be registered as a new host with ${providers}. Saved accounts keep their records; whether ${providers} ${profiles.length === 1 ? 'accepts' : 'accept'} them under the new host is not documented, so sign in again if one stops working.`;
};

export const listProblemLine = (problem: { file: string; cause: string }): string => `could not list ${problem.file}: ${problem.cause}`;

export const resumeLine = (label: string, resumed: boolean): string => (resumed ? `Resumed plan use for ${label}` : `${label} is not paused`);

export const accountInUseLine = (profile: { messages: { identityLabel: string } }, account: string): string => `${profile.messages.identityLabel} account in use: ${account}`;

export const accountNotSessionModelLine = (account: string, model: string): string => `${account} is signed in and selected, but this session still runs on ${model}; /model lists the models of ${account} and switches to one.`;

export const catalogUnreadHint = (profile: string, account: string): string =>
  `To use a model of ${account} by its name: momonga models add --plan ${profile} --account ${account} --model <own name> --window <tokens> --yes`;
