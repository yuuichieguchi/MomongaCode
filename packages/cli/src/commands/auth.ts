import type { PlanAccountView, PlanAccountsResponse, PlanProfileView, PlanSignInCompleteResponse } from '@momonga/protocol';
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

export type AuthStatusPorts = { stdout: Writer; plan: PlanGatewayClient };

export const authStatus = async (ports: AuthStatusPorts, options: { json: boolean }): Promise<number> => {
  const listed = await ports.plan.accounts();
  if (options.json) {
    ports.stdout.write(`${JSON.stringify(listed)}\n`);
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
  print(ports.stdout, lines.length === 0 ? ['no subscription provider is available'] : lines);
  return 0;
};

export type AuthLoginPorts = {
  stdout: Writer;
  stderr: Writer;
  plan: PlanGatewayClient;
  startListener: StartSignInListener;
  openUrl(url: URL): Promise<void>;
  sandbox(): Promise<SandboxKind>;
};

const NEVER_INTERRUPTED = new AbortController().signal;

export type AuthLoginOptions = { provider?: string; account?: string; reconsent?: boolean; browser?: boolean };

const chosenProfile = (listed: PlanAccountsResponse, provider: string | undefined): PlanProfileView => {
  if (provider !== undefined) return profileOf(listed.profiles, provider);
  const [only, ...others] = listed.profiles;
  if (only === undefined || others.length > 0) throw new Error(`name the provider to sign in to: momonga auth login <provider>; the providers are ${listed.profiles.map((profile) => profile.id).join(', ')}`);
  return only;
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
  const profile = chosenProfile(listed, options.provider);
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
        if (options.browser !== false) await ports.openUrl(url);
      },
    },
    { profile: profile.id, account, reconsent: options.reconsent === true },
  );
  print(ports.stdout, outcomeLines(profile, answer));
  return answer.outcome === 'signed_in' ? 0 : EXIT_NOT_SIGNED_IN;
};

export type AuthLogoutPorts = { stdout: Writer; stderr: Writer; plan: PlanGatewayClient } & (
  | { isTerminal: false }
  | { isTerminal: true; choose(question: string, choices: readonly string[]): Promise<number | undefined> }
);

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
