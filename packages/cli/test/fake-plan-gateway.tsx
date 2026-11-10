import { PLAN_PROFILES } from '@momonga/config';
import type {
  DetectedLocalServer,
  GatewayHealth,
  MomongaModelEntry,
  PlanAccountView,
  PlanModelsResponse,
  PlanProfileView,
  PlanSignInCompleteResponse,
  TargetBilling,
  TargetHealth,
} from '@momonga/protocol';
import type { ModelConnection } from '@momonga/config';
import { App } from '../src/tui/app.tsx';
import type { AppProps, TuiOutcome } from '../src/tui/app.tsx';
import type { PlanGatewayClient } from '../src/client/gateway-client.ts';
import type { SignInListener, TuiBackend } from '../src/tui/backend.ts';
import type { SignInWaitTimers, StartSignInListener } from '../src/plan/sign-in.ts';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { fakeBackend } from './fake-backend.ts';
import type { FakeBackend, FakeBackendOptions } from './fake-backend.ts';
import { FRAME_BOUND_MS, KEYS, renderObservable, untilFrame } from './ink-helpers.ts';
import type { Instance } from './ink-helpers.ts';
import { fakeScreenTerminal } from './tui/screen-fakes.ts';
import { systemTiming } from '@momonga/foundation';

const shipped = PLAN_PROFILES['chatgpt'];
if (shipped === undefined) throw new Error('the chatgpt profile is not shipped');

export const CHATGPT: PlanProfileView = { id: shipped.id, usageUrl: shipped.usageUrl, messages: shipped.messages, loginLabel: shipped.loginLabel };

export type DetectedServer = Omit<DetectedLocalServer, 'models'> & { models: readonly (DetectedLocalServer['models'][number] & { trainedContext?: number; contextWindow?: number })[] };

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

export type PlanCall = { route: string; body?: unknown };

export type FakePlanOptions = FakeBackendOptions & {
  accounts?: readonly PlanAccountView[];
  profiles?: readonly PlanProfileView[];
  catalogs?: Readonly<Record<string, PlanModelsResponse>>;
  complete?: PlanSignInCompleteResponse;
  health?: Readonly<Record<string, TargetHealth>>;
  billing?: Readonly<Record<string, TargetBilling>>;
  planTargets?: Readonly<Record<string, { profile: string; account?: string }>>;
  detected?: readonly DetectedServer[];
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
  readonly connections: ModelConnection[];
  readonly dismissals: string[];
  readonly listenerPaths: string[];
  readonly detections: (readonly string[])[];
  readonly clipboard: string[];
};

export const fakePlanBackend = (options: FakePlanOptions = {}): FakePlanBackend => {
  const base = fakeBackend(options);
  const planCalls: PlanCall[] = [];
  const connections: ModelConnection[] = [];
  const dismissals: string[] = [];
  const listenerPaths: string[] = [];
  const detections: (readonly string[])[] = [];
  const clipboard: string[] = [];
  let aliases: string[] = [...(options.aliases ?? ['default'])];
  let accounts: PlanAccountView[] = [...(options.accounts ?? [])];
  const targets = [...(options.targets ?? ['primary'])];
  const called = (route: string, body?: unknown): void => {
    planCalls.push(body === undefined ? { route } : { route, body });
  };
  const withBilling = (entry: MomongaModelEntry): MomongaModelEntry =>
    ({
      ...entry,
      targetBilling: Object.fromEntries(entry.targets.map((target) => [target, options.billing?.[target] ?? 'metered'])),
      targetPlan: Object.fromEntries(entry.targets.flatMap((target) => (options.planTargets?.[target] === undefined ? [] : [[target, options.planTargets[target]]]))),
    }) as MomongaModelEntry;
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
      const answer: PlanSignInCompleteResponse = options.complete ?? { outcome: 'signed_in', account: account({ label: begun?.account ?? 'chatgpt' }), firstSignIn: false };
      if (answer.outcome !== 'retry') accounts = [...accounts.filter((existing) => existing.label !== answer.account.label).map((existing) => ({ ...existing, active: false })), answer.account];
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
      return options.catalogs?.[label] ?? { readAt: '2026-11-10T00:00:00.000Z', models: [] };
    },
    addTarget: async (label, request) => {
      called(`accounts/${label}/targets`, request);
      aliases = [...aliases, request.slug];
      return { target: request.slug, alias: request.slug };
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
    connections,
    dismissals,
    listenerPaths,
    detections,
    clipboard,
    copyToClipboard: async (text: string) => {
      clipboard.push(text);
      return { kind: 'copied' as const, characters: [...text].length };
    },
    models: async () => (await fakeBackend({ ...options, aliases }).models()).map(withBilling),
    model: async () => withBilling(await fakeBackend(options).model()),
    health: async (): Promise<GatewayHealth> => ({
      ok: true,
      targets: Object.fromEntries(targets.map((target) => [target, options.health?.[target] ?? { ok: true, breaker: 'closed' }])),
      version: '0.0.0',
      apiVersion: 1,
      pid: 1,
      startedAt: '2026-11-10T00:00:00.000Z',
      state: 'running',
    }),
    sandbox: async () => 'seatbelt' as const,
    startSignInListener: options.startListener ?? listener,
    signInTimers: options.signInTimers ?? createFakeTimers(createFakeClock(0)),
    detectLocalServers: async (typed: readonly string[]) => {
      detections.push(typed);
      return [...(options.detected ?? [])];
    },
    addModelConnection: async (connection: ModelConnection) => {
      connections.push(connection);
      const name = connection.kind === 'managed' ? connection.server : connection.model;
      aliases = [...aliases, name];
      return { target: name, alias: name };
    },
    dismissedNotices: async () => ({ ...(options.dismissed ?? {}) }),
    dismissNotice: async (key: string) => {
      dismissals.push(key);
    },
  });
  return backend;
};

export const startPlan = async (options: FakePlanOptions = {}, extra: Pick<AppProps, 'initialPrompt' | 'initialSkill' | 'startup'> = {}, screen: Parameters<typeof fakeScreenTerminal>[0] = {}) => {
  const backend = fakePlanBackend(options);
  const outcomes: TuiOutcome[] = [];
  const app = renderObservable(<App backend={backend as TuiBackend} terminal={fakeScreenTerminal(screen)} now={Date.now} timers={systemTiming} initialMode={undefined} {...extra} onExit={(outcome) => void outcomes.push(outcome)} />);
  return { backend, app, outcomes };
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

export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const eventually = async (holds: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + FRAME_BOUND_MS;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${FRAME_BOUND_MS} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

export const quiet = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) await settle();
};
