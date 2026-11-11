import type { StartFailureReason } from '@momonga/foundation';
import { WORDS } from '@momonga/protocol';

export const daemonNotStartedText = (to: string, condition: string, from: string | undefined): string =>
  `The new ${WORDS.daemon} (v${to}) did not start (${condition})${from === undefined ? '.' : `; v${from} keeps running.`}`;

const DETAILED_REASONS = ['exited-before-ready', 'launch-failed', 'older-started-first'] as const satisfies readonly StartFailureReason[];

export type DetailedStartFailureReason = (typeof DETAILED_REASONS)[number];

export type StartFailure = { reason: Exclude<StartFailureReason, DetailedStartFailureReason> } | { reason: DetailedStartFailureReason; detail: string };

export const needsDetail = (reason: StartFailureReason): reason is DetailedStartFailureReason => DETAILED_REASONS.some((detailed) => detailed === reason);

const RUN_AGAIN = 'Run the command again.';

const reasonIsIn = (logFile: string): string => `The reason is in ${logFile}.`;

type PublicText = { readonly condition: (detail: string) => string; readonly wayForward: (logFile: string) => string };

const PUBLIC_TEXTS: Readonly<Record<StartFailureReason, PublicText>> = {
  'directory-missing': { condition: () => 'its files were removed while it was starting', wayForward: () => RUN_AGAIN },
  'record-missing': { condition: () => 'the file that names its version is missing', wayForward: () => RUN_AGAIN },
  'record-unreadable': { condition: () => 'the file that names its version cannot be read', wayForward: () => RUN_AGAIN },
  'version-differs': { condition: () => `the installed ${WORDS.command} is another version than this one`, wayForward: () => RUN_AGAIN },
  'lock-held': { condition: () => 'another process holds its lock', wayForward: () => `Run \`${WORDS.command} ${WORDS.daemon} stop\`, then run the command again.` },
  'stopped-before-ready': { condition: () => 'it stopped before it was ready', wayForward: reasonIsIn },
  'exited-before-ready': { condition: (detail) => `it stopped with ${detail} before it was ready`, wayForward: reasonIsIn },
  'launch-failed': { condition: (detail) => `its program could not be run: ${detail}`, wayForward: () => `Check that ${WORDS.command} is still installed, then run the command again.` },
  'older-started-first': { condition: (detail) => `a ${WORDS.daemon} of v${detail} started at the same time`, wayForward: () => RUN_AGAIN },
};

export type StartFailureGiven = { version: string; failure: StartFailure; serving: string | undefined; logFile: string };

export const startFailureText = ({ version, failure, serving, logFile }: StartFailureGiven): string => {
  const text = PUBLIC_TEXTS[failure.reason];
  return `${daemonNotStartedText(version, text.condition('detail' in failure ? failure.detail : ''), serving)} ${text.wayForward(logFile)}`;
};
