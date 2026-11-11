import { PLAN_REVOCATION_CONFIRMED, PLAN_REVOCATION_NONE, PLAN_REVOCATION_UNCONFIRMED, messageOf } from '@momonga/protocol';
import type { PlanAccountRef, PlanSignInIdentity, PlanSignOutResponse, Surface } from '@momonga/protocol';
import { couldNotOpenBrowser } from '../browser-text.ts';
import { reconsentCommand, signInCommandOf } from '../policy-messages.ts';

export const SENSITIVE_URL_LINE = 'Open this URL (it is sensitive: do not share it):';

export const sensitiveUrlLines = (url: URL): string[] => [SENSITIVE_URL_LINE, url.href];

export const noBrowserHintLine = (providerId: string, accountLabel: string): string =>
  `If no browser window opens, press Ctrl-C and run ${signInCommandOf('cli', { profile: providerId, account: accountLabel })} --no-browser to get the sign-in URL.`;

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

export const listProblemLine = (problem: { file: string; cause: string }): string => `could not list ${problem.file}: ${problem.cause}`;

export const resumeLine = (label: string, resumed: boolean): string => (resumed ? `Resumed plan use for ${label}` : `${label} is not paused`);
