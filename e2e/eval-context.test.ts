import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FakeRoute } from '@momonga/testkit';
import { summaryRoute } from './support/budget.ts';
import { titleOf } from './support/cases.ts';
import { runCli } from './support/cli.ts';
import { createE2eHome } from './support/home.ts';
import { baseSettings, sandboxChoiceOf, startUpstream, writeSettingsFile } from './support/stack.ts';
import { SCRIPTED_USAGE, chatCompletions, textReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

const LONG_STEPS = 14;
const LONG_TEXT_CHARS = 1200;
const LONG_TASK = 'Walk through long.txt step by step.';
const RULE_TASK = 'Name the test runner.';
const MEMORY_TASK = 'Report the value of LIMIT.';
const MEMORY_TEXT = 'LIMIT in config.ts is 10.';
const SUMMARY = 'GOAL:\nwalk\nSTATE:\nwalking\nDONE:\nsome\nTODO:\nrest\nDECISIONS:\nnone\nGUARDRAILS:\nnone';

type ChatBody = { messages?: { role?: unknown; content?: unknown }[] };

const textsOf = (body: unknown): { role: string; text: string }[] =>
  ((body as ChatBody).messages ?? []).map((message) => ({ role: String(message.role), text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }));

const workspaceOf = (body: unknown): string => {
  const system = textsOf(body).find((message) => message.role === 'system')?.text ?? '';
  const match = /The working directory is (.+?) and the platform is/.exec(system);
  if (match?.[1] === undefined) throw new Error('the system prompt does not name the working directory');
  return match[1];
};

const asks = (body: unknown, needle: string): boolean => textsOf(body).some((message) => message.role === 'user' && message.text.includes(needle));

const longRoute = (): FakeRoute => {
  const steps = new Map<string, number>();
  return {
    match: (body) => asks(body, LONG_TASK),
    reply: (body) => {
      const workspace = workspaceOf(body);
      const step = (steps.get(workspace) ?? 0) + 1;
      steps.set(workspace, step);
      if (step > LONG_STEPS) return textReply('The walk is finished.');
      return {
        kind: 'stream',
        chunks: [
          {
            delta: {
              role: 'assistant',
              content: `Step ${step}: ${'w'.repeat(LONG_TEXT_CHARS)}`,
              tool_calls: [{ index: 0, id: `call_${step}`, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: path.join(workspace, 'long.txt'), offset: step }) } }],
            },
            finishReason: 'tool_calls',
          },
        ],
        usage: SCRIPTED_USAGE,
      };
    },
  };
};

const memoryRoutes: FakeRoute[] = [{ match: (body) => asks(body, MEMORY_TASK), reply: textReply('LIMIT is known.') }];

const ROUTES: FakeRoute[] = [
  summaryRoute(SUMMARY),
  longRoute(),
  { match: (body) => asks(body, RULE_TASK), reply: textReply('The runner is vitest.') },
  ...memoryRoutes,
];

const paired = (scenario: string, fields: Record<string, unknown>): Record<string, unknown>[] =>
  (['on', 'off'] as const).map((compaction) => ({
    id: `${scenario}-${compaction}`,
    scenario,
    compaction,
    permissionMode: 'acceptEdits',
    onAsk: 'allow_once',
    runs: 1,
    minPassRate: 1,
    rules: [],
    revisionDepth: 0,
    noise: { level: 0, topics: ['testing'] },
    graders: [{ kind: 'status', equals: 'COMPLETED' }],
    ...fields,
  }));

const rule = (id: string, text: string, supersedes: string[]) => ({ id, kind: 'constraint', target: 'test-runner', text, inScope: true, live: true, supersedes });

const DATASET = {
  format: 'momonga-eval-context/1',
  name: 'context-e2e',
  cases: [
    ...paired('long', { input: LONG_TASK, files: { 'long.txt': `${'line\n'.repeat(40)}` } }),
    ...paired('revised', {
      input: RULE_TASK,
      rules: [rule('runner-1', 'Run tests with jest.', []), rule('runner-2', 'Run tests with vitest.', ['runner-1'])],
      revisionDepth: 1,
    }),
    ...paired('stale', {
      input: MEMORY_TASK,
      runs: 2,
      files: { 'config.ts': 'export const LIMIT = 10;\n' },
      memories: [{ text: MEMORY_TEXT, paths: ['config.ts'] }],
      workspace: [{ beforeRun: 1, write: { 'config.ts': 'export const LIMIT = 20;\n' } }],
    }),
  ],
};

type CaseLine = { id: string; compaction: string; runs: number; passedRuns: number; compactions: number };

const metricCounts = (metric: { successes: number; trials: number } | undefined): [number, number] | undefined => (metric === undefined ? undefined : [metric.successes, metric.trials]);

describe('momonga eval context live', () => {
  it(titleOf('eval-context-live'), { timeout: 8 * E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const fake = await startUpstream(home, { home, routes: ROUTES });
    writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));
    const dataset = path.join(home.root, 'context.json');
    fs.writeFileSync(dataset, JSON.stringify(DATASET));
    const recordings = path.join(home.root, 'recordings');
    const liveFile = path.join(home.root, 'live.json');
    const replayFile = path.join(home.root, 'replay.json');

    const live = await runCli(home, ['eval', 'context', dataset, '--model', 'fake', '--alias', 'default', '--seed', '7', '--record', recordings, '--report', liveFile], {
      boundMs: DATASET.cases.length * E2E_RUN_COMPLETED_BOUND_MS,
    });

    expect(live.stderr).toBe('');
    expect(live.stdout).toContain('model: fake');
    expect(live.code).toBe(1);

    const report = JSON.parse(fs.readFileSync(liveFile, 'utf8'));
    expect(report).toMatchObject({ model: 'fake', modelAliases: ['default'], datasetSeed: 7, stopped: [] });
    const cases = report.cases as CaseLine[];
    const byId = new Map(cases.map((entry) => [entry.id, entry]));
    expect(cases.map((entry) => entry.id)).toEqual(['long-on', 'long-off', 'revised-on', 'revised-off', 'stale-on', 'stale-off']);
    expect(byId.get('long-on')?.compactions).toBeGreaterThanOrEqual(1);
    expect(byId.get('long-on')?.passedRuns).toBe(1);
    expect(byId.get('long-off')).toMatchObject({ compactions: 0, runs: 1, passedRuns: 0 });
    expect(report.metrics.contrastiveFailures).toEqual({ count: 0, n: 1 });
    expect(metricCounts(report.metrics.continuationRate)).toEqual([1, 1]);
    expect(report.unclassifiedCompactions).toBe(0);

    expect(byId.get('revised-on')).toMatchObject({ runs: 1, passedRuns: 1 });
    expect(metricCounts(report.metrics.governanceFidelity)).toEqual([2, 2]);
    expect(metricCounts(report.metrics.governanceConsistency)).toEqual([2, 2]);
    expect(metricCounts(report.metrics.governanceMinimality)).toEqual([2, 2]);
    expect(report.governanceRunsWithoutEvent).toBe(0);

    expect(byId.get('stale-on')).toMatchObject({ runs: 2, passedRuns: 2 });
    expect(metricCounts(report.metrics.memoryStaleRate)).toEqual([2, 4]);

    const names = fs.readdirSync(recordings).sort();
    expect(names).toHaveLength(8);
    const header = JSON.parse(fs.readFileSync(path.join(recordings, 'long-on.0.transcript.jsonl'), 'utf8').split('\n')[0] ?? '{}');
    expect(header).toMatchObject({ format: 'momonga-transcript/3', datasetSeed: 7, run: { modelAlias: 'default' } });

    const callsBefore = chatCompletions(fake).length;
    const replayed = await runCli(home, ['eval', 'context', dataset, '--replay', recordings, '--model', 'fake', '--report', replayFile]);
    expect(replayed.code).toBe(1);
    expect(JSON.parse(fs.readFileSync(replayFile, 'utf8'))).toEqual(report);
    expect(chatCompletions(fake)).toHaveLength(callsBefore);

    const compared = await runCli(home, ['eval', 'compare', liveFile, replayFile]);
    expect(compared.stdout).toContain('gate: FAIL');
  });
});
