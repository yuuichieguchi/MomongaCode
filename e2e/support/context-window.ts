import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { OUTPUT_READER_TOOL } from '@momonga/foundation';
import { ESTIMATED_CHARACTERS_PER_TOKEN } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import type { FakeChatCompletionsServer, FakeRoute } from '@momonga/testkit';
import { proactiveGainOf, sizingFor, overflowStepRange, wireTokensOfBody } from './budget.ts';
import type { Sizing } from './budget.ts';
import { runCli } from './cli.ts';
import { createGatewayCountClient } from './gateway-count.ts';
import type { E2eHome } from './home.ts';
import { omittedMarker } from '../../packages/context/src/tool-output.ts';
import { chatCompletions, textReply, toolCallReply } from './upstream.ts';

export const PREFIX_PROBE_TASK = 'Report the size of the prefix.';

export const CALIBRATION_LINE = 'line of the walk';

const CALIBRATION_LINE_COUNTS = [20] as const;

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

export type MeasuredWindow = { capabilities: Capabilities; person: Sizing; benchmark: Sizing; personGain: number; benchmarkGain: number; evictedReadTokens: number };

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

type ChatBody = { messages: { role?: unknown; content?: unknown }[] };

const withOutputsEvicted = (body: unknown): ChatBody => {
  const chat = body as ChatBody;
  return {
    ...chat,
    messages: chat.messages.map((message) => {
      if (message.role !== 'tool') return message;
      const output = String(message.content);
      const handle = createHash('sha256').update(output, 'utf8').digest('hex');
      return { ...message, content: omittedMarker(Math.ceil(output.length / ESTIMATED_CHARACTERS_PER_TOKEN), handle, OUTPUT_READER_TOOL) };
    }),
  };
};

const firstRequestAndEvictedRead = (fake: Pick<FakeChatCompletionsServer, 'requests'>, task: string): { first: number; afterEviction: number } => {
  const requests = requestsFor(fake, task);
  const first = requests.find((entry) => !hasToolMessage(entry.body));
  const afterRead = requests.find((entry) => hasToolMessage(entry.body));
  if (first === undefined || afterRead === undefined) throw new Error(`the calibration task ${task} did not make a request before and a request after its read`);
  return { first: wireTokensOfBody(first.body), afterEviction: wireTokensOfBody(withOutputsEvicted(afterRead.body)) };
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
  const [read] = CALIBRATION_LINE_COUNTS.map((lines) => firstRequestAndEvictedRead(fake, calibrationTask(lines)));
  if (read === undefined) throw new Error('the calibration needs a file to read');
  const count = createGatewayCountClient(home.paths.sockets.gateway);
  const capabilities = await count.capabilities();
  const person = sizingFor(capabilities, wireTokensOfBody(personRequest.body));
  const benchmark = sizingFor(capabilities, read.first);
  return {
    capabilities,
    person,
    benchmark,
    personGain: await proactiveGainOf(count, person),
    benchmarkGain: await proactiveGainOf(count, benchmark),
    evictedReadTokens: read.afterEviction - read.first,
  };
};

export const fillerOfTokens = (tokens: number): string => 'w'.repeat(tokens * ESTIMATED_CHARACTERS_PER_TOKEN);

export const stepTokensToOverflowTheRoom = async (capabilities: Capabilities, sizing: Sizing, steps: number): Promise<number> =>
  (await overflowStepRange(capabilities, sizing.pinned, steps)).lowest;

export const compactableTokens = (steps: number, protectedSteps: number, stepTokens: number): number => Math.max(0, steps - protectedSteps) * stepTokens;
