import type { PlanSignOutResponse } from '@momonga/protocol';
import { reconsentCommand, signInCommandOf } from '../policy-messages.ts';
import type { MessageSurface } from '../policy-messages.ts';

export const SENSITIVE_URL_LINE = 'Open this URL (it is sensitive: do not share it):';

export const sensitiveUrlLines = (url: URL): string[] => [SENSITIVE_URL_LINE, url.href];

export const noBrowserHintLine = (providerId: string, accountLabel: string): string =>
  `If no browser window opens, press Ctrl-C and run ${signInCommandOf('headless', { profile: providerId, account: accountLabel })} --no-browser to get the sign-in URL.`;

export const signedInLine = (account: { label: string; email?: string }): string => `Signed in as ${account.label}${account.email === undefined ? '' : ` (${account.email})`}`;

export const tryAgainLine = (surface: MessageSurface, plan: { profile: string; account: string }): string => `Run ${signInCommandOf(surface, plan)} to try again.`;

export const codeNotAcceptedLine = (surface: MessageSurface, profile: { id: string; messages: { identityLabel: string } }, account: string): string =>
  `${profile.messages.identityLabel} did not accept the sign-in code (invalid_grant). ${tryAgainLine(surface, { profile: profile.id, account })}`;

export const planDisabledLines = (surface: MessageSurface, profile: { id: string; messages: { planNotEnabledMessage: string } }, account: string): string[] =>
  surface === 'headless' ? [`${profile.messages.planNotEnabledMessage} · Run ${reconsentCommand(profile.id, account)} to enable it`] : [profile.messages.planNotEnabledMessage];

export const signedOutLines = (profile: { messages: { identityLabel: string } }, label: string, report: PlanSignOutResponse): string[] => {
  switch (report.revocation) {
    case 'none':
      return [`${label} was already signed out.`];
    case 'confirmed':
      return [`Signed out ${label}`, 'Remote revocation confirmed.'];
    case 'unconfirmed':
      return [`Signed out ${label}`, `Remote revocation was not confirmed; disconnect the app in ${profile.messages.identityLabel} Settings: ${report.usageUrl}`];
  }
};

export const listProblemLine = (problem: { file: string; cause: string }): string => `could not list ${problem.file}: ${problem.cause}`;

export const resumeLine = (label: string, resumed: boolean): string => (resumed ? `Resumed plan use for ${label}` : `${label} is not paused`);
