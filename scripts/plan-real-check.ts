import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editModelsSettings, loadUserModels } from '@momonga/config';
import type { ModelsOperation, ModelsOperations } from '@momonga/config';
import { CONTEXT_REPORT_FORMAT } from '@momonga/eval';
import { NoCurrentGenerationError, createUdsClient, currentSocketResolver, fixedSocket, isRecord, momongaLayout, resolveLayoutLocks } from '@momonga/foundation';
import type { MomongaPaths, UdsClient } from '@momonga/foundation';
import { SIGNED_IN_OUTCOME, WORKSPACE_USAGE_LIMIT_CODE, resolveTypedModelRef, typedModelText } from '@momonga/protocol';

const REPORT_FORMAT = 'momonga-plan-real-check/1';

const EXIT_RECORDED = 0;
const EXIT_INCOMPLETE = 1;
const EXIT_USAGE = 2;
const EXIT_LEAK = 3;

const USAGE =
  'usage: plan-real-check collect --home <dir> --report <file> [--status-file <file>] [--eval-reports <a>,<b>] [--screens-seen] [--allow-long <step>.<field>] | carriage --home <dir> --model <model> --report <file> | request-size --home <dir> --model <model> --report <file>';

const OWN_HOME_REFUSAL = 'plan-real-check: --home is your own home directory. Use the temporary HOME in which you signed in; this script never touches ~/.momonga.';

const OPTIONAL_STEPS: ReadonlySet<string> = new Set(['R9', 'R10']);

const REQUEST_SIZE_BYTES = 1024 * 1024 + 1;

type Verdict = 'recorded' | 'not_run' | 'failed';

type Fact = string | number | boolean | null | readonly Fact[] | { readonly [key: string]: Fact };

type Facts = { readonly [key: string]: Fact };

type Step = { step: string; verdict: Verdict; facts: Facts };

type Report = { format: string; generatedAt: string; account: string | null; steps: Step[] };

type Event = Readonly<Record<string, unknown>>;

type Command = 'collect' | 'carriage' | 'request-size';

type Arguments = {
  command: Command;
  home: string;
  report: string;
  model?: string;
  statusFile?: string;
  evalReports?: readonly [string, string];
  screensSeen: boolean;
  allowLong: ReadonlyMap<string, ReadonlySet<string>>;
};

class UsageError extends Error {}

class Refusal extends Error {}

const causeText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const VALUE_FLAGS: Readonly<Record<Command, readonly string[]>> = {
  collect: ['--home', '--report', '--status-file', '--eval-reports', '--allow-long'],
  carriage: ['--home', '--model', '--report', '--allow-long'],
  'request-size': ['--home', '--model', '--report', '--allow-long'],
};

const REQUIRED_FLAGS: Readonly<Record<Command, readonly string[]>> = {
  collect: ['--home', '--report'],
  carriage: ['--home', '--model', '--report'],
  'request-size': ['--home', '--model', '--report'],
};

const isCommand = (value: string | undefined): value is Command => value === 'collect' || value === 'carriage' || value === 'request-size';

const isDirectory = (candidate: string): boolean => fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true;

const parseArguments = (argv: readonly string[]): Arguments => {
  const [command, ...rest] = argv;
  if (!isCommand(command)) throw new UsageError();
  const values = new Map<string, string>();
  const allowLong = new Map<string, Set<string>>();
  let screensSeen = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--screens-seen' && command === 'collect') {
      screensSeen = true;
      continue;
    }
    const value = rest[index + 1];
    if (flag === undefined || !VALUE_FLAGS[command].includes(flag) || value === undefined) throw new UsageError();
    index += 1;
    if (flag !== '--allow-long') {
      values.set(flag, value);
      continue;
    }
    const [step, field, ...more] = value.split('.');
    if (step === undefined || step === '' || field === undefined || field === '' || more.length > 0) throw new UsageError();
    allowLong.set(step, new Set([...(allowLong.get(step) ?? []), field]));
  }
  if (!REQUIRED_FLAGS[command].every((flag) => values.has(flag))) throw new UsageError();
  const home = values.get('--home') ?? '';
  const report = values.get('--report') ?? '';
  if (!isDirectory(home)) throw new Refusal(`the home directory ${home} does not exist`);
  const reportDirectory = path.dirname(path.resolve(report));
  if (!isDirectory(reportDirectory)) throw new Refusal(`the report directory ${reportDirectory} does not exist`);
  const listed = values.get('--eval-reports')?.split(',');
  if (listed !== undefined && (listed.length !== 2 || listed.includes(''))) throw new UsageError();
  const [first, second] = listed ?? [];
  const model = values.get('--model');
  const statusFile = values.get('--status-file');
  return {
    command,
    home,
    report,
    screensSeen,
    allowLong,
    ...(model === undefined ? {} : { model }),
    ...(statusFile === undefined ? {} : { statusFile }),
    ...(first === undefined || second === undefined ? {} : { evalReports: [first, second] as const }),
  };
};

const MISSING_PATH_CODES: readonly string[] = ['ENOENT', 'ENOTDIR'];

const isMissingPath = (error: unknown): boolean => error instanceof Error && 'code' in error && typeof error.code === 'string' && MISSING_PATH_CODES.includes(error.code);

const realOwnHome = (): string | undefined => {
  try {
    return fs.realpathSync(path.resolve(os.homedir()));
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
};

const isOwnHome = (home: string): boolean => {
  const own = realOwnHome();
  return own !== undefined && fs.realpathSync(path.resolve(home)) === own;
};

const text = (event: Event, key: string): string | null => {
  const value = event[key];
  return typeof value === 'string' ? value : null;
};

const count = (event: Event, key: string): number | null => {
  const value = event[key];
  return typeof value === 'number' ? value : null;
};

const names = (event: Event, key: string): string[] | null => {
  const value = event[key];
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string') ? value : null;
};

const eventOfLine = (line: string): Event[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
  return isRecord(parsed) && typeof parsed['msg'] === 'string' && parsed['msg'].startsWith('plan.') ? [parsed] : [];
};

const readEvents = (paths: MomongaPaths): Event[] => {
  const file = paths.logFiles.gateway;
  if (!fs.existsSync(file)) return [];
  let log: string;
  try {
    log = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Refusal(`the gateway log ${file} cannot be read: ${causeText(error)}`);
  }
  return log.split('\n').flatMap(eventOfLine);
};

const named = (events: readonly Event[], name: string): Event[] => events.filter((event) => event['msg'] === name);

const signedIn = (events: readonly Event[]): Event[] => named(events, 'plan.sign_in').filter((event) => event['outcome'] === SIGNED_IN_OUTCOME);

const accountOf = (events: readonly Event[]): string | null => {
  const [first] = signedIn(events);
  return first === undefined ? null : text(first, 'account');
};

const notRun = (step: string, reason: string): Step => ({ step, verdict: 'not_run', facts: { reason } });

const signInFacts = (event: Event): Facts => ({
  account: text(event, 'account'),
  port: count(event, 'port'),
  alg: text(event, 'alg'),
  kid: text(event, 'kid'),
  audShape: text(event, 'audShape'),
  scope: text(event, 'scope'),
  earliestRefreshAt: text(event, 'earliestRefreshAt'),
});

const stepR1 = (events: readonly Event[]): Step => {
  const [command, tui] = signedIn(events);
  if (command === undefined || tui === undefined) return notRun('R1', 'fewer than two signed-in plan.sign_in events in the gateway log');
  const listing = named(events, 'plan.catalog').find((event) => names(event, 'requestIdHeaders') !== null);
  return {
    step: 'R1',
    verdict: 'recorded',
    facts: { signIns: { command: signInFacts(command), tui: signInFacts(tui) }, requestIdHeaders: listing === undefined ? null : names(listing, 'requestIdHeaders') },
  };
};

const stepR3 = (events: readonly Event[]): Step => {
  const adopted = named(events, 'plan.refresh').find((event) => event['outcome'] === 'adopted');
  if (adopted === undefined) return notRun('R3', 'no adopted plan.refresh event in the gateway log');
  return { step: 'R3', verdict: 'recorded', facts: { remainingMs: count(adopted, 'remainingMs'), earliestRefreshAt: text(adopted, 'earliestRefreshAt'), at: text(adopted, 'at') } };
};

const stepR5 = (events: readonly Event[]): Step => {
  const read = named(events, 'plan.catalog').find((event) => event['outcome'] === 'ok');
  if (read === undefined) return notRun('R5', 'no plan.catalog event with outcome ok in the gateway log');
  const entryKeys = names(read, 'entryKeys');
  return {
    step: 'R5',
    verdict: 'recorded',
    facts: { listed: count(read, 'listed'), usable: count(read, 'usable'), entryKeys, contextWindowListed: entryKeys?.includes('context_window') === true },
  };
};

const SIGN_OUT_CLEARED = 'cleared';

const SIGN_OUT_REASONS: Readonly<Record<string, Readonly<Record<string, (code: string | null) => string>>>> = {
  cleared: {
    confirmed: () => 'signed out; the refresh token was revoked',
    unconfirmed: () => 'signed out; the revocation was not confirmed',
  },
  interrupted: {
    none: () => 'the sign-out was interrupted before a revocation outcome',
  },
  failed: {
    confirmed: (code) => `the refresh token was revoked, but the record could not be cleared (${code})`,
    unconfirmed: (code) => `the revocation was not confirmed and the record could not be cleared (${code})`,
    none: (code) => `the sign-out failed before a revocation was sent (${code})`,
  },
};

const signOutReason = (end: string, revocation: string | null, code: string | null): string => {
  const cells = Object.hasOwn(SIGN_OUT_REASONS, end) ? SIGN_OUT_REASONS[end] : undefined;
  const reason = cells !== undefined && revocation !== null && Object.hasOwn(cells, revocation) ? cells[revocation] : undefined;
  return reason === undefined ? `the gateway log gives a sign-out end (${end}) and a revocation (${revocation}) that this script does not know` : reason(code);
};

const stepR7 = (events: readonly Event[]): Step => {
  const signOut = named(events, 'plan.sign_out').at(-1);
  if (signOut === undefined) return notRun('R7', 'no plan.sign_out event in the gateway log');
  const revocation = text(signOut, 'revocation');
  const end = text(signOut, 'end') ?? SIGN_OUT_CLEARED;
  const code = text(signOut, 'code');
  const facts = { revocation, end, reason: signOutReason(end, revocation, code), ...(code === null ? {} : { code }) };
  return { step: 'R7', verdict: end === SIGN_OUT_CLEARED && revocation === 'confirmed' ? 'recorded' : 'failed', facts };
};

type Rejection = { rejected: Event; terminal: Event };

const isTerminalRefresh = (event: Event, interrupted: boolean): boolean => event['msg'] === 'plan.refresh' && event['outcome'] === 'terminal' && event['interrupted'] === interrupted;

const rejectionOf = (events: readonly Event[]): Rejection | undefined => {
  for (const [index, rejected] of events.entries()) {
    if (rejected['msg'] !== 'plan.rejected') continue;
    const terminal = events.find((event, later) => later > index && isTerminalRefresh(event, false));
    if (terminal !== undefined) return { rejected, terminal };
  }
  return undefined;
};

const statusAccounts = (file: string): readonly Event[] | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError || (isRecord(error) && typeof error['code'] === 'string')) return undefined;
    throw error;
  }
  const accounts = isRecord(parsed) ? parsed['accounts'] : undefined;
  return Array.isArray(accounts) && accounts.every(isRecord) ? accounts : undefined;
};

const stepR8 = (rejection: Rejection | undefined, statusFile: string | undefined): Step => {
  if (rejection === undefined) return notRun('R8', 'no plan.rejected followed by a terminal plan.refresh in the gateway log');
  if (statusFile === undefined) return notRun('R8', 'no --status-file given');
  const found = { rejectedAnswer: text(rejection.rejected, 'answer'), terminalCode: text(rejection.terminal, 'code') };
  const accounts = statusAccounts(statusFile);
  if (accounts === undefined) return { step: 'R8', verdict: 'failed', facts: { ...found, reason: 'the status file is not momonga auth status --json output' } };
  const account = text(rejection.rejected, 'account');
  const statusShowsSignInRequired = accounts.some((entry) => entry['label'] === account && entry['state'] === 'needs_sign_in');
  if (statusShowsSignInRequired) return { step: 'R8', verdict: 'recorded', facts: { ...found, statusShowsSignInRequired } };
  return { step: 'R8', verdict: 'failed', facts: { ...found, statusShowsSignInRequired, reason: 'the status file does not show the account as sign-in required' } };
};

const stepR9 = (events: readonly Event[]): Step => {
  const found = events.find((event) => isTerminalRefresh(event, true));
  if (found === undefined) return notRun('R9', 'no plan.refresh event with outcome terminal and interrupted true in the gateway log');
  return { step: 'R9', verdict: 'recorded', facts: { code: text(found, 'code') } };
};

const stepR10 = (events: readonly Event[]): Step => {
  const pause = named(events, 'plan.pause').find((event) => event['code'] === WORKSPACE_USAGE_LIMIT_CODE);
  if (pause === undefined) return notRun('R10', `no plan.pause event with code ${WORKSPACE_USAGE_LIMIT_CODE} in the gateway log`);
  return { step: 'R10', verdict: 'recorded', facts: { code: text(pause, 'code'), until: text(pause, 'until') } };
};

const stepR11 = (events: readonly Event[], screensSeen: boolean): Step => {
  if (!screensSeen) return notRun('R11', '--screens-seen was not given');
  const withClaims = signedIn(events).find((event) => names(event, 'claimNames') !== null);
  if (withClaims === undefined) return notRun('R11', 'no signed-in plan.sign_in event with claimNames in the gateway log');
  return { step: 'R11', verdict: 'recorded', facts: { claimNames: names(withClaims, 'claimNames'), screensSeen: true } };
};

const sumOf = (values: readonly unknown[]): number | null => (values.every((value): value is number => typeof value === 'number') ? values.reduce((sum, value) => sum + value, 0) : null);

const evalFacts = (file: string): Facts | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError || (isRecord(error) && typeof error['code'] === 'string')) return undefined;
    throw error;
  }
  if (!isRecord(parsed) || parsed['format'] !== CONTEXT_REPORT_FORMAT || typeof parsed['dataset'] !== 'string') return undefined;
  const cases = parsed['cases'];
  if (!Array.isArray(cases) || !cases.every(isRecord)) return undefined;
  return {
    dataset: parsed['dataset'],
    passedRuns: sumOf(cases.map((entry) => entry['passedRuns'])),
    runs: sumOf(cases.map((entry) => entry['runs'])),
    inputTokens: sumOf(cases.map((entry) => (isRecord(entry['tokens']) ? entry['tokens']['inputTokens'] : undefined))),
  };
};

const stepR12 = (evalReports: readonly [string, string] | undefined): Step => {
  if (evalReports === undefined) return notRun('R12', 'no --eval-reports given');
  const reports = evalReports.map(evalFacts);
  const [first, second] = reports;
  if (first === undefined || second === undefined) return { step: 'R12', verdict: 'failed', facts: { reason: `an eval report could not be read as ${CONTEXT_REPORT_FORMAT}` } };
  return { step: 'R12', verdict: 'recorded', facts: { reports: [first, second] } };
};

const collect = (events: readonly Event[], args: Arguments): Step[] => {
  const rejection = rejectionOf(events);
  return [
    stepR1(events),
    stepR3(events),
    stepR5(events),
    stepR7(events),
    stepR8(rejection, args.statusFile),
    stepR9(events),
    stepR10(events),
    stepR11(events, args.screensSeen),
    stepR12(args.evalReports),
  ];
};

type Answer = { status: number; body: unknown };

type Sent = Answer | undefined;

const send = async (client: UdsClient, body: unknown): Promise<Sent> => {
  try {
    const response = await client.request({ method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const answered = await response.text();
    try {
      return { status: response.status, body: JSON.parse(answered) };
    } catch (error) {
      if (error instanceof SyntaxError) return { status: response.status, body: null };
      throw error;
    }
  } catch (error) {
    if (isRecord(error) && typeof error['code'] === 'string') return undefined;
    throw error;
  }
};

const userInput = (content: string): unknown => [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: content }] }];

const errorFacts = (answer: Answer): { code: string | null; param: string | null } => {
  const error = isRecord(answer.body) && isRecord(answer.body['error']) ? answer.body['error'] : {};
  return { code: typeof error['code'] === 'string' ? error['code'] : null, param: typeof error['param'] === 'string' ? error['param'] : null };
};

const cachedTokensOf = (answer: Answer): number | null => {
  const usage = isRecord(answer.body) && isRecord(answer.body['usage']) ? answer.body['usage'] : {};
  const details = isRecord(usage['input_tokens_details']) ? usage['input_tokens_details'] : {};
  return typeof details['cached_tokens'] === 'number' ? details['cached_tokens'] : null;
};

const functionCalled = (answer: Answer): boolean => {
  const output = isRecord(answer.body) ? answer.body['output'] : undefined;
  return Array.isArray(output) && output.some((item) => isRecord(item) && item['type'] === 'function_call');
};

const NOT_SENT = 'the request could not be sent';

const FUNCTION_TOOL = {
  type: 'function',
  name: 'record_observation',
  description: 'Records one observation.',
  parameters: { type: 'object', properties: { observation: { type: 'string' } }, required: ['observation'], additionalProperties: false },
};

type Variant = { name: string; promptCache?: unknown; reasoning?: unknown; requests: number };

const PROMPT_CACHE = { kind: 'key' };
const REASONING = { control: 'reasoning_effort', lowest: 'low' };

const R4_VARIANTS: readonly Variant[] = [
  { name: 'cache', promptCache: PROMPT_CACHE, requests: 2 },
  { name: 'reasoning', reasoning: REASONING, requests: 1 },
  { name: 'both', promptCache: PROMPT_CACHE, reasoning: REASONING, requests: 1 },
];

type DeclaredCapabilities = Readonly<Record<string, unknown>> | undefined;

type PlanModel = { canon: string; declared: DeclaredCapabilities };

const readSettings = (paths: MomongaPaths): Record<string, unknown> => {
  if (!fs.existsSync(paths.settingsFile)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Refusal(`the settings file ${paths.settingsFile} is not valid JSON`);
    throw error;
  }
  if (!isRecord(parsed)) throw new Error(`${paths.settingsFile}: settings must be a JSON object`);
  return parsed;
};

const writtenEntries = (paths: MomongaPaths, connection: number): readonly unknown[] => {
  const models = readSettings(paths)['models'];
  const connections = isRecord(models) && Array.isArray(models['connections']) ? (models['connections'] as readonly unknown[]) : [];
  const written = connections[connection];
  return isRecord(written) && Array.isArray(written['models']) ? (written['models'] as readonly unknown[]) : [];
};

const planModelOf = async (paths: MomongaPaths, typed: string, signal: AbortSignal): Promise<PlanModel | undefined> => {
  const { resolved } = await loadUserModels({ home: paths.home, signal });
  const resolution = resolveTypedModelRef(typedModelText(typed), resolved.views);
  if (resolution.kind !== 'found') return undefined;
  const { canon, provider } = resolution.model;
  const target = resolved.models.get(canon);
  if (target === undefined || !('plan' in target) || target.plan === undefined) return undefined;
  const connection = resolved.connections.findIndex((candidate) => candidate.provider === provider);
  const position = [...resolved.models.values()].filter((model) => model.provider === provider).findIndex((model) => model.canon === canon);
  const entry = writtenEntries(paths, connection)[position];
  if (!isRecord(entry)) throw new Error(`${paths.settingsFile}: the model entry of ${canon} was not found`);
  const capabilities = entry['capabilities'];
  return { canon, declared: isRecord(capabilities) ? structuredClone(capabilities) : undefined };
};

const notOnePlanModel = (typed: string): string => `${typed} is not one plan model of this home`;

const capabilityOf = (model: PlanModel, field: 'promptCache' | 'reasoning', value: unknown): ModelsOperation => ({
  kind: 'setModelField',
  model: model.canon,
  path: ['capabilities', field],
  value: value ?? model.declared?.[field],
});

const changeSettings = async (paths: MomongaPaths, operations: ModelsOperations, signal: AbortSignal): Promise<void> => {
  const lock = resolveLayoutLocks(paths).mechanism;
  try {
    await editModelsSettings(paths.home, paths.settingsFile, operations, { lock, signal });
  } catch (error) {
    throw new Refusal(`the settings file ${paths.settingsFile} could not be changed: ${causeText(error)}`);
  }
};

const declareVariant = (paths: MomongaPaths, model: PlanModel, variant: Variant, signal: AbortSignal): Promise<void> =>
  changeSettings(paths, [capabilityOf(model, 'promptCache', variant.promptCache), capabilityOf(model, 'reasoning', variant.reasoning)], signal);

const restoreDeclared = (paths: MomongaPaths, model: PlanModel, signal: AbortSignal): Promise<void> =>
  changeSettings(paths, [{ kind: 'setModelField', model: model.canon, path: ['capabilities'], value: model.declared }], signal);

const variantRequests = async (client: UdsClient, paths: MomongaPaths, model: PlanModel, signal: AbortSignal): Promise<Step> => {
  const requests: Facts[] = [];
  try {
    for (const variant of R4_VARIANTS) {
      await declareVariant(paths, model, variant, signal);
      for (let request = 1; request <= variant.requests; request += 1) {
        const answer = await send(client, { model: model.canon, input: userInput('Answer with the single word ready.'), stream: false });
        if (answer === undefined) return { step: 'R4', verdict: 'failed', facts: { requests, reason: NOT_SENT } };
        requests.push({ variant: variant.name, request, status: answer.status, ...errorFacts(answer), cachedTokens: cachedTokensOf(answer) });
      }
    }
    return { step: 'R4', verdict: 'recorded', facts: { requests } };
  } finally {
    await restoreDeclared(paths, model, signal);
  }
};

const carriage = async (client: UdsClient, paths: MomongaPaths, model: PlanModel, signal: AbortSignal): Promise<Step[]> => {
  const tooled = await send(client, { model: model.canon, input: userInput('Record the observation "the carriage works" with the function.'), tools: [FUNCTION_TOOL], stream: false });
  const r2: Step =
    tooled === undefined
      ? { step: 'R2', verdict: 'failed', facts: { reason: NOT_SENT } }
      : { step: 'R2', verdict: 'recorded', facts: { status: tooled.status, ...errorFacts(tooled), functionCalled: functionCalled(tooled) } };
  return [r2, await variantRequests(client, paths, model, signal)];
};

const requestSize = async (client: UdsClient, model: PlanModel): Promise<Step[]> => {
  const answer = await send(client, { model: model.canon, input: userInput('a'.repeat(REQUEST_SIZE_BYTES)), stream: false });
  if (answer === undefined) return [{ step: 'R6', verdict: 'failed', facts: { bytes: REQUEST_SIZE_BYTES, reason: NOT_SENT } }];
  return [{ step: 'R6', verdict: 'recorded', facts: { bytes: REQUEST_SIZE_BYTES, accepted: answer.status < 400, status: answer.status, ...errorFacts(answer) } }];
};

const STEPS_OF: Readonly<Record<Exclude<Command, 'collect'>, readonly string[]>> = { carriage: ['R2', 'R4'], 'request-size': ['R6'] };

const gatewaySocket = async (paths: MomongaPaths): Promise<string | undefined> => {
  try {
    return await currentSocketResolver(paths, 'gateway')();
  } catch (error) {
    if (error instanceof NoCurrentGenerationError) return undefined;
    throw error;
  }
};

const throughGateway = async (command: Exclude<Command, 'collect'>, paths: MomongaPaths, typed: string): Promise<Step[]> => {
  const steps = STEPS_OF[command];
  readSettings(paths);
  const socketPath = await gatewaySocket(paths);
  if (socketPath === undefined) return steps.map((step) => notRun(step, 'no running gateway for this home'));
  const interrupt = new AbortController();
  const model = await planModelOf(paths, typed, interrupt.signal);
  if (model === undefined) return steps.map((step) => notRun(step, notOnePlanModel(typed)));
  const client = createUdsClient(fixedSocket(socketPath), { connectTimeoutMs: 0 });
  try {
    return command === 'carriage' ? await carriage(client, paths, model, interrupt.signal) : await requestSize(client, model);
  } finally {
    await client.destroy();
  }
};

const TOKEN_PATTERNS: readonly RegExp[] = [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, /oaiapp_/, /[?&](code|state|id_token_hint|nonce)=/];

const LONG_RUN = /[A-Za-z0-9_-]{40,}/;

type Leak = { step: string; field: string; long: boolean };

const leakIn = (value: Fact, step: string, field: string, allowed: ReadonlySet<string>): Leak | undefined => {
  if (typeof value === 'string') {
    if (TOKEN_PATTERNS.some((pattern) => pattern.test(value))) return { step, field, long: false };
    return LONG_RUN.test(value) && !allowed.has(field) ? { step, field, long: true } : undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const item of value as readonly Fact[]) {
      const leak = leakIn(item, step, field, allowed);
      if (leak !== undefined) return leak;
    }
    return undefined;
  }
  for (const [key, inner] of Object.entries(value as { readonly [key: string]: Fact })) {
    const leak = leakIn(inner, step, key, allowed);
    if (leak !== undefined) return leak;
  }
  return undefined;
};

const NO_FIELDS: ReadonlySet<string> = new Set();

const leakOf = (report: Report, allowLong: Arguments['allowLong']): Leak | undefined => {
  const account = leakIn(report.account, 'report', 'account', NO_FIELDS);
  if (account !== undefined) return account;
  for (const step of report.steps) {
    const leak = leakIn(step.facts, step.step, 'facts', allowLong.get(step.step) ?? NO_FIELDS);
    if (leak !== undefined) return leak;
  }
  return undefined;
};

const leakText = ({ step, field, long }: Leak): string =>
  long
    ? `plan-real-check: ${step} field ${field} looks like a long token, so nothing was written. If it is a value you may share, run again with --allow-long ${step}.${field}.`
    : `plan-real-check: ${step} field ${field} looks like a token, so nothing was written.`;

const textOf = (report: Report): string =>
  [
    `momonga plan real check (${report.format}) generated ${report.generatedAt}`,
    `account: ${report.account ?? 'none'}`,
    ...report.steps.map((step) => `${step.step}  ${step.verdict}  ${JSON.stringify(step.facts)}`),
  ].join('\n');

const run = async (argv: readonly string[]): Promise<number> => {
  try {
    return await checked(argv);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stderr.write(`plan-real-check: ${error.message}\n`);
    return EXIT_USAGE;
  }
};

const checked = async (argv: readonly string[]): Promise<number> => {
  let args: Arguments;
  try {
    args = parseArguments(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (isOwnHome(args.home)) {
    process.stderr.write(`${OWN_HOME_REFUSAL}\n`);
    return EXIT_USAGE;
  }
  const paths = momongaLayout(path.resolve(args.home), process.platform, process.env);
  const steps = args.command === 'collect' ? collect(readEvents(paths), args) : await throughGateway(args.command, paths, args.model ?? '');
  const report: Report = { format: REPORT_FORMAT, generatedAt: new Date().toISOString(), account: accountOf(readEvents(paths)), steps };
  const leak = leakOf(report, args.allowLong);
  if (leak !== undefined) {
    process.stderr.write(`${leakText(leak)}\n`);
    return EXIT_LEAK;
  }
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${textOf(report)}\n`);
  return steps.every((step) => OPTIONAL_STEPS.has(step.step) || step.verdict === 'recorded') ? EXIT_RECORDED : EXIT_INCOMPLETE;
};

process.exitCode = await run(process.argv.slice(2));
