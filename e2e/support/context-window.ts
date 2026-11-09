import fs from 'node:fs';
import path from 'node:path';
import { createTokenMeter, renderWorkingState, workingStateCapFor, workingStateMessage } from '@momonga/context';
import { ESTIMATED_CHARACTERS_PER_TOKEN, MAX_JOURNAL_SEQ_DIGITS, emptyWorkingFacts, tokensForText } from '@momonga/protocol';
import { initialRunState } from '@momonga/store';
import { HISTORY_READ_TOOL_NAME } from '@momonga/tools';
import type { Capabilities, RunState } from '@momonga/protocol';
import type { FakeChatCompletionsServer, FakeRoute } from '@momonga/testkit';
import { sizingFor, overflowStepRange, wireTokensOfBody } from './budget.ts';
import type { Sizing } from './budget.ts';
import { runCli } from './cli.ts';
import { E2E_MODEL_ALIAS, createGatewayCountClient } from './gateway-count.ts';
import type { GatewayCountClient } from './gateway-count.ts';
import type { E2eHome } from './home.ts';
import { chatCompletions, textReply, toolCallReply } from './upstream.ts';
import { E2E_MARGIN_MS } from './wait.ts';

export const PREFIX_PROBE_TASK = 'Report the size of the prefix.';

export const CALIBRATION_LINE = 'line of the walk';

const CALIBRATION_LINE_COUNTS = [20, 60] as const;

const calibrationTask = (lines: number): string => `Read calibration${lines}.txt once.`;

const CALIBRATION_FILE = /calibration(\d+)\.txt/;

const bodyText = (body: unknown): string => JSON.stringify(body);

const hasToolMessage = (body: unknown): boolean => ((body as { messages?: { role?: unknown }[] }).messages ?? []).some((message) => message.role === 'tool');

const workingDirectoryOf = (body: unknown): string => {
  const match = /The working directory is (.+?) and the platform is/.exec(bodyText(body));
  if (match?.[1] === undefined) throw new Error('the system prompt does not name the working directory');
  return match[1];
};

export const prefixProbeRoute: FakeRoute = { match: (body) => bodyText(body).includes(PREFIX_PROBE_TASK), reply: textReply('measured') };

export const calibrationRoute: FakeRoute = {
  match: (body) => /Read calibration\d+\.txt once\./.test(bodyText(body)),
  reply: (body) => {
    if (hasToolMessage(body)) return textReply('read');
    const lines = CALIBRATION_FILE.exec(bodyText(body))?.[1];
    if (lines === undefined) throw new Error('the calibration request names no file');
    return toolCallReply('Read', { file_path: path.join(workingDirectoryOf(body), `calibration${lines}.txt`), offset: 1 });
  },
};

export type MeasuredWindow = { capabilities: Capabilities; person: Sizing; benchmark: Sizing; readFixedTokens: number; factlessWorkingStateTokens: number };

const widestFactlessWorkingStateText = (capabilities: Capabilities): string => {
  const state: RunState = {
    ...initialRunState({ runId: 'r', sessionId: 's' }),
    summary: { item: { type: 'message', role: 'user', content: '' }, summary: '', replacedThroughSeq: 1 },
    evicted: ['call'],
    workingFacts: { ...emptyWorkingFacts(), replacedThroughEventSeq: Number('9'.repeat(MAX_JOURNAL_SEQ_DIGITS)) },
  };
  const text = renderWorkingState(state, {
    capTokens: workingStateCapFor(capabilities),
    tokensOf: tokensForText,
    verificationCommands: [],
    readers: { history_range: HISTORY_READ_TOOL_NAME },
  });
  if (text === undefined) throw new Error('a state with a summary renders no working state');
  return text;
};

const factlessWorkingStateTokensOf = async (client: GatewayCountClient, capabilities: Capabilities): Promise<number> => {
  const meter = createTokenMeter({ counter: { count: (request) => client.gateway.countTokens(request, { signal: AbortSignal.timeout(E2E_MARGIN_MS) }) }, model: E2E_MODEL_ALIAS, capabilities });
  return meter.countItem(workingStateMessage(widestFactlessWorkingStateText(capabilities)), { callNames: {}, withTools: true });
};

const calibrationDataset = (): string =>
  JSON.stringify({
    format: 'momonga-eval-context/1',
    name: 'calibration',
    cases: CALIBRATION_LINE_COUNTS.flatMap((lines) =>
      (['on', 'off'] as const).map((compaction) => ({
        id: `calibration${lines}-${compaction}`,
        scenario: `calibration${lines}`,
        compaction,
        input: calibrationTask(lines),
        files: { [`calibration${lines}.txt`]: `${CALIBRATION_LINE}\n`.repeat(lines) },
        permissionMode: 'acceptEdits',
        onAsk: 'allow_once',
        runs: 1,
        minPassRate: 1,
        rules: [],
        revisionDepth: 0,
        noise: { level: 0, topics: ['testing'] },
        graders: [{ kind: 'status', equals: 'COMPLETED' }],
      })),
    ),
  });

const requestsFor = (fake: Pick<FakeChatCompletionsServer, 'requests'>, task: string) => chatCompletions(fake).filter((entry) => bodyText(entry.body).includes(task));

const firstRequestAndRead = (fake: Pick<FakeChatCompletionsServer, 'requests'>, task: string): { first: number; afterRead: number } => {
  const requests = requestsFor(fake, task);
  const first = requests.find((entry) => !hasToolMessage(entry.body));
  const afterRead = requests.find((entry) => hasToolMessage(entry.body));
  if (first === undefined || afterRead === undefined) throw new Error(`the calibration task ${task} did not make a request before and a request after its read`);
  return { first: wireTokensOfBody(first.body), afterRead: wireTokensOfBody(afterRead.body) };
};

export const measureWindow = async (home: E2eHome, fake: Pick<FakeChatCompletionsServer, 'requests'>, boundMs: number): Promise<MeasuredWindow> => {
  const probe = await runCli(home, ['-p', PREFIX_PROBE_TASK], { cwd: home.project });
  if (probe.code !== 0) throw new Error(`the prefix probe exited with ${String(probe.code)}\n${probe.stderr}`);
  const personRequest = requestsFor(fake, PREFIX_PROBE_TASK)[0];
  if (personRequest === undefined) throw new Error('the prefix probe never reached the upstream');
  const calibrationFile = path.join(home.root, 'calibration.json');
  fs.writeFileSync(calibrationFile, calibrationDataset());
  const calibration = await runCli(home, ['eval', 'context', calibrationFile, '--alias', 'default'], { cwd: home.project, boundMs });
  if (calibration.code !== 0) throw new Error(`the calibration run exited with ${String(calibration.code)}\n${calibration.stdout}\n${calibration.stderr}`);
  const [small, large] = CALIBRATION_LINE_COUNTS.map((lines) => ({ lines, ...firstRequestAndRead(fake, calibrationTask(lines)) }));
  if (small === undefined || large === undefined) throw new Error('the calibration needs two file sizes');
  const growth = (entry: { first: number; afterRead: number }): number => entry.afterRead - entry.first;
  const readLineTokens = (growth(large) - growth(small)) / (large.lines - small.lines);
  const client = createGatewayCountClient(home.paths.sockets.gateway);
  const capabilities = await client.capabilities();
  return {
    capabilities,
    factlessWorkingStateTokens: await factlessWorkingStateTokensOf(client, capabilities),
    person: sizingFor(capabilities, wireTokensOfBody(personRequest.body)),
    benchmark: sizingFor(capabilities, small.first),
    readFixedTokens: growth(small) - small.lines * readLineTokens,
  };
};

export const fillerOfTokens = (tokens: number): string => 'w'.repeat(tokens * ESTIMATED_CHARACTERS_PER_TOKEN);

export const stepTokensToOverflowTheRoom = async (capabilities: Capabilities, sizing: Sizing, steps: number): Promise<number> =>
  (await overflowStepRange(capabilities, sizing.pinned, steps)).lowest;

export const compactableTokens = (steps: number, protectedSteps: number, stepTokens: number): number => Math.max(0, steps - protectedSteps) * stepTokens;
