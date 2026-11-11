import { NO_MODEL_CONNECTED_TEXT, PLAN_LABEL_REFUSAL, displayMapOf, isPlanLabel, PLAN_DISABLED_STATE, RETRY_OUTCOME, SIGNED_IN_OUTCOME } from '@momonga/protocol';
import type { MomongaModelList, PlanAccountView, PlanAccountsResponse, PlanProfileView, PlanSignInCompleteResponse, TargetBilling } from '@momonga/protocol';
import type { OpenUrl } from '@momonga/foundation';
import { couldNotOpenBrowser } from '../browser-text.ts';
import { listingViewsOf } from '../client/gateway-client.ts';
import type { PlanGatewayClient } from '../client/gateway-client.ts';
import { listedModelOf } from './models.ts';
import { createInterface } from 'node:readline';
import { SANDBOX_OFF_NOTICE, accountStateWord, accountsOf, nextAccountLabel, profileOf, savedAccountAction } from '../plan/accounts.ts';
import {
  PASTE_LABEL,
  SignInAttemptNotFoundError,
  SignInExpiredError,
  SignInGatewayStoppedError,
  SignInListenerError,
  SignInListenerFailedError,
  pastedCallbackProblem,
  signIn,
} from '../plan/sign-in.ts';
import type { SandboxKind, SignInWaitTimers, StartSignInListener } from '../plan/sign-in.ts';
import { codeNotAcceptedLine, listProblemLine, noBrowserHintLine, planDisabledLines, resumeLine, sensitiveUrlLines, signedInLine, signedOutLines, tryAgainLine } from '../plan/texts.ts';
import { escapedLines } from '../terminal-writer.ts';

export { nextAccountLabel };

type Writer = { write(text: string): void };

const EXIT_USAGE = 2;
const EXIT_NOT_SIGNED_IN = 1;
const EXIT_INTERRUPTED = 130;

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

export const modelLineText = (line: ModelLine): string => (line === null ? `model: none (${NO_MODEL_CONNECTED_TEXT})` : `model: ${line.name} (${line.billing})`);

export const authStatus = async (ports: AuthStatusPorts, options: { json: boolean; model?: string }): Promise<number> => {
  const listed = await ports.plan.accounts();
  const model = modelLineOf(await ports.listing(), options.model);
  if (options.json) {
    ports.stdout.write(`${JSON.stringify({ ...listed, model })}\n`);
    return 0;
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
    ...(lines.length === 0 ? ['no subscription provider is available'] : lines),
    ...(listed.listProblems ?? []).map((problem) => `  ${listProblemLine(problem)}`),
    modelLineText(model),
  ]);
  return 0;
};

type Choose = (question: string, choices: readonly string[]) => Promise<number | undefined>;

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

const unfixableAccount = (listed: PlanAccountsResponse, profile: string, label: string): PlanAccountView | undefined =>
  accountsOf(profile, listed.accounts).find((account) => account.label === label && savedAccountAction(account) === 'none');

export type AuthLoginOptions = { provider?: string; account?: string; reconsent?: boolean; browser?: boolean };

const chosenProfile = async (ports: AuthLoginPorts, listed: PlanAccountsResponse, provider: string | undefined): Promise<PlanProfileView | undefined> => {
  if (provider !== undefined) return profileOf(listed.profiles, provider);
  const [only, ...others] = listed.profiles;
  if (only !== undefined && others.length === 0) return only;
  if (!ports.isTerminal || only === undefined) {
    print(ports.stderr, [`name the provider to sign in to: momonga auth login <provider>; the providers are ${listed.profiles.map((profile) => profile.id).join(', ')}`]);
    return undefined;
  }
  const index = await ports.choose('Sign in to which provider?', listed.profiles.map((profile) => `${profile.messages.pickerLabel} (${profile.id})`));
  return index === undefined ? undefined : listed.profiles[index];
};

const outcomeLines = (profile: PlanProfileView, account: string, answer: PlanSignInCompleteResponse): string[] => {
  switch (answer.outcome) {
    case RETRY_OUTCOME:
      return [codeNotAcceptedLine('headless', profile, account)];
    case PLAN_DISABLED_STATE:
      return planDisabledLines('headless', profile, answer.account.label);
    case SIGNED_IN_OUTCOME:
      return [
        signedInLine(answer.account),
        ...(answer.firstSignIn ? [profile.messages.firstSignIn.title, profile.messages.firstSignIn.body, `${profile.messages.manageUsageLabel}: ${profile.usageUrl}`] : []),
      ];
  }
};

export const authLogin = async (ports: AuthLoginPorts, options: AuthLoginOptions): Promise<number> => {
  if (options.account !== undefined && !isPlanLabel(options.account)) {
    print(ports.stderr, [`momonga: ${PLAN_LABEL_REFUSAL}`]);
    return EXIT_USAGE;
  }
  const listed = await ports.plan.accounts();
  const profile = await chosenProfile(ports, listed, options.provider);
  if (profile === undefined) return EXIT_USAGE;
  const account = options.account ?? nextAccountLabel(profile.id, listed.accounts);
  const unfixable = unfixableAccount(listed, profile.id, account);
  if (unfixable !== undefined) {
    print(ports.stderr, [`${unfixable.label}: ${accountStateWord(unfixable)}`, ...(unfixable.cause === undefined ? [] : [`cause: ${unfixable.cause}`])]);
    return EXIT_NOT_SIGNED_IN;
  }
  if ((await ports.sandbox()) === 'none') print(ports.stderr, SANDBOX_OFF_NOTICE);
  print(ports.stdout, [profile.messages.description]);
  const tryAgain = tryAgainLine('headless', { profile: profile.id, account });
  const pasted =
    ports.isTerminal
      ? (state: string, signal: AbortSignal): Promise<string> => {
          print(ports.stdout, [PASTE_PROMPT]);
          return pastedLine(ports.terminal, ports.stderr)(state, signal);
        }
      : (_state: string, signal: AbortSignal): Promise<string> => waitForAbort(signal);
  let answer: PlanSignInCompleteResponse;
  try {
    answer = await signIn(
      {
        plan: ports.plan,
        startListener: ports.startListener,
        signal: ports.signal,
        timers: ports.timers,
        pasted,
        authorize: async ({ url }, waiting) => {
          if (options.browser === false) {
            print(ports.stdout, sensitiveUrlLines(url));
            return;
          }
          print(ports.stdout, [noBrowserHintLine(profile.id, account)]);
          ports.openUrl(url, waiting, (message) => {
            print(ports.stdout, sensitiveUrlLines(url));
            print(ports.stderr, [`${couldNotOpenBrowser(message)} Open the URL above to continue.`]);
          });
        },
      },
      { profile: profile.id, account, reconsent: options.reconsent === true },
    );
  } catch (error) {
    if (ports.signal.aborted && error === ports.signal.reason) {
      print(ports.stderr, ['momonga: sign-in cancelled']);
      return EXIT_INTERRUPTED;
    }
    if (error instanceof SignInExpiredError || error instanceof SignInAttemptNotFoundError) {
      print(ports.stderr, [`${error.message} ${tryAgain}`]);
      return EXIT_NOT_SIGNED_IN;
    }
    if (error instanceof SignInListenerError || error instanceof SignInListenerFailedError || error instanceof SignInGatewayStoppedError) {
      print(ports.stderr, [error.message]);
      return EXIT_NOT_SIGNED_IN;
    }
    throw error;
  }
  print(ports.stdout, outcomeLines(profile, account, answer));
  return answer.outcome === SIGNED_IN_OUTCOME ? 0 : EXIT_NOT_SIGNED_IN;
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
    print(ports.stderr, ['momonga auth logout needs the account label when it does not run in a terminal: momonga auth logout <account>']);
    return EXIT_USAGE;
  } else {
    const index = await ports.choose('Sign out which account?', listed.accounts.map((account) => `${account.label} · ${account.email ?? ''} · ${accountStateWord(account)}`));
    const picked = index === undefined ? undefined : listed.accounts[index];
    if (picked === undefined) return EXIT_USAGE;
    chosen = picked;
  }
  const report = await ports.plan.signOut({ profile: chosen.profile, account: chosen.label });
  const profile = profileOf(listed.profiles, chosen.profile);
  print(ports.stdout, signedOutLines(profile, chosen.label, report));
  return 0;
};

export type AuthResumePorts = { stdout: Writer; stderr: Writer; plan: PlanGatewayClient };

export const authResume = async (ports: AuthResumePorts, options: { account: string }): Promise<number> => {
  const listed = await ports.plan.accounts();
  if (!listed.accounts.some((account) => account.label === options.account)) {
    print(ports.stderr, [`no saved account is labelled ${JSON.stringify(options.account)}; momonga auth status lists them`]);
    return EXIT_NOT_SIGNED_IN;
  }
  const chosen = accountNamed(listed.accounts, options.account);
  const answer = await ports.plan.resume(chosen.label, { profile: chosen.profile });
  print(ports.stdout, [resumeLine(chosen.label, answer.resumed)]);
  return 0;
};

export const RESET_HOST_WARNING =
  'This computer will be registered as a new host with ChatGPT. Saved accounts keep their records; whether ChatGPT accepts them under the new host is not documented, so sign in again if one stops working.';

const RESET_HOST_CONFIRM = 'Register this computer as a new host';

const RESET_HOST_CHOICES = ['Cancel', RESET_HOST_CONFIRM] as const;

export type AuthResetHostPorts = { stdout: Writer; stderr: Writer; plan: PlanGatewayClient } & TerminalPorts;

export const authResetHost = async (ports: AuthResetHostPorts, options: { yes: boolean }): Promise<number> => {
  if (!options.yes && !ports.isTerminal) {
    print(ports.stderr, ['momonga auth reset-host needs --yes when it does not run in a terminal']);
    return EXIT_USAGE;
  }
  print(ports.stdout, [RESET_HOST_WARNING]);
  if (!options.yes && ports.isTerminal) {
    const chosen = await ports.choose('Reset the host identity?', RESET_HOST_CHOICES);
    if (chosen === undefined || RESET_HOST_CHOICES[chosen] !== RESET_HOST_CONFIRM) return EXIT_USAGE;
  }
  const reset = await ports.plan.resetHost();
  print(ports.stdout, [`This computer is now the host ${reset.hostId}`]);
  return 0;
};
