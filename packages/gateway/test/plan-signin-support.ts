import type { PlanProfile } from '@momonga/config';
import { FIRST_GENERATION, createJsonLogger, generationLayout, momongaLayout, momongaPaths, publishCurrentGeneration } from '@momonga/foundation';
import type { JsonLogger, ListableCredentialStore } from '@momonga/foundation';
import { PLAN_API_PREFIX, PLAN_ROUTES } from '@momonga/protocol';
import { createFakeClock, createFakeSecretStore, startFakePlanResponses, startFakeSiwcAuth, testKernelLock } from '@momonga/testkit';
import type { FakeClock, FakePlanResponses, FakeSecretStore, PlanResponsesOptions, SiwcAccessTokenForm, SiwcAuth } from '@momonga/testkit';
import { getJson, postJson, readJson, registerCleanup } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings, modelsOf } from './gateway-process-helpers.ts';
import type { GatewayTimers } from '../src/types.ts';
import { PROFILE_ID, profileFor } from './plan-support.ts';

export const CALLBACK_PORT = 49152;
export const ACCOUNT = 'work';

export type PlanGateway = {
  home: string;
  auth: SiwcAuth;
  upstream: FakePlanResponses;
  profile: PlanProfile;
  secretStore: FakeSecretStore;
  socketPath: string;
  post(route: string, body: unknown): Promise<{ status: number; headers: Record<string, string>; body: any }>;
  get(route: string): Promise<{ status: number; body: any }>;
  restart(): Promise<void>;
  close(): Promise<void>;
};

export type RecordedEvent = { name: string; data: Record<string, unknown> };

export const PLAN_EVENT_NAMES = ['plan.sign_in', 'plan.refresh', 'plan.rejected', 'plan.sign_out', 'plan.pause', 'plan.catalog'] as const;

const ENVELOPE = new Set(['ts', 'level', 'service', 'pid', 'msg']);

export const recordingLogger = (events: RecordedEvent[]): JsonLogger => {
  let pending = '';
  const stream = {
    write: (chunk: string): boolean => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') continue;
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const name = parsed['msg'];
        if (typeof name !== 'string' || !(PLAN_EVENT_NAMES as readonly string[]).includes(name)) continue;
        events.push({ name, data: Object.fromEntries(Object.entries(parsed).filter(([key]) => !ENVELOPE.has(key))) });
      }
      return true;
    },
  };
  return createJsonLogger({ service: 'gateway', clock: createFakeClock(0), stream });
};

export const accountRoute = (route: string, account: string = ACCOUNT): string => route.replace(':account', encodeURIComponent(account));

export type PlanGatewayOptions = {
  models?: readonly unknown[];
  declaredCapabilities?: boolean;
  clock?: FakeClock;
  accessTokenForm?: SiwcAccessTokenForm;
  plaintextTokenFiles?: boolean;
  logger?: JsonLogger;
  verifyBearer?: PlanResponsesOptions['verifyBearer'];
  respond?: PlanResponsesOptions['respond'];
  catalogListKey?: string;
  catalogReply?: PlanResponsesOptions['catalogReply'];
  planStore?: (store: ListableCredentialStore) => ListableCredentialStore;
  pinned?: boolean;
  timers?: GatewayTimers;
};

export const holdNextExchange = (gateway: PlanGateway): { reached: Promise<void>; release(): void } => {
  let reach = (): void => undefined;
  let release = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  gateway.auth.scriptToken('authorization_code', [{ kind: 'hold', reached: reach, released }]);
  return { reached, release };
};

export const startPlanGateway = async (options: PlanGatewayOptions = {}): Promise<PlanGateway> => {
  const home = makeHome();
  const upstream = await startFakePlanResponses({
    verifyBearer: options.verifyBearer ?? (() => 'valid'),
    models: options.models ?? [],
    ...(options.respond === undefined ? {} : { respond: options.respond }),
    ...(options.catalogReply === undefined ? {} : { catalogReply: options.catalogReply }),
  });
  registerCleanup(() => upstream.close());
  const loopback = `${upstream.origin}/v1`;
  const auth = await startFakeSiwcAuth({ resource: loopback, ...(options.accessTokenForm === undefined ? {} : { accessTokenForm: options.accessTokenForm }) });
  registerCleanup(() => auth.close());
  const shipped = profileFor(auth);
  const profile: PlanProfile = {
    ...shipped,
    oauth: { ...shipped.oauth, resource: loopback },
    targetDefaults: { ...shipped.targetDefaults, baseUrl: loopback },
    ...(options.catalogListKey === undefined ? {} : { catalog: { ...shipped.catalog, listKey: options.catalogListKey } }),
  };
  const secretStore = createFakeSecretStore({});
  writeSettings(home, {
    ...(options.plaintextTokenFiles === true ? { credentials: { plaintextTokenFiles: true } } : {}),
    models: modelsOf({
        gpt: {
          adapter: 'open-responses',
          model: 'plan-model',
          ...(options.declaredCapabilities === false ? {} : { capabilities: { contextWindow: 128000, maxOutputTokens: 16000 } }),
          plan: options.pinned === false ? { profile: PROFILE_ID } : { profile: PROFILE_ID, account: ACCOUNT },
        },
      }),
  });
  const launchOnly = () => launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, secretStore, planProfiles: { [PROFILE_ID]: profile }, ...(options.clock === undefined ? {} : { clock: options.clock }), ...(options.logger === undefined ? {} : { logger: options.logger }), ...(options.planStore === undefined ? {} : { planStore: options.planStore }), ...(options.timers === undefined ? {} : { timers: options.timers }) });
  const launch = async () => {
    const launched = await launchOnly();
    await publishCurrentGeneration(momongaPaths(home, process.platform, {}), {
      generation: FIRST_GENERATION,
      version: PROCESS_VERSION,
      sockets: { ...generationLayout(home, FIRST_GENERATION).sockets, gateway: launched.socketPath },
    }, { lock: testKernelLock() });
    return launched;
  };
  let handle = await launch();
  const gateway: PlanGateway = {
    home,
    auth,
    upstream,
    profile,
    secretStore,
    socketPath: handle.socketPath,
    post: async (route, body) => readJson(await postJson(clientFor(handle.socketPath), `${PLAN_API_PREFIX}${route}`, body)),
    get: (route) => getJson(clientFor(handle.socketPath), `${PLAN_API_PREFIX}${route}`),
    restart: async () => {
      await handle.close();
      handle = await launch();
      gateway.socketPath = handle.socketPath;
    },
    close: async () => {
      await handle.close();
    },
  };
  return gateway;
};

export const begin = (gateway: PlanGateway, extra: Record<string, unknown> = {}) =>
  gateway.post(PLAN_ROUTES.signInBegin, { profile: PROFILE_ID, account: ACCOUNT, port: CALLBACK_PORT, ...extra });

export const browse = async (authorizationUrl: string): Promise<URL> => {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (location === null) throw new Error(`the fake authorization server answered ${response.status} with no redirect`);
  return new URL(location);
};

export const completeConfirmed = async (gateway: PlanGateway, attemptId: string, callbackUrl: string) => {
  const exchanged = await gateway.post(PLAN_ROUTES.signInComplete, { attemptId, callbackUrl });
  return exchanged.body?.outcome === 'identity_unconfirmed' ? gateway.post(PLAN_ROUTES.signInComplete, { attemptId, identityConfirmed: true }) : exchanged;
};

export const signIn = async (gateway: PlanGateway) => {
  const begun = await begin(gateway);
  if (begun.status !== 200) throw new Error(`begin answered ${begun.status}: ${JSON.stringify(begun.body)}`);
  const callback = await browse(begun.body.authorizationUrl);
  const completed = await completeConfirmed(gateway, begun.body.attemptId, callback.toString());
  return { begun, callback, completed };
};

export const sessionsDirectory = (home: string): string => momongaLayout(home, process.platform, process.env).planSessions;
