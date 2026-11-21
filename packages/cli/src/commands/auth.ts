import { PLAN_LABEL_REFUSAL, displayMapOf, messageOf, isPlanLabel, PLAN_DISABLED_STATE, RETRY_OUTCOME, SIGNED_IN_OUTCOME, IDENTITY_UNCONFIRMED_OUTCOME } from '@momonga/protocol';
import type { MomongaModelList, PlanAccountView, PlanAccountsResponse, PlanProfileView, PlanSignInCompleteResponse, PlanSignInIdentity, TargetBilling } from '@momonga/protocol';
import { EXIT_FAILURE, EXIT_INTERRUPTED, EXIT_OK, EXIT_USAGE } from '@momonga/foundation';
import type { OpenUrl } from '@momonga/foundation';
import { listingViewsOf } from '../client/gateway-client.ts';
import { describeFailure } from '../failure.ts';
import type { PlanGatewayClient } from '../client/gateway-client.ts';
import { listedModelOf } from './models.ts';
import { createInterface } from 'node:readline';
import { SANDBOX_OFF_NOTICE, accountStateWord, accountsOf, nextAccountLabel, profileOf, savedAccountAction } from '../plan/accounts.ts';
import {
  PASTE_LABEL,
  SignInListenerError,
  SignInListenerFailedError,
  SignInNotFinishedError,
  pastedCallbackProblem,
  signIn,
} from '../plan/sign-in.ts';
import type { SandboxKind, SignInWaitTimers, StartSignInListener } from '../plan/sign-in.ts';
import { IDENTITY_CHOICES, IDENTITY_SAVE, SIGN_IN_WORD, browserNotOpenedLine, cancelledLine, codeNotAcceptedLine, identityNotConfirmedLine, identityQuestion, NO_ACCOUNT_SAVED_TEXT, NO_PROVIDER_TEXT, SIGN_OUT_LABEL_NEEDED_LINE, listProblemLine, noBrowserHintLine, planDisabledLines, recordUnreadableLine, resumeLine, sensitiveUrlLines, resetHostWarning, signInFailureLine, signedInLine, signedOutLines } from '../plan/texts.ts';
import { escapedLines } from '../terminal-writer.ts';
import { UsageError } from '../usage-error.ts';

export { nextAccountLabel };

type Writer = { write(text: string): void };


const print = (writer: Writer, lines: readonly string[]): void => writer.write(`${escapedLines(lines)}\n`);

const accountLines = (account: PlanAccountView): string[] => [
  `${account.active ? '*' : ' '} ${[account.label, account.email ?? '', accountStateWord(account)].join('  ')}`,
  ...(account.cause === undefined ? [] : [`    cause: ${account.cause}`]),
];

export type AuthStatusPorts = { stdout: Writer; plan: PlanGatewayClient; listing(): Promise<MomongaModelList> };

export type ModelLine = { name: string; canon: string; billing: TargetBilling } | null;

export const modelLineOf = (listing: MomongaModelList, named: string | undefined): ModelLine => {
  const canon = named === undefined ? listing.start : listedModelOf(listing.data, named);
  const entry = listing.data.find((model) => model.id === canon);
  if (entry === undefined) return null;
  return { name: displayMapOf(listingViewsOf(listing.data)).get(entry.id) ?? entry.id, canon: entry.id, billing: entry.billing };
};

export const modelLineText = (line: ModelLine): string => (line === null ? `model: none (${messageOf('noModelConnected', 'cli')})` : `model: ${line.name} (${line.billing})`);

type ModelRead = { kind: 'read'; model: ModelLine } | { kind: 'unknown'; cause: string };

export const authStatus = async (ports: AuthStatusPorts, options: { json: boolean; model?: string }): Promise<number> => {
  const listed = await ports.plan.accounts();
  const read: ModelRead = await ports.listing().then(
    (listing) => ({ kind: 'read', model: modelLineOf(listing, options.model) }),
    (error: unknown) => ({ kind: 'unknown', cause: describeFailure(error) }),
  );
  const code = read.kind === 'read' ? EXIT_OK : EXIT_FAILURE;
  if (options.json) {
    ports.stdout.write(`${JSON.stringify(read.kind === 'read' ? { ...listed, model: read.model } : { ...listed, model: null, modelUnknown: read.cause })}\n`);
    return code;
  }
  const lines = listed.profiles.flatMap((profile) => {
    const accounts = [...accountsOf(profile.id, listed.accounts)].sort((left, right) => left.label.localeCompare(right.label));
    return [
      `${profile.messages.pickerLabel} (${profile.id})`,
      ...(accounts.length === 0 ? ['  not signed in'] : accounts.flatMap(accountLines)),
      `${profile.messages.manageUsageLabel}: ${profile.usageUrl}`,
    ];
  });
  print(ports.stdout, [
    ...(lines.length === 0 ? [NO_PROVIDER_TEXT] : lines),
    ...(listed.listProblems ?? []).map((problem) => `  ${listProblemLine(problem)}`),
    read.kind === 'read' ? modelLineText(read.model) : `model: unknown (${read.cause})`,
  ]);
  return code;
};

type Choose = (question: string, choices: readonly string[], until?: AbortSignal) => Promise<number | undefined>;

type TerminalPorts = { isTerminal: false } | { isTerminal: true; choose: Choose };

export type PasteTerminal = { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream };

type LoginTerminalPorts = { isTerminal: false } | { isTerminal: true; choose: Choose; terminal: PasteTerminal };

export type AuthLoginPorts = {
  stdout: Writer;
  stderr: Writer;
  plan: PlanGatewayClient;
  startListener: StartSignInListener;
  openUrl: OpenUrl;
  sandbox(): Promise<SandboxKind>;
  signal: AbortSignal;
  timers: SignInWaitTimers;
} & LoginTerminalPorts;

const PASTE_PROMPT = `${PASTE_LABEL}, then press Enter. Otherwise finish the sign-in in the browser.`;

const waitForAbort = (signal: AbortSignal): Promise<never> =>
  new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const pastedLine =
  (terminal: PasteTerminal, stderr: Writer) =>
  async (state: string, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted();
    const lines = createInterface({ input: terminal.stdin, output: terminal.stdout });
    const close = (): void => lines.close();
    signal.addEventListener('abort', close, { once: true });
    try {
      for await (const line of lines) {
        if (line.trim() === '') continue;
        const problem = pastedCallbackProblem(line, state);
        if (problem === undefined) return line;
        print(stderr, [problem]);
      }
      return await waitForAbort(signal);
    } finally {
      signal.removeEventListener('abort', close);
      lines.close();
    }
  };

const savedUnder = (listed: PlanAccountsResponse, profile: string, label: string): PlanAccountView | undefined => accountsOf(profile, listed.accounts).find((account) => account.label === label);

export type AuthLoginOptions = { provider?: string; account?: string; reconsent?: boolean; browser?: boolean; yes?: boolean };

const chosenProfile = async (ports: AuthLoginPorts, listed: PlanAccountsResponse, provider: string | undefined): Promise<PlanProfileView | undefined> => {
  if (provider !== undefined) return profileOf(listed.profiles, provider);
  const [only, ...others] = listed.profiles;
  if (only !== undefined && others.length === 0) return only;
  if (!ports.isTerminal) {
    print(ports.stderr, [`name the provider to sign in to: momonga auth login <provider>; the providers are ${listed.profiles.map((profile) => profile.id).join(', ')}`]);
    return undefined;
  }
  const index = await ports.choose('Sign in to which provider?', listed.profiles.map((profile) => `${profile.messages.pickerLabel} (${profile.id})`));
  return index === undefined ? undefined : listed.profiles[index];
};

const outcomeLines = (profile: PlanProfileView, account: string, answer: PlanSignInCompleteResponse): string[] => {
  switch (answer.outcome) {
    case RETRY_OUTCOME:
      return [codeNotAcceptedLine('cli', profile, account)];
    case IDENTITY_UNCONFIRMED_OUTCOME:
      return [identityNotConfirmedLine('cli', { profile: profile.id, account }, answer.identity)];
    case PLAN_DISABLED_STATE:
      return planDisabledLines('cli', profile, answer.account.label);
    case SIGNED_IN_OUTCOME: {
      const inUse = answer.account.pinnedBy.length > 0;
      return [
        signedInLine(answer.account),
        ...(inUse ? [] : [messageOf('accountWithoutModel', 'cli', { provider: profile.id, account: answer.account.label })]),
        ...(answer.firstSignIn && inUse ? [profile.messages.firstSignIn.title, profile.messages.firstSignIn.body] : []),
        ...(answer.firstSignIn ? [`${profile.messages.manageUsageLabel}: ${profile.usageUrl}`] : []),
      ];
    }
  }
};

export const authLogin = async (ports: AuthLoginPorts, options: AuthLoginOptions): Promise<number> => {
  if (options.account !== undefined && !isPlanLabel(options.account)) throw new UsageError(PLAN_LABEL_REFUSAL);
  const listed = await ports.plan.accounts();
  if (listed.profiles.length === 0) {
    print(ports.stderr, [NO_PROVIDER_TEXT]);
    return EXIT_FAILURE;
  }
  const profile = await chosenProfile(ports, listed, options.provider);
  if (profile === undefined) return EXIT_USAGE;
  const account = options.account ?? nextAccountLabel(profile.id, listed.accounts);
  const saved = savedUnder(listed, profile.id, account);
  const savedAction = saved === undefined ? undefined : savedAccountAction(saved);
  if (saved !== undefined && savedAction === 'none') {
    print(ports.stderr, [`${saved.label}: ${accountStateWord(saved)}`, ...(saved.cause === undefined ? [] : [`cause: ${saved.cause}`])]);
    return EXIT_FAILURE;
  }
  if (saved !== undefined && savedAction === 'replace') print(ports.stderr, [recordUnreadableLine('cli', saved)]);
  if ((await ports.sandbox()) === 'none') print(ports.stderr, SANDBOX_OFF_NOTICE);
  print(ports.stdout, [profile.messages.description]);
  const pasted =
    ports.isTerminal
      ? (state: string, signal: AbortSignal): Promise<string> => {
          print(ports.stdout, [PASTE_PROMPT]);
          return pastedLine(ports.terminal, ports.stderr)(state, signal);
        }
      : (_state: string, signal: AbortSignal): Promise<string> => waitForAbort(signal);
  const confirmIdentity = async (identity: PlanSignInIdentity, waiting: AbortSignal): Promise<boolean> => {
    if (options.yes === true) return true;
    if (!ports.isTerminal) return false;
    return (await ports.choose(identityQuestion('cli', profile, account, identity), IDENTITY_CHOICES, waiting)) === IDENTITY_SAVE;
  };
  let answer: PlanSignInCompleteResponse;
  try {
    answer = await signIn(
      {
        plan: ports.plan,
        startListener: ports.startListener,
        signal: ports.signal,
        timers: ports.timers,
        pasted,
        confirmIdentity,
        warn: (text) => print(ports.stderr, [text]),
        authorize: async ({ url }, waiting) => {
          if (options.browser === false) {
            print(ports.stdout, sensitiveUrlLines(url));
            return;
          }
          print(ports.stdout, [noBrowserHintLine({ profile: profile.id, account }, options.reconsent === true)]);
          ports.openUrl(url, waiting, (message) => {
            print(ports.stdout, sensitiveUrlLines(url));
            print(ports.stderr, [browserNotOpenedLine(message)]);
          });
        },
      },
      { profile: profile.id, account, reconsent: options.reconsent === true },
    );
  } catch (error) {
    if (ports.signal.aborted && error === ports.signal.reason) {
      print(ports.stderr, [cancelledLine(SIGN_IN_WORD)]);
      return EXIT_INTERRUPTED;
    }
    if (error instanceof SignInNotFinishedError) {
      print(ports.stderr, [signInFailureLine('cli', { profile: profile.id, account }, error)]);
      return EXIT_FAILURE;
    }
    if (error instanceof SignInListenerError || error instanceof SignInListenerFailedError) {
      print(ports.stderr, [error.message]);
      return EXIT_FAILURE;
    }
    throw error;
  }
  const signedIn = answer.outcome === SIGNED_IN_OUTCOME;
  print(signedIn ? ports.stdout : ports.stderr, outcomeLines(profile, account, answer));
  return signedIn ? EXIT_OK : EXIT_FAILURE;
};

export type AuthLogoutPorts = { stdout: Writer; stderr: Writer; plan: PlanGatewayClient } & TerminalPorts;

const accountNamed = (accounts: readonly PlanAccountView[], label: string): PlanAccountView => {
  const matching = accounts.filter((account) => account.label === label);
  const [only, ...others] = matching;
  if (only === undefined) throw new Error(`no saved account is labelled ${JSON.stringify(label)}; momonga auth status lists them`);
  if (others.length > 0) throw new Error(`the label ${JSON.stringify(label)} is saved for several providers: ${matching.map((account) => account.profile).join(', ')}`);
  return only;
};

export const authLogout = async (ports: AuthLogoutPorts, options: { account?: string }): Promise<number> => {
  const listed = await ports.plan.accounts();
  let chosen: PlanAccountView;
  if (options.account !== undefined) chosen = accountNamed(listed.accounts, options.account);
  else if (!ports.isTerminal) {
    print(ports.stderr, [SIGN_OUT_LABEL_NEEDED_LINE]);
    return EXIT_USAGE;
  } else if (listed.accounts.length === 0) {
    print(ports.stderr, [NO_ACCOUNT_SAVED_TEXT]);
    return EXIT_FAILURE;
  } else {
    const index = await ports.choose('Sign out which account?', listed.accounts.map((account) => `${account.label} · ${account.email ?? ''} · ${accountStateWord(account)}`));
    const picked = index === undefined ? undefined : listed.accounts[index];
    if (picked === undefined) return EXIT_USAGE;
    chosen = picked;
  }
  const report = await ports.plan.signOut({ profile: chosen.profile, account: chosen.label });
  const profile = profileOf(listed.profiles, chosen.profile);
  print(ports.stdout, signedOutLines(profile, chosen.label, report));
  return EXIT_OK;
};

export type AuthResumePorts = { stdout: Writer; stderr: Writer; plan: PlanGatewayClient };

export const authResume = async (ports: AuthResumePorts, options: { account: string }): Promise<number> => {
  const listed = await ports.plan.accounts();
  const chosen = accountNamed(listed.accounts, options.account);
  const answer = await ports.plan.resume(chosen.label, { profile: chosen.profile });
  print(ports.stdout, [resumeLine(chosen.label, answer.resumed)]);
  return EXIT_OK;
};

const RESET_HOST_CONFIRM = 'Register this computer as a new host';

const RESET_HOST_CHOICES = ['Cancel', RESET_HOST_CONFIRM] as const;

export type AuthResetHostPorts = { stdout: Writer; stderr: Writer; plan: PlanGatewayClient } & TerminalPorts;

export const authResetHost = async (ports: AuthResetHostPorts, options: { yes: boolean }): Promise<number> => {
  if (!options.yes && !ports.isTerminal) {
    print(ports.stderr, ['momonga auth reset-host needs --yes when it does not run in a terminal']);
    return EXIT_USAGE;
  }
  const { profiles } = await ports.plan.accounts();
  if (profiles.length === 0) {
    print(ports.stderr, [NO_PROVIDER_TEXT]);
    return EXIT_FAILURE;
  }
  const hostProfiles = profiles.filter((profile) => profile.usesHostIdentity !== false);
  if (hostProfiles.length > 0) print(ports.stdout, [resetHostWarning(hostProfiles)]);
  if (!options.yes && ports.isTerminal) {
    const chosen = await ports.choose('Reset the host identity?', RESET_HOST_CHOICES);
    if (chosen === undefined || RESET_HOST_CHOICES[chosen] !== RESET_HOST_CONFIRM) return EXIT_USAGE;
  }
  const reset = await ports.plan.resetHost();
  print(ports.stdout, [`This computer is now the host ${reset.hostId}`]);
  return EXIT_OK;
};
