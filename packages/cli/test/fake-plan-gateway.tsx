import { TEST_KEY_SETTLE_MS, settleAtOnce } from './ink-helpers.ts';
import { PLAN_PROFILES } from '@momonga/config';
import type {
  DetectedLocalServer,
  GatewayHealth,
  MomongaModelEntry,
  PlanAccountView,
  PlanModelsResponse,
  PlanProfileView,
  PlanSignInCompleteResponse,
  PlanSignInIdentityUnconfirmed,
  TargetBilling,
  TargetHealth,
} from '@momonga/protocol';
import { App } from '../src/tui/app.tsx';
import type { AppProps, TuiOutcome } from '../src/tui/app.tsx';
import type { PlanGatewayClient } from '../src/client/gateway-client.ts';
import type { SignInListener, TuiBackend } from '../src/tui/backend.ts';
import type { SignInWaitTimers, StartSignInListener } from '../src/plan/sign-in.ts';
import { createFakeClock, createFakeTimers, pollUntil } from '@momonga/testkit';
import { SESSION, fakeBackend } from './fake-backend.ts';
import type { FakeBackend, FakeBackendOptions } from './fake-backend.ts';
import { FRAME_BOUND_MS, KEYS, renderObservable, untilFrame } from './ink-helpers.ts';
import type { Instance } from './ink-helpers.ts';
import { WIDE_TEST_SCREEN, fakeScreenTerminal } from './tui/screen-fakes.ts';
import type { FakeScreenSize } from './tui/screen-fakes.ts';
import { systemTiming } from '@momonga/foundation';

const shipped = PLAN_PROFILES['chatgpt'];
if (shipped === undefined) throw new Error('the chatgpt profile is not shipped');

export const CHATGPT: PlanProfileView = { id: shipped.id, usageUrl: shipped.usageUrl, messages: shipped.messages, loginLabel: shipped.loginLabel };

export const LISTENER_PORT = 49152;
export const PLAN_TEST_TIMEOUT_MS = FRAME_BOUND_MS * 4;
export const AUTHORIZATION_URL = 'https://auth.openai.com/api/accounts/authorize?client_id=c&state=st-1';

export const account = (overrides: Partial<PlanAccountView> = {}): PlanAccountView => ({
  profile: 'chatgpt',
  label: 'chatgpt',
  email: 'ada@example.com',
  state: 'active',
  active: true,
  pinnedBy: ['gpt-5'],
  ...overrides,
});

export const IDENTITY_UNCONFIRMED: PlanSignInIdentityUnconfirmed = {
  outcome: 'identity_unconfirmed',
  attemptId: 'attempt-1',
  identity: { subject: 'sub-1', email: 'ada@example.com' },
  expiresAt: '2026-11-10T00:10:00.000Z',
};

export type PlanCall = { route: string; body?: unknown };

export type FakePlanOptions = FakeBackendOptions & {
  accounts?: readonly PlanAccountView[];
  profiles?: readonly PlanProfileView[];
  catalogs?: Readonly<Record<string, PlanModelsResponse>>;
  catalogFailures?: Readonly<Record<string, Error>>;
  complete?: PlanSignInCompleteResponse;
  confirmed?: PlanSignInCompleteResponse;
  completeFails?: Error;
  health?: Readonly<Record<string, TargetHealth>>;
  billing?: Readonly<Record<string, TargetBilling>>;
  planTargets?: Readonly<Record<string, { profile: string; account?: string }>>;
  keyGroups?: Readonly<Record<string, string>>;
  dismissed?: Readonly<Record<string, string>>;
  callbackArrives?: boolean;
  completeHeld?: Promise<void>;
  listProblems?: readonly { file: string; cause: string }[];
  listenerFails?: Error;
  startListener?: StartSignInListener;
  signInTimers?: SignInWaitTimers;
  signOutRevocation?: 'confirmed' | 'unconfirmed' | 'none';
  resumeAnswer?: { resumed: boolean };
};

export type FakePlanBackend = FakeBackend & {
  readonly plan: PlanGatewayClient;
  readonly planCalls: PlanCall[];
  readonly dismissals: string[];
  readonly listenerPaths: string[];
  readonly clipboard: string[];
};

export const fakePlanBackend = (options: FakePlanOptions = {}): FakePlanBackend => {
  let models: string[] = [...(options.models ?? [SESSION.model])];
  const base = fakeBackend({
    ...options,
    get models() {
      return models;
    },
  });
  const listedModels = base.models;
  const listing = base.modelList;
  const sessionModel = base.model;
  const planCalls: PlanCall[] = [];
  const dismissals: string[] = [];
  const listenerPaths: string[] = [];
  const clipboard: string[] = [];
  let accounts: PlanAccountView[] = [...(options.accounts ?? [])];
  const members = (): string[] => [...(options.chain ?? models)];
  const called = (route: string, body?: unknown): void => {
    planCalls.push(body === undefined ? { route } : { route, body });
  };
  const withBilling = (entry: MomongaModelEntry): MomongaModelEntry => {
    const chain = entry.chain.map((member) => {
      const plan = options.planTargets?.[member.model];
      const group = options.keyGroups?.[member.model];
      return { ...member, billing: options.billing?.[member.model] ?? ('metered' as const), ...(plan === undefined ? {} : { plan }), ...(group === undefined ? {} : { key: { group } }) };
    });
    return { ...entry, billing: chain[0]?.billing ?? entry.billing, chain };
  };
  const plan: PlanGatewayClient = {
    accounts: async () => {
      called('accounts');
      return { profiles: [...(options.profiles ?? [CHATGPT])], accounts: [...accounts], ...(options.listProblems === undefined ? {} : { listProblems: [...options.listProblems] }) };
    },
    signInBegin: async (request) => {
      called('sign-in/begin', request);
      return { attemptId: 'attempt-1', authorizationUrl: AUTHORIZATION_URL, state: 'st-1', expiresAt: '2026-11-10T00:05:00.000Z' };
    },
    signInComplete: async (request) => {
      called('sign-in/complete', request);
      await options.completeHeld;
      const begun = planCalls.find((call) => call.route === 'sign-in/begin')?.body as { account: string } | undefined;
      if (options.completeFails !== undefined) throw options.completeFails;
      const signedIn: PlanSignInCompleteResponse = { outcome: 'signed_in', account: account({ label: begun?.account ?? 'chatgpt' }), firstSignIn: false };
      const answer: PlanSignInCompleteResponse = 'identityConfirmed' in request ? (options.confirmed ?? signedIn) : (options.complete ?? signedIn);
      if (answer.outcome !== 'retry' && answer.outcome !== 'identity_unconfirmed') accounts = [...accounts.filter((existing) => existing.label !== answer.account.label).map((existing) => ({ ...existing, active: false })), answer.account];
      return answer;
    },
    signInCancel: async (request) => {
      called('sign-in/cancel', request);
    },
    signOut: async (request) => {
      called('sign-out', request);
      accounts = accounts.map((existing) => (existing.label === request.account ? { ...existing, state: 'registered', active: false } : existing));
      return { revocation: options.signOutRevocation ?? 'confirmed', usageUrl: CHATGPT.usageUrl };
    },
    setActive: async (request) => {
      called('accounts/active', request);
      accounts = accounts.map((existing) => ({ ...existing, active: existing.label === request.account }));
      return { active: request };
    },
    resume: async (label, request) => {
      called(`accounts/${label}/resume`, request);
      const resumed = accounts.some((existing) => existing.label === label && existing.paused !== undefined);
      accounts = accounts.map((existing) => {
        if (existing.label !== label) return existing;
        const { paused: _paused, ...rest } = existing;
        return rest;
      });
      return options.resumeAnswer ?? { resumed };
    },
    resetHost: async () => {
      called('host/reset', {});
      return { hostId: 'host-reset-1' };
    },
    accountModels: async (label) => {
      called(`accounts/${label}/models`);
      const failure = options.catalogFailures?.[label];
      if (failure !== undefined) throw failure;
      return options.catalogs?.[label] ?? { readAt: '2026-11-10T00:00:00.000Z', models: [] };
    },
    addTarget: async (label, request) => {
      called(`accounts/${label}/targets`, request);
      const added = `${options.profiles?.[0]?.id ?? CHATGPT.id}/${request.slug}`;
      models = [...models, added];
      return { model: added };
    },
  };
  const listener = async (path: string): Promise<SignInListener> => {
    listenerPaths.push(path);
    if (options.listenerFails !== undefined) throw options.listenerFails;
    const redirectUrl = `http://127.0.0.1:${LISTENER_PORT}${path}`;
    return {
      port: LISTENER_PORT,
      redirectUrl,
      callback: async ({ state, signal }) => {
        if (options.callbackArrives !== false) return new URL(`${redirectUrl}?code=code-1&state=${state}`);
        return new Promise<URL>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      close: async () => undefined,
    };
  };
  const backend: FakePlanBackend = Object.assign(base, {
    plan,
    planCalls,
    dismissals,
    listenerPaths,
    clipboard,
    copyToClipboard: async (text: string) => {
      clipboard.push(text);
      return { kind: 'copied' as const, characters: [...text].length };
    },
    models: async () => (await listedModels()).map(withBilling),
    modelList: async () => {
      const listed = await listing();
      return { ...listed, data: listed.data.map(withBilling) };
    },
    model: async () => withBilling(await sessionModel()),
    health: async (): Promise<GatewayHealth> => ({
      ok: true,
      models: Object.fromEntries(members().map((member) => [member, options.health?.[member] ?? { ok: true, breaker: 'closed' as const }])),
      version: '0.0.0',
      apiVersion: 1,
      pid: 1,
      startedAt: '2026-11-10T00:00:00.000Z',
      state: 'running',
      activeRequests: 0,
    }),
    sandbox: async () => 'seatbelt' as const,
    startSignInListener: options.startListener ?? listener,
    signInTimers: options.signInTimers ?? createFakeTimers(createFakeClock(0)),
    dismissedNotices: async () => ({ ...(options.dismissed ?? {}) }),
    dismissNotice: async (key: string) => {
      dismissals.push(key);
    },
  });
  return backend;
};

export type PlanTiming = Pick<AppProps, 'now' | 'timers' | 'keySettleMs'>;

const AT_ONCE: PlanTiming = { now: Date.now, timers: settleAtOnce(systemTiming), keySettleMs: TEST_KEY_SETTLE_MS };

export const startPlan = async (options: FakePlanOptions = {}, extra: Pick<AppProps, 'initialPrompt' | 'initialSkill' | 'startup'> = {}, screen: Partial<FakeScreenSize> = {}, timing: PlanTiming = AT_ONCE) => {
  const backend = fakePlanBackend(options);
  const outcomes: TuiOutcome[] = [];
  const terminal = fakeScreenTerminal({ ...WIDE_TEST_SCREEN, ...screen });
  const app = renderObservable(<App backend={backend as TuiBackend} terminal={terminal} {...timing} initialMode={undefined} {...extra} onExit={(outcome) => void outcomes.push(outcome)} />);
  return { backend, app, outcomes, terminal };
};

const numberedRowOf = (frame: string, label: string): string | undefined => frame.split('\n').find((candidate) => /^[\s│]*\W?\s*\d+\. /.test(candidate) && candidate.includes(label));

export const rowNumberOf = (frame: string, label: string): number => {
  const line = numberedRowOf(frame, label);
  if (line === undefined) throw new Error(`no numbered row with ${label} in:\n${frame}`);
  return Number(/(\d+)\. /.exec(line)?.[1]);
};

export const untilRow = (app: Instance, label: string, also = ''): Promise<string> => untilFrame(app, (frame) => frame.includes(also) && numberedRowOf(frame, label) !== undefined);

export const choose = async (app: Instance, label: string): Promise<void> => {
  const frame = await untilRow(app, label);
  const row = rowNumberOf(frame, label);
  for (let step = 1; step < row; step += 1) app.stdin.write(KEYS.down);
  app.stdin.write(KEYS.enter);
};

export const submitLine = async (app: Instance, text: string): Promise<void> => {
  app.stdin.write(text);
  await untilFrame(app, text);
  app.stdin.write(KEYS.enter);
};

export const eventually = (holds: () => boolean, what: string): Promise<void> => pollUntil(holds, { description: what, boundMs: FRAME_BOUND_MS });

export const TYPED_AFTER = 'typed-after';

export const untilTypedAfter = async (app: Instance): Promise<string> => {
  app.stdin.write(TYPED_AFTER);
  return untilFrame(app, TYPED_AFTER);
};
