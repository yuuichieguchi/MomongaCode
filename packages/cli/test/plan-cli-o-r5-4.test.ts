import { messageOf } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import type { MomongaModelList, PlanAccountView, PlanModelsResponse, PlanProfileView } from '@momonga/protocol';
import * as authCommands from '../src/commands/auth.ts';
import * as modelCommands from '../src/commands/models.ts';
import * as signInModule from '../src/plan/sign-in.ts';
import type { PlanGatewayClient } from '../src/client/gateway-client.ts';
import { runModelsForm } from '../src/commands/models.ts';
import { CHATGPT, account } from './fake-plan-gateway.tsx';
import { S3, documentOf, homeWith, listingOf, shellOf } from './models-shell-harness.ts';

type Writer = { written: string[]; write(text: string): void; text(): string };

const writer = (): Writer => {
  const written: string[] = [];
  return { written, write: (text) => void written.push(text), text: () => written.join('') };
};

type Call = { route: string; args: unknown[] };

const CATALOG: PlanModelsResponse = {
  readAt: '2026-11-10T00:00:00.000Z',
  models: [
    { slug: 'gpt-wide', displayName: 'GPT Wide', usable: true, contextWindow: 200000, maxOutputTokens: 50000 },
    { slug: 'gpt-quiet', displayName: 'GPT Quiet', usable: false, reason: 'the server reports no context window for this model' },
  ],
};

const fakePlan = (options: { accounts?: readonly PlanAccountView[]; profiles?: readonly PlanProfileView[]; resumed?: boolean } = {}) => {
  const calls: Call[] = [];
  const record = (route: string, ...args: unknown[]): void => void calls.push({ route, args });
  const plan = {
    accounts: async () => {
      record('accounts');
      return { profiles: [...(options.profiles ?? [CHATGPT])], accounts: [...(options.accounts ?? [account({ label: 'work' })])] };
    },
    resume: async (label: string, request: unknown) => {
      record('resume', label, request);
      return { resumed: options.resumed ?? true };
    },
    resetHost: async () => {
      record('resetHost');
      return { hostId: 'urn:ietf:params:oauth:jwk-thumbprint:sha-256:new' };
    },
    accountModels: async (label: string, request?: unknown) => {
      record('accountModels', label, request);
      return CATALOG;
    },
    addTarget: async (label: string, request: unknown) => {
      record('addTarget', label, request);
      return { model: 'chatgpt/gpt-wide' };
    },
  } as unknown as PlanGatewayClient;
  return { plan, calls };
};

const commands = authCommands as unknown as Record<string, (ports: unknown, options: unknown) => Promise<number>>;
const models = modelCommands as unknown as Record<string, (ports: unknown, options: unknown) => Promise<number>>;

describe('momonga auth resume (O-R5-4 S3)', () => {
  it('resumes the named account through the resume route and says so', async () => {
    const { plan, calls } = fakePlan({ resumed: true });
    const stdout = writer();
    expect(await commands['authResume']?.({ stdout, stderr: writer(), plan }, { account: 'work' })).toBe(0);
    expect(calls.find((call) => call.route === 'resume')?.args).toEqual(['work', { profile: 'chatgpt' }]);
    expect(stdout.text()).toBe('Resumed plan use for work\n');
  });

  it('says the account is not paused when the route answers resumed false, exit 0', async () => {
    const { plan } = fakePlan({ resumed: false });
    const stdout = writer();
    expect(await commands['authResume']?.({ stdout, stderr: writer(), plan }, { account: 'work' })).toBe(0);
    expect(stdout.text()).toBe('work is not paused\n');
  });

  it('fails for an unknown label with the sentence auth logout gives, and resumes nothing', async () => {
    const { plan, calls } = fakePlan();
    await expect(commands['authResume']?.({ stdout: writer(), stderr: writer(), plan }, { account: 'nobody' })).rejects.toThrow('no saved account is labelled "nobody"; momonga auth status lists them');
    expect(calls.filter((call) => call.route === 'resume')).toEqual([]);
  });
});

describe('momonga auth reset-host (O-R5-4 S4)', () => {
  const WARNING =
    'This computer will be registered as a new host with ChatGPT. Saved accounts keep their records; whether ChatGPT accepts them under the new host is not documented, so sign in again if one stops working.';

  it('needs --yes without a terminal: exit 2 and nothing sent', async () => {
    const { plan, calls } = fakePlan();
    expect(await commands['authResetHost']?.({ stdout: writer(), stderr: writer(), plan, isTerminal: false }, { yes: false })).toBe(2);
    expect(calls.filter((call) => call.route === 'resetHost')).toEqual([]);
  });

  it('prints the warning and resets with --yes', async () => {
    const { plan, calls } = fakePlan();
    const stdout = writer();
    expect(await commands['authResetHost']?.({ stdout, stderr: writer(), plan, isTerminal: false }, { yes: true })).toBe(0);
    expect(stdout.text()).toContain(WARNING);
    expect(calls.filter((call) => call.route === 'resetHost')).toHaveLength(1);
  });

  it('asks in a terminal with Cancel first, and sends nothing when Cancel is chosen', async () => {
    const { plan, calls } = fakePlan();
    const asked: (readonly string[])[] = [];
    const choose = async (_question: string, choices: readonly string[]) => {
      asked.push(choices);
      return 0;
    };
    await commands['authResetHost']?.({ stdout: writer(), stderr: writer(), plan, isTerminal: true, choose }, { yes: false });
    expect(asked[0]?.[0]).toBe('Cancel');
    expect(calls.filter((call) => call.route === 'resetHost')).toEqual([]);
  });
});

describe('momonga models catalog and momonga models add --plan (O-R5-4 S5)', () => {
  it('prints one row per entry in server order, reading with refresh', async () => {
    const { plan, calls } = fakePlan();
    const stdout = writer();
    expect(await models['modelsCatalog']?.({ stdout, stderr: writer(), plan }, { json: false })).toBe(0);
    expect(stdout.text()).toBe('gpt-wide  GPT Wide  context 200000  max output 50000\ngpt-quiet  GPT Quiet  unusable: the server reports no context window for this model\n');
    expect(calls.find((call) => call.route === 'accountModels')?.args).toEqual(['work', { profile: 'chatgpt', refresh: true }]);
  });

  it('prints the route answer with --json', async () => {
    const { plan } = fakePlan();
    const stdout = writer();
    await models['modelsCatalog']?.({ stdout, stderr: writer(), plan }, { json: true });
    expect(JSON.parse(stdout.text())).toEqual(CATALOG);
  });

  it('requires the account when several accounts could answer', async () => {
    const { plan } = fakePlan({ accounts: [account({ label: 'work' }), account({ label: 'home', active: false })] });
    const stderr = writer();
    const profiles = [CHATGPT, { ...CHATGPT, id: 'other' }];
    const several = fakePlan({ accounts: [account({ label: 'work' }), account({ profile: 'other', label: 'lab' })], profiles });
    expect(await models['modelsCatalog']?.({ stdout: writer(), stderr, plan: several.plan }, { json: false })).not.toBe(0);
    expect(await models['modelsCatalog']?.({ stdout: writer(), stderr: writer(), plan }, { json: false })).toBe(0);
  });

  it('adds a model of a plan account to the settings through the one writer and prints the confirm sentence and the summary', async (context) => {
    const at = homeWith(context, undefined);
    const harness = shellOf(at);
    expect(await runModelsForm(harness.shell, 'add', { args: [], options: { plan: 'chatgpt', model: 'gpt-wide', yes: true } })).toBe(0);
    expect(harness.out()).toBe('Add gpt-wide to your settings?\nAdded gpt-wide. It is used from the next request.\n');
    expect(documentOf(at.settingsFile)).toEqual({ models: { connections: [{ adapter: 'open-responses', plan: { profile: 'chatgpt' }, models: [{ id: 'gpt-wide' }] }] } });
  });
});

describe('the auth status model line (O-R5-4 S8)', () => {
  const EMPTY: MomongaModelList = { object: 'list', data: [], start: null, roles: {} };

  it('ends with model: <name> (<billing>) for the model new sessions start with', async (context) => {
    const { plan } = fakePlan();
    const stdout = writer();
    const listing = listingOf(homeWith(context, S3).home);
    await authCommands.authStatus({ stdout, plan, listing: async () => listing }, { json: false });
    expect(stdout.text().trimEnd().split('\n').at(-1)).toBe('model: chatgpt/gpt-5.5 (plan)');
  });

  it('says that no model is connected when there is none, and adds model to --json', async (context) => {
    const { plan } = fakePlan();
    const stdout = writer();
    await authCommands.authStatus({ stdout, plan, listing: async () => EMPTY }, { json: false });
    expect(stdout.text().trimEnd().split('\n').at(-1)).toBe(`model: none (${messageOf('noModelConnected', 'cli')})`);
    const json = writer();
    const listing = listingOf(homeWith(context, S3).home);
    await authCommands.authStatus({ stdout: json, plan, listing: async () => listing }, { json: true });
    expect(JSON.parse(json.text()).model).toEqual({ name: 'chatgpt/gpt-5.5', canon: 'chatgpt/gpt-5.5', billing: 'plan' });
    const none = writer();
    await authCommands.authStatus({ stdout: none, plan, listing: async () => EMPTY }, { json: true });
    expect(JSON.parse(none.text()).model).toBeNull();
  });
});

describe('momonga auth login with several profiles and no provider (O-R5-4 S11)', () => {
  const profiles = [CHATGPT, { ...CHATGPT, id: 'other', messages: { ...CHATGPT.messages, pickerLabel: 'Other plan' } }];

  it('offers the profiles in a terminal as pickerLabel (id)', async () => {
    const { plan } = fakePlan({ profiles, accounts: [] });
    const asked: (readonly string[])[] = [];
    await authCommands
      .authLogin(
        {
          stdout: writer(),
          stderr: writer(),
          plan,
          startListener: async () => {
            throw new Error('stop after the choice');
          },
          openUrl: () => Promise.resolve(),
          sandbox: async () => 'seatbelt',
          isTerminal: true,
          choose: async (_question: string, choices: readonly string[]) => {
            asked.push(choices);
            return undefined;
          },
        } as never,
        {},
      )
      .catch(() => undefined);
    expect(asked[0]).toEqual([`${CHATGPT.messages.pickerLabel} (chatgpt)`, 'Other plan (other)']);
  });

  it('exits 2 without a terminal, naming the providers', async () => {
    const { plan } = fakePlan({ profiles, accounts: [] });
    const stderr = writer();
    const code = await authCommands
      .authLogin({ stdout: writer(), stderr, plan, startListener: async () => ({}) as never, openUrl: () => Promise.resolve(), sandbox: async () => 'seatbelt', isTerminal: false } as never, {})
      .catch((error: unknown) => error);
    expect(code).toBe(2);
    expect(stderr.text()).toContain('name the provider to sign in to: momonga auth login <provider>; the providers are chatgpt, other');
  });
});

describe('the paste box for a remote machine (O-R5-4 S2)', () => {
  const problem = (text: string, state: string): string | undefined =>
    (signInModule as unknown as { pastedCallbackProblem: (text: string, state: string) => string | undefined }).pastedCallbackProblem(text, state);

  it('accepts a redirect URL whose state matches, with a code or an error', () => {
    expect(problem('http://127.0.0.1:49152/auth/callback?code=abc&state=st-1', 'st-1')).toBeUndefined();
    expect(problem('http://localhost:1/elsewhere?error=access_denied&state=st-1', 'st-1')).toBeUndefined();
  });

  it('names a value over 8 KiB, a value that is not a redirect URL, and a URL of another sign-in', () => {
    expect(problem(`http://127.0.0.1:1/auth/callback?code=${'x'.repeat(8 * 1024)}&state=st-1`, 'st-1')).toBe('That text is too long to be a redirect URL.');
    expect(problem('not a url', 'st-1')).toBe('That is not a redirect URL from the browser.');
    expect(problem('http://127.0.0.1:1/auth/callback?state=st-1', 'st-1')).toBe('That is not a redirect URL from the browser.');
    expect(problem('http://127.0.0.1:1/auth/callback?code=abc&state=other', 'st-1')).toBe('That URL did not belong to this sign-in. Paste the URL again.');
  });
});
