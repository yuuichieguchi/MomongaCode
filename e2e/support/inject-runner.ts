import fs from 'node:fs';
import path from 'node:path';
import { currentSocketResolver } from '@momonga/foundation';
import type { InjectionExpect, InjectionScenario, InjectionTrial } from '@momonga/eval';
import { REPORT_PAGE_ROWS, TERMINAL_STATUSES } from '@momonga/protocol';
import type { AnsweredByView, RunFactsView } from '@momonga/protocol';
import { GATEWAY_CONFIG_DEFAULTS } from '@momonga/gateway';
import { startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer, FakeResponseHold, FakeScriptedReply } from '@momonga/testkit';
import { createE2eHome, disposeAll, e2eTmpRoot, registerE2eCleanup } from './home.ts';
import type { E2eHome } from './home.ts';
import { createRuntimeClient } from './runtime-client.ts';
import type { RunEventStream, RuntimeClient } from './runtime-client.ts';
import { spawnSupervisor, startStack } from './stack.ts';
import type { E2eStack, StartStackOptions } from './stack.ts';
import { childOf } from './supervisor-client.ts';
import { textReply, toolCallReply } from './upstream.ts';
import { readLog } from './log-reader.ts';
import { SUPERVISOR_APP_VERSION } from './app-version.ts';
import { roleMainOverride } from './launcher.ts';
import { fileFaultArgument, retentionCrashArgument } from './role-main.ts';
import type { RoleMainFileFault, RoleMainRetentionCrash } from './role-main.ts';
import { E2E_DISPOSE_BOUND_MS, E2E_MARGIN_MS, E2E_READY_DEADLINE_MS, E2E_RESTART_POLICY, E2E_RUN_COMPLETED_BOUND_MS, E2E_SUPERVISOR_CLOSE_BOUND_MS, e2eTestTimeoutMs, until, withinBound } from './wait.ts';

import { INJECTION_REPORT_ENV, writeInjectionPart } from './inject-report.ts';
import type { ScenarioResult } from './inject-report.ts';

export { INJECTION_REPORT_ENV, injectionReportOf } from './inject-report.ts';
export type { ScenarioResult } from './inject-report.ts';

export type InjectionHost = { linuxContainer: boolean };

const HELD_COMMAND_SECONDS = 600;
const GATEWAY_RETRY = GATEWAY_CONFIG_DEFAULTS.retry;
const GATEWAY_WINDOW_BOUND_MS = GATEWAY_RETRY.totalWaitMs + E2E_MARGIN_MS;
const SMALL_FILESYSTEM_MAX_BYTES = 256 * 1024 * 1024;
const FILL_CHUNK_BYTES = 1024 * 1024;
const PORT_FAULT_MARKER_NAME = 'file-fault.on';
const PORT_FAULT_RECORD_NAME = 'file-fault.refused';
const RETENTION_CRASH_MARKER_NAME = 'retention-crash.on';
const RETENTION_CRASH_RECORD_NAME = 'retention-crash.killed';
const LEDGER_DIRECTORY_NAME = 'ledger';
const LEDGER_FILE_NAME = 'ledger.txt';
const HOOK_MARK_FILE_NAME = 'hook.mark';
const HOOK_RELEASE_FILE_NAME = 'hook.release';
const BROKEN_SETTINGS_TEXT = '{ "models": ';

export type InjectionPoint = { type: 'model.requested' | 'tool.started'; occurrence: number };

type Point = InjectionPoint;

type TrialEnv = {
  readonly scenario: InjectionScenario;
  readonly point: Point | undefined;
  readonly home: E2eHome;
  readonly ledgerFile: string;
  readonly hookMark: string;
  readonly hookRelease: string;
  readonly holds: FakeResponseHold[];
  stack: E2eStack | undefined;
  runtime: RuntimeClient | undefined;
  fake: FakeChatCompletionsServer | undefined;
  runId: string | undefined;
  stream: RunEventStream | undefined;
  filler: string | undefined;
};

type Fault = {
  stackOptions?(env: TrialEnv): Partial<StartStackOptions>;
  upstreamScript?(env: TrialEnv, script: FakeScriptedReply[]): FakeScriptedReply[];
  beforeRun?(env: TrialEnv): Promise<void>;
  runBody?(env: TrialEnv): Record<string, unknown>;
  inject?(env: TrialEnv): Promise<void>;
  afterTerminal?(env: TrialEnv, frames: readonly Frame[]): Promise<void>;
  extraBoundMs?(scenario: InjectionScenario): number;
};

type Frame = { readonly data: { readonly type: string } & Readonly<Record<string, unknown>> };

type Observed = { frames: readonly Frame[]; facts: RunFactsView };

const expandTemplates = (value: unknown, env: TrialEnv): unknown => {
  if (typeof value === 'string') return value.replaceAll('{ledger}', env.ledgerFile).replaceAll('{project}', env.home.project);
  if (Array.isArray(value)) return value.map((entry: unknown) => expandTemplates(entry, env));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandTemplates(entry, env)]));
  return value;
};

const heldByPoint = (env: TrialEnv, input: Record<string, unknown>, callNumber: number): Record<string, unknown> =>
  env.point?.type === 'tool.started' && env.point.occurrence === callNumber && typeof input['command'] === 'string'
    ? { ...input, command: `sleep ${HELD_COMMAND_SECONDS}; ${input['command']}` }
    : input;

const scriptOf = (env: TrialEnv): FakeScriptedReply[] => {
  let callNumber = 0;
  return env.scenario.task.steps.map((step, index) => {
    if ('text' in step) return textReply(step.text);
    callNumber += 1;
    const input = heldByPoint(env, expandTemplates(step.call.input, env) as Record<string, unknown>, callNumber);
    return toolCallReply(step.call.name, input, `call_${index + 1}`);
  });
};

const ledgerLines = (env: TrialEnv): string[] => fs.readFileSync(env.ledgerFile, 'utf8').split('\n').filter((line) => line !== '');

const witnessOf = (env: TrialEnv): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const key of ledgerLines(env)) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
};

const framesOfType = (frames: readonly Frame[], type: string): Frame[] => frames.filter((frame) => frame.data.type === type);

const runtimePidOf = async (env: TrialEnv): Promise<number> => {
  const pid = childOf(await (env.stack as E2eStack).client.health(), 'runtime').pid;
  if (pid === undefined) throw new Error('the runtime has no pid');
  return pid;
};

const killRuntime = async (env: TrialEnv): Promise<void> => {
  const pid = await runtimePidOf(env);
  await (env.stream as RunEventStream).close();
  process.kill(pid, 'SIGKILL');
};

const untilFrames = (env: TrialEnv, type: string, occurrence: number, description: string, extraBoundMs = 0): Promise<true> =>
  until(() => framesOfType((env.stream as RunEventStream).frames(), type).length >= occurrence, { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS + extraBoundMs, description });

const untilLedger = (env: TrialEnv, key: string): Promise<true> =>
  until(() => ledgerLines(env).includes(key), { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `the ledger to hold ${key}` });

const effectKeyOfHeldStep = (env: TrialEnv): string => {
  const held = env.scenario.task.steps.flatMap((step) => ('call' in step && typeof step.call.input['command'] === 'string' && step.call.input['command'].includes('sleep') ? [step.call.input['command']] : []))[0];
  const key = held === undefined ? undefined : /echo (\S+) >>/.exec(held)?.[1];
  if (key === undefined) throw new Error(`scenario ${env.scenario.id} holds no step that appends an effect key before sleeping`);
  return key;
};

const hookCommandOf = (env: TrialEnv): string =>
  `if [ -e ${env.hookMark} ]; then exit 0; fi; : > ${env.hookMark}; while [ ! -e ${env.hookRelease} ]; do sleep 0.1; done`;

const upstreamDown = async (env: TrialEnv): Promise<void> => {
  await (env.fake as FakeChatCompletionsServer).close();
};

const upstreamBack = async (env: TrialEnv): Promise<void> => {
  env.fake = await startFakeChatCompletions({ scenario: 'tools-ok', socketPath: env.home.upstreamSocket, script: scriptOf(env), maxConcurrency: 8 });
  const restored = env.fake;
  registerE2eCleanup(() => restored.close());
};

const chatRequestsOf = (env: TrialEnv) => (env.fake as FakeChatCompletionsServer).requests.filter((request) => request.path === '/v1/chat/completions');

const retryAfterSecondsOf = (window: 'inside' | 'beyond'): string =>
  String(window === 'inside' ? Math.ceil(GATEWAY_RETRY.baseMs / 1000) : Math.floor(GATEWAY_RETRY.totalWaitMs / 1000) + 1);

const retentionCrashOf = (env: TrialEnv): RoleMainRetentionCrash => ({
  marker: path.join(env.home.root, RETENTION_CRASH_MARKER_NAME),
  record: path.join(env.home.root, RETENTION_CRASH_RECORD_NAME),
});

const FAULTS: Record<InjectionScenario['fault'], Fault> = {
  retention_crash: {
    stackOptions: (env) => ({
      deps: { launcherOverrides: { runtime: roleMainOverride('runtime', SUPERVISOR_APP_VERSION, [retentionCrashArgument(retentionCrashOf(env))]) } },
    }),
    beforeRun: async (env) => {
      fs.writeFileSync(retentionCrashOf(env).marker, '');
    },
    inject: async (env) => {
      const crash = retentionCrashOf(env);
      await until(() => fs.existsSync(crash.record) && fs.readFileSync(crash.record, 'utf8') !== '', {
        deadlineMs: E2E_RUN_COMPLETED_BOUND_MS,
        description: 'the runtime killed between the purges and the finish of a retention sweep',
      });
    },
  },
  kill_at_step: {
    beforeRun: async (env) => {
      const point = env.point as Point;
      if (point.type !== 'model.requested') return;
      for (let index = 0; index < point.occurrence; index += 1) {
        const hold = (env.fake as FakeChatCompletionsServer).hold();
        if (index < point.occurrence - 1) hold.release();
        env.holds.push(hold);
      }
    },
    inject: async (env) => {
      const point = env.point as Point;
      await untilFrames(env, point.type, point.occurrence, `${point.type} number ${point.occurrence}`);
      if (point.type === 'model.requested') await (env.holds.at(-1) as FakeResponseHold).waitForRequest({ timeoutMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the held model request' });
      await killRuntime(env);
      for (const hold of env.holds) hold.release();
    },
  },
  kill_after_effect: {
    inject: async (env) => {
      await untilLedger(env, effectKeyOfHeldStep(env));
      await killRuntime(env);
    },
  },
  network_down: {
    beforeRun: upstreamDown,
    inject: async (env) => {
      await until(
        () => {
          const frames = (env.stream as RunEventStream).frames();
          return framesOfType(frames, 'attempt.failed').length > 0 || framesOfType(frames, 'run.status').some((frame) => (TERMINAL_STATUSES as readonly string[]).includes(String(frame.data['to'])));
        },
        { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS + GATEWAY_WINDOW_BOUND_MS, description: 'attempt.failed or the end of the run after the upstream refused connections for longer than the gateway retry window' },
      );
      await upstreamBack(env);
    },
    extraBoundMs: () => GATEWAY_WINDOW_BOUND_MS,
  },
  upstream_stall: {
    upstreamScript: (_env, script) => [{ kind: 'hang', chunks: [{ delta: { role: 'assistant', content: 'stalled' } }] }, ...script],
    stackOptions: (env) => ({ model: { answers: 'script', idleTimeoutMs: env.scenario.params?.idleTimeoutMs as number } }),
    afterTerminal: async (env) => {
      if (chatRequestsOf(env).length < 2) throw new Error(`scenario ${env.scenario.id}: the upstream received ${chatRequestsOf(env).length} requests, so the stalled one was not cut by the idle bound and asked again`);
    },
  },
  disk_full: {
    stackOptions: (env) =>
      env.scenario.requires === 'linux-container'
        ? {}
        : { deps: { launcherOverrides: { runtime: roleMainOverride('runtime', SUPERVISOR_APP_VERSION, [fileFaultArgument(portFaultOf(env))]) } } },
    beforeRun: async (env) => {
      if (env.scenario.requires !== 'linux-container') {
        fs.writeFileSync(portFaultOf(env).marker, '');
        return;
      }
      env.filler = path.join(env.home.root, 'filler.bin');
      const descriptor = fs.openSync(env.filler, 'w');
      const chunk = Buffer.alloc(FILL_CHUNK_BYTES);
      try {
        for (;;) fs.writeSync(descriptor, chunk);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOSPC') throw error;
      } finally {
        fs.closeSync(descriptor);
      }
    },
    inject: async (env) => {
      if (env.scenario.requires === 'linux-container') {
        fs.rmSync(env.filler as string, { force: true });
        return;
      }
      const fault = portFaultOf(env);
      await until(() => fs.existsSync(fault.record) && fs.readFileSync(fault.record, 'utf8') !== '', {
        deadlineMs: E2E_RUN_COMPLETED_BOUND_MS,
        description: `a write of the runtime under ${fault.under} refused with ENOSPC by the file-system port`,
      });
      fs.rmSync(fault.marker);
    },
  },
  rate_limit: {
    upstreamScript: (env, script) => [
      {
        kind: 'error',
        status: 429,
        body: { error: { message: 'rate limited', type: 'rate_limit_error', param: null, code: 'rate_limit_exceeded' } },
        headers: { 'retry-after': retryAfterSecondsOf(env.scenario.params?.retryAfterWindow as 'inside' | 'beyond') },
      },
      ...script,
    ],
    extraBoundMs: (scenario) => (scenario.params?.retryAfterWindow === 'beyond' ? GATEWAY_WINDOW_BOUND_MS + GATEWAY_RETRY.maxMs : 0),
    afterTerminal: async (env) => {
      if (chatRequestsOf(env).length < 2) throw new Error(`scenario ${env.scenario.id}: the upstream received fewer than two requests, so the rate limit was not injected and retried`);
    },
  },
  duplicate_start: {
    beforeRun: async (env) => {
      env.holds.push((env.fake as FakeChatCompletionsServer).hold());
    },
    inject: async (env) => {
      const stack = env.stack as E2eStack;
      const hold = env.holds[0] as FakeResponseHold;
      await hold.waitForRequest({ timeoutMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the held model request' });
      await (env.stream as RunEventStream).close();
      const stopping = await stack.client.shutdown();
      if (stopping.status !== 202) throw new Error(`scenario ${env.scenario.id}: the first supervisor answered ${stopping.status} to its stop`);
      const deps = { restart: E2E_RESTART_POLICY };
      const second = spawnSupervisor({ home: env.home, stackNumber: 2, entry: { kind: 'test', deps } });
      hold.release();
      const bound = E2E_SUPERVISOR_CLOSE_BOUND_MS + E2E_READY_DEADLINE_MS;
      await second.ready(bound);
      const firstExit = await withinBound(stack.supervisor.exited, bound, 'the first supervisor to exit after its stop');
      if (firstExit.code !== 0) throw new Error(`scenario ${env.scenario.id}: the first supervisor exited with ${JSON.stringify(firstExit)} after its stop`);
    },
    extraBoundMs: () => E2E_SUPERVISOR_CLOSE_BOUND_MS + E2E_READY_DEADLINE_MS,
  },
  concurrent_workers: {
    stackOptions: (env) => ({ deps: { runtime: { workerCount: env.scenario.params?.workerCount as number } } }),
    beforeRun: async (env) => {
      env.holds.push((env.fake as FakeChatCompletionsServer).hold());
    },
    inject: async (env) => {
      const hold = env.holds[0] as FakeResponseHold;
      await hold.waitForRequest({ timeoutMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the held model request of the claimed run' });
      await until(
        () =>
          readLog(env.home.paths.logFiles.runtime).some(
            (record) => record.msg === 'worker.claim_held' && record['runId'] === env.runId && typeof record['owner'] === 'string' && record['owner'] !== record['workerId'],
          ),
        { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `another worker to reach run ${env.runId as string} and find it held by the worker that claimed it` },
      );
      hold.release();
    },
  },
  budget: {
    runBody: (env) => ({ limits: { maxTotalTokens: env.scenario.params?.maxTotalTokens } }),
  },
  settings_broken: {
    beforeRun: async (env) => {
      env.holds.push((env.fake as FakeChatCompletionsServer).hold());
    },
    inject: async (env) => {
      const hold = env.holds[0] as FakeResponseHold;
      await hold.waitForRequest({ timeoutMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the held model request of the running run' });
      fs.writeFileSync(env.home.paths.settingsFile, BROKEN_SETTINGS_TEXT);
      hold.release();
    },
    afterTerminal: async (env) => {
      const runtime = env.runtime as RuntimeClient;
      const { sessionId } = (await runtime.getRun(env.runId as string)).run;
      const refused = await runtime.json('POST', `/v1/sessions/${sessionId}/runs`, { input: env.scenario.task.prompt });
      const text = JSON.stringify(refused.body);
      if (refused.status === 202) throw new Error(`scenario ${env.scenario.id}: a new run was admitted while the settings file was broken`);
      if (!text.includes(env.home.paths.settingsFile)) throw new Error(`scenario ${env.scenario.id}: the refusal of a new run (${refused.status}) does not name the settings file: ${text}`);
    },
  },
  external_state_changed: {
    stackOptions: (env) => ({
      settings: { hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: hookCommandOf(env) }] }] } },
    }),
    inject: async (env) => {
      await until(() => fs.existsSync(env.hookMark), { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the PostToolUse hook to hold the Write after its effect' });
      await killRuntime(env);
      const step = env.scenario.task.steps.find((candidate) => 'call' in candidate && candidate.call.name === 'Write');
      if (step === undefined || !('call' in step)) throw new Error(`scenario ${env.scenario.id} holds no Write step`);
      const input = expandTemplates(step.call.input, env) as { file_path: string; content: string };
      if (env.scenario.params?.change === 'applied') fs.writeFileSync(input.file_path, input.content);
      else fs.rmSync(input.file_path, { force: true });
    },
  },
};

const portFaultOf = (env: TrialEnv): RoleMainFileFault => ({
  code: 'ENOSPC',
  under: env.home.paths.root,
  marker: path.join(env.home.root, PORT_FAULT_MARKER_NAME),
  record: path.join(env.home.root, PORT_FAULT_RECORD_NAME),
});

const createRunId = async (env: TrialEnv, fault: Fault): Promise<string> => {
  const runtime = env.runtime as RuntimeClient;
  const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
  const extra = fault.runBody?.(env) ?? {};
  const response = await runtime.json('POST', `/v1/sessions/${session.id}/runs`, { input: env.scenario.task.prompt, ...extra });
  if (response.status !== 202) throw new Error(`scenario ${env.scenario.id}: creating the run answered ${response.status}: ${JSON.stringify(response.body)}`);
  return (response.body as { run: { id: string } }).run.id;
};

const continueUnknownEffects = async (runtime: RuntimeClient, runId: string): Promise<void> => {
  for (const approval of await runtime.approvals(runId)) {
    if (approval.kind !== 'unknown_effect' || approval.status !== 'pending') continue;
    const option = approval.options.find((candidate) => candidate.kind === 'allow_once');
    if (option === undefined) throw new Error(`run ${runId}: the approval ${approval.id} about an unknown effect offers no allow_once option`);
    const answered = await runtime.resolveApproval(approval.id, option.optionId);
    if (answered.status !== 200) throw new Error(`run ${runId}: answering the approval ${approval.id} about an unknown effect answered ${answered.status}: ${JSON.stringify(answered.body)}`);
  }
};

const factsOf = async (runtime: RuntimeClient, runId: string): Promise<RunFactsView> =>
  until(
    async () => {
      let cursor: string | null = null;
      do {
        const page: Awaited<ReturnType<RuntimeClient['reportFacts']>> = await runtime.reportFacts({ cursor, limit: REPORT_PAGE_ROWS });
        const row = page.rows.find((candidate) => candidate.runId === runId);
        if (row !== undefined) return row;
        cursor = page.nextCursor;
      } while (cursor !== null);
      return undefined;
    },
    { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `the facts of run ${runId}` },
  );

const violationsOf = (expectation: InjectionExpect, observed: Observed, env: TrialEnv): string[] => {
  const { frames, facts } = observed;
  const found: string[] = [];
  if (facts.status !== expectation.status) found.push(`the run ended ${facts.status}, expected ${expectation.status}`);
  if (expectation.stopReason !== undefined && facts.stopReason !== expectation.stopReason) found.push(`the stop reason is ${String(facts.stopReason)}, expected ${expectation.stopReason}`);
  const outcomes = facts.recoveries.map((episode) => episode.outcome);
  if (expectation.episodeOutcomes !== undefined) {
    const allowed: readonly string[] = expectation.episodeOutcomes;
    for (const outcome of outcomes) if (!allowed.includes(outcome)) found.push(`an episode ended ${outcome}, expected one of ${allowed.join(', ')}`);
  }
  if (expectation.minEpisodes !== undefined && outcomes.length < expectation.minEpisodes) found.push(`${outcomes.length} episodes, expected at least ${expectation.minEpisodes}`);
  if (expectation.reconciled !== undefined) {
    const counts = { already_applied: facts.reconciledAlreadyApplied, not_applied: facts.reconciledNotApplied, unknown: facts.reconciledUnknown };
    for (const [outcome, count] of Object.entries(counts)) {
      const wanted = (expectation.reconciled as readonly string[]).includes(outcome);
      if (wanted !== count > 0) found.push(`reconcile outcome ${outcome} was seen ${count} times, and it ${wanted ? 'is' : 'is not'} expected`);
    }
  }
  if (expectation.attemptFailed !== undefined && (framesOfType(frames, 'attempt.failed').length > 0) !== expectation.attemptFailed) {
    found.push(`attempt.failed ${expectation.attemptFailed ? 'was not' : 'was'} recorded`);
  }
  if (expectation.budgetStops !== undefined) {
    const stops = facts.stopReason === 'budget' ? 1 : 0;
    if (stops !== expectation.budgetStops) found.push(`${stops} budget stops, expected ${expectation.budgetStops}`);
  }
  if (expectation.runStarted !== undefined) {
    const started = framesOfType(frames, 'run.started').length;
    if (started !== expectation.runStarted) found.push(`run.started was recorded ${started} times, expected ${expectation.runStarted}`);
  }
  for (const file of expectation.files ?? []) {
    const target = expandTemplates(file.path, env) as string;
    const content = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined;
    if (content !== file.content) found.push(`${target} holds ${JSON.stringify(content)}, expected ${JSON.stringify(file.content)}`);
  }
  return found;
};

const outcomeLabelOf = (facts: RunFactsView): string =>
  [facts.status, facts.stopReason, ...facts.recoveries.map((episode) => `episode:${episode.outcome}`)].filter((part) => part !== undefined).join(' ');

type TrialRecord = { label: string; witness: Record<string, number>; trial: InjectionTrial };

const NO_FAULT: Fault = {};

const runTrial = async (scenario: InjectionScenario, point: Point | undefined, resultId: string, fault: Fault = FAULTS[scenario.fault]): Promise<TrialRecord & { frames: readonly Frame[] }> => {
  const home = await createE2eHome();
  const ledgerDirectory = path.join(home.root, LEDGER_DIRECTORY_NAME);
  fs.mkdirSync(ledgerDirectory);
  const ledgerFile = path.join(ledgerDirectory, LEDGER_FILE_NAME);
  fs.writeFileSync(ledgerFile, '');
  const env: TrialEnv = {
    scenario,
    point,
    home,
    ledgerFile,
    hookMark: path.join(ledgerDirectory, HOOK_MARK_FILE_NAME),
    hookRelease: path.join(ledgerDirectory, HOOK_RELEASE_FILE_NAME),
    holds: [],
    stack: undefined,
    runtime: undefined,
    fake: undefined,
    runId: undefined,
    stream: undefined,
    filler: undefined,
  };
  let completed = false;
  let failure: unknown;
  try {
    const stackOptions = fault.stackOptions?.(env) ?? {};
    const script = fault.upstreamScript?.(env, scriptOf(env)) ?? scriptOf(env);
    env.stack = await startStack({
      home,
      needsBash: true,
      model: { answers: 'script' },
      script,
      ...stackOptions,
      deps: { restart: E2E_RESTART_POLICY, ...stackOptions.deps },
      settings: { permissions: { additionalDirectories: [ledgerDirectory] }, ...stackOptions.settings },
    });
    env.fake = env.stack.fake;
    await until(async () => (await (env.stack as E2eStack).client.health()).role === 'serving', { deadlineMs: E2E_READY_DEADLINE_MS, description: 'the started generation to be the serving one' });
    env.runtime = createRuntimeClient(home, currentSocketResolver(home.paths, 'runtime'));
    await fault.beforeRun?.(env);
    env.runId = await createRunId(env, fault);
    env.stream = env.runtime.events(env.runId);
    await fault.inject?.(env);
    const runtime = env.runtime;
    const runId = env.runId;
    await until(
      async () => {
        const { status } = (await runtime.getRun(runId)).run;
        if (status === 'WAITING_HUMAN') await continueUnknownEffects(runtime, runId);
        return (TERMINAL_STATUSES as readonly string[]).includes(status);
      },
      {
        deadlineMs: E2E_RUN_COMPLETED_BOUND_MS + (fault.extraBoundMs?.(scenario) ?? 0),
        description: `run ${runId} to end`,
      },
    );
    const replay = runtime.events(runId);
    const frames = await replay.toEnd(E2E_MARGIN_MS);
    await replay.close();
    await fault.afterTerminal?.(env, frames);
    const facts = await factsOf(runtime, runId);
    const answeredBy = await runtime.answeredBy(runId);
    const violations = violationsOf({ ...scenario.expect, ...(point === undefined ? {} : scenario.pointExpect?.[point.type]) }, { frames, facts }, env);
    if (violations.length > 0) throw new Error(`scenario ${resultId} (run ${runId}): ${violations.join('; ')}`);
    const witness = witnessOf(env);
    completed = true;
    return {
      label: outcomeLabelOf(facts),
      witness,
      frames,
      trial: { scenario: resultId, facts: [facts], witness, answeredBy: answeredBy as AnsweredByView[], unrecordedAnswers: 0 },
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    fs.writeFileSync(env.hookRelease, '');
    await env.stream?.close();
    await env.runtime?.close();
    await disposeAll({ test: resultId, failed: !completed }).catch((disposeError: unknown) => {
      if (failure === undefined) throw disposeError;
      throw new AggregateError([failure, disposeError], `${resultId}: ${failure instanceof Error ? failure.message : String(failure)}`, { cause: failure });
    });
  }
};

const pointsOf = async (scenario: InjectionScenario): Promise<Point[]> => {
  const reference = await runTrial({ ...scenario, expect: { status: 'COMPLETED' } }, undefined, `${scenario.id}@reference`, NO_FAULT);
  return (scenario.params?.points ?? []).flatMap((type) =>
    Array.from({ length: framesOfType(reference.frames, type).length }, (_unused, index): Point => ({ type, occurrence: index + 1 })),
  );
};

const resultOf = async (scenario: InjectionScenario, point: Point | undefined, id: string): Promise<ScenarioResult> => {
  const trials: TrialRecord[] = [];
  for (let index = 0; index < scenario.trials; index += 1) trials.push(await runTrial(scenario, point, id));
  const witness: Record<string, number> = {};
  trials.forEach((record, index) => {
    for (const [key, count] of Object.entries(record.witness)) witness[`${index + 1}/${key}`] = count;
  });
  return { id, status: 'ran', witness, outcomes: trials.map((record) => record.label), trials: trials.map((record) => record.trial) };
};

const sweepOf = async (scenario: InjectionScenario): Promise<ScenarioResult[]> => {
  const sweep: ScenarioResult[] = [];
  for (const point of await pointsOf(scenario)) sweep.push(await resultOf(scenario, point, pointIdOf(scenario, point)));
  return sweep;
};

const notRunReason = (scenario: InjectionScenario, host: InjectionHost): string | undefined => {
  if (scenario.requires === 'any') return undefined;
  if (!host.linuxContainer) return `linux-container: scenario ${scenario.id} needs the Linux container, where the state directory sits on a size-limited filesystem of at most ${SMALL_FILESYSTEM_MAX_BYTES} bytes under ${e2eTmpRoot()}`;
  return undefined;
};

export const detectInjectionHost = (): InjectionHost => {
  if (process.platform !== 'linux') return { linuxContainer: false };
  const { blocks, bsize } = fs.statfsSync(e2eTmpRoot());
  return { linuxContainer: blocks * bsize <= SMALL_FILESYSTEM_MAX_BYTES };
};

const trialBoundMs = (scenario: InjectionScenario): number => {
  const runBoundMs = E2E_RUN_COMPLETED_BOUND_MS + (FAULTS[scenario.fault].extraBoundMs?.(scenario) ?? 0);
  return e2eTestTimeoutMs(E2E_READY_DEADLINE_MS, E2E_READY_DEADLINE_MS, runBoundMs, runBoundMs, E2E_MARGIN_MS, E2E_RUN_COMPLETED_BOUND_MS, E2E_DISPOSE_BOUND_MS);
};

const trialCountOf = (scenario: InjectionScenario): number =>
  scenario.fault === 'kill_at_step' ? 1 + (scenario.params?.points ?? []).length * scenario.task.steps.length * scenario.trials : scenario.trials;

export const scenarioBoundMs = (scenario: InjectionScenario): number => trialCountOf(scenario) * trialBoundMs(scenario);

export const runInjectionScenario = async (scenario: InjectionScenario, host: InjectionHost): Promise<ScenarioResult[]> => {
  const reason = notRunReason(scenario, host);
  const results: ScenarioResult[] =
    reason !== undefined
      ? [{ id: scenario.id, status: 'not_run', reason }]
      : scenario.fault === 'kill_at_step'
        ? await sweepOf(scenario)
        : [await resultOf(scenario, undefined, scenario.id)];
  return reported(results);
};

const reported = (results: ScenarioResult[]): ScenarioResult[] => {
  const target = process.env[INJECTION_REPORT_ENV];
  if (target !== undefined) writeInjectionPart(target, results);
  return results;
};

export const pointIdOf = (scenario: InjectionScenario, point: InjectionPoint): string => `${scenario.id}@${point.type}#${point.occurrence}`;

export const declaredPointsOf = (scenario: InjectionScenario): InjectionPoint[] =>
  (scenario.params?.points ?? []).flatMap((type) => {
    const occurrences = type === 'model.requested' ? scenario.task.steps.length : scenario.task.steps.filter((step) => 'call' in step).length;
    return Array.from({ length: occurrences }, (_unused, index): InjectionPoint => ({ type, occurrence: index + 1 }));
  });

export const referencePointsOf = (scenario: InjectionScenario): Promise<InjectionPoint[]> => pointsOf(scenario);

export const referenceBoundMs = (scenario: InjectionScenario): number => trialBoundMs(scenario);

export const pointBoundMs = (scenario: InjectionScenario): number => scenario.trials * trialBoundMs(scenario);

export const runInjectionPoint = async (scenario: InjectionScenario, point: InjectionPoint): Promise<ScenarioResult[]> => reported([await resultOf(scenario, point, pointIdOf(scenario, point))]);
