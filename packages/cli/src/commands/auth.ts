import type { MomongaModelEntry, PlanAccountView, PlanAccountsResponse, PlanProfileView, PlanSignInCompleteResponse, TargetBilling } from '@momonga/protocol';
import type { PlanGatewayClient } from '../client/gateway-client.ts';
import { SANDBOX_OFF_NOTICE, accountStateWord, accountsOf, nextAccountLabel, profileOf } from '../plan/accounts.ts';
import { signIn } from '../plan/sign-in.ts';
import type { SandboxKind, StartSignInListener } from '../plan/sign-in.ts';
import { escapedLines } from '../terminal-writer.ts';

export { nextAccountLabel };

type Writer = { write(text: string): void };

const EXIT_USAGE = 2;
const EXIT_NOT_SIGNED_IN = 1;

const print = (writer: Writer, lines: readonly string[]): void => writer.write(`${escapedLines(lines)}\n`);

const accountLines = (account: PlanAccountView): string[] => [
  `${account.active ? '*' : ' '} ${[account.label, account.email ?? '', accountStateWord(account)].join('  ')}`,
  ...(account.cause === undefined ? [] : [`    cause: ${account.cause}`]),
];

export type AuthStatusPorts = { stdout: Writer; plan: PlanGatewayClient; models(): Promise<readonly MomongaModelEntry[]> };

export const DEFAULT_ALIAS = 'default';

type ModelLine = { alias: string; targets: { name: string; billing: TargetBilling }[] } | null;

const billingOf = (entry: MomongaModelEntry, target: string): TargetBilling => {
  const billing = entry.targetBilling?.[target];
  if (billing === undefined) throw new Error(`the gateway did not report the billing of the target ${target}`);
  return billing;
};

export const modelLineOf = (models: readonly MomongaModelEntry[], alias: string): ModelLine => {
  const entry = models.find((model) => model.id === alias);
  return entry === undefined ? null : { alias, targets: entry.targets.map((name) => ({ name, billing: billingOf(entry, name) })) };
};

export const modelLineText = (line: ModelLine): string =>
  line === null ? 'model: none' : `model: ${line.alias} -> ${line.targets.map((target) => `${target.name} (${target.billing})`).join(', ')}`;

export const authStatus = async (ports: AuthStatusPorts, options: { json: boolean; alias?: string }): Promise<number> => {
  const listed = await ports.plan.accounts();
  const model = modelLineOf(await ports.models(), options.alias ?? DEFAULT_ALIAS);
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
  print(ports.stdout, [...(lines.length === 0 ? ['no subscription provider is available'] : lines), modelLineText(model)]);
  return 0;
};

type Choose = (question: string, choices: readonly string[]) => Promise<number | undefined>;

type TerminalPorts = { isTerminal: false } | { isTerminal: true; choose: Choose };

export type AuthLoginPorts = {
  stdout: Writer;
  stderr: Writer;
  plan: PlanGatewayClient;
  startListener: StartSignInListener;
  openUrl(url: URL): Promise<void>;
  sandbox(): Promise<SandboxKind>;
} & TerminalPorts;

const NEVER_INTERRUPTED = new AbortController().signal;

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

const outcomeLines = (profile: PlanProfileView, answer: PlanSignInCompleteResponse): string[] => {
  switch (answer.outcome) {
    case 'retry':
      return [`${profile.messages.identityLabel} did not accept the sign-in code (invalid_grant). Run momonga auth login ${profile.id} again to start a new sign-in.`];
    case 'plan_disabled':
      return [`${profile.messages.planNotEnabledMessage} · Run momonga auth login ${profile.id} --account ${answer.account.label} --reconsent to enable it`];
    case 'signed_in':
      return [
        `Signed in as ${answer.account.label}${answer.account.email === undefined ? '' : ` (${answer.account.email})`}`,
        ...(answer.firstSignIn ? [profile.messages.firstSignIn.title, profile.messages.firstSignIn.body, `${profile.messages.manageUsageLabel}: ${profile.usageUrl}`] : []),
      ];
  }
};

export const authLogin = async (ports: AuthLoginPorts, options: AuthLoginOptions): Promise<number> => {
  const listed = await ports.plan.accounts();
  const profile = await chosenProfile(ports, listed, options.provider);
  if (profile === undefined) return EXIT_USAGE;
  const account = options.account ?? nextAccountLabel(profile.id, listed.accounts);
  if ((await ports.sandbox()) === 'none') print(ports.stderr, SANDBOX_OFF_NOTICE);
  print(ports.stdout, [profile.messages.description]);
  const answer = await signIn(
    {
      plan: ports.plan,
      startListener: ports.startListener,
      signal: NEVER_INTERRUPTED,
      authorize: async (url) => {
        print(ports.stdout, [`${profile.loginLabel}: open this URL in your browser if it does not open by itself:`, url.href]);
        if (options.browser === false) return;
        await ports.openUrl(url).catch((error: unknown) => {
          print(ports.stderr, [`Could not open the browser (${error instanceof Error ? error.message : String(error)}). Open the URL above to continue.`]);
        });
      },
    },
    { profile: profile.id, account, reconsent: options.reconsent === true },
  );
  print(ports.stdout, outcomeLines(profile, answer));
  return answer.outcome === 'signed_in' ? 0 : EXIT_NOT_SIGNED_IN;
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
  print(ports.stdout, [
    `Signed out ${chosen.label}`,
    ...(report.revocation === 'confirmed' ? [] : [`The sign-in could not be confirmed as revoked; disconnect the app in ${profile.messages.identityLabel} settings: ${report.usageUrl}`]),
  ]);
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
  print(ports.stdout, [answer.resumed ? `Resumed plan use for ${chosen.label}` : `${chosen.label} is not paused`]);
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
