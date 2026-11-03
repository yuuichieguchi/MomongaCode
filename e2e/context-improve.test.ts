import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUIDELINE_ANALYSIS_INSTRUCTIONS, GUIDELINE_CANDIDATE_INSTRUCTIONS } from '@momonga/eval';
import type { FakeRoute } from '@momonga/testkit';
import { isCompactionRequest } from './support/budget.ts';
import { titleOf } from './support/cases.ts';
import { runCli } from './support/cli.ts';
import { createE2eHome } from './support/home.ts';
import { baseSettings, sandboxChoiceOf, startUpstream, writeSettingsFile } from './support/stack.ts';
import { chatCompletions, textReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

const STEPS = 14;
const FILE_LINES = 100;
const UNTRUSTED_FILE_LINES = 1200;
const FRAGILE_TASK = 'Walk fragile.txt step by step.';
const STURDY_TASKS = ['Walk first.txt step by step.', 'Walk second.txt step by step.', 'Walk third.txt step by step.'];
const WINNER = 'Always keep the word keepsake in STATE.';
const LOSER = 'Be brief.';
const KEPT = 'keepsake';
const PLAIN_SUMMARY = 'GOAL:\nwalk\nSTATE:\nwalking\nDONE:\nsome\nTODO:\nrest\nDECISIONS:\nnone\nGUARDRAILS:\nnone';
const KEEPING_SUMMARY = PLAIN_SUMMARY.replace('walking', KEPT);
const FINISHED = 'The walk is finished.';
const LOST = 'The walk lost its place.';
const CONTRASTIVE_ANALYSIS = JSON.stringify({
  divergence_step_description: 'the summary dropped the marker',
  root_cause_categories: ['Missing Critical Fact'],
  missing_or_distorted_facts: ['marker'],
  summary_inaccuracies: [],
  lost_state_variables: ['marker'],
  remediation_recommendations: ['keep the marker'],
  reliability_score: 0.9,
});

const bodyText = (body: unknown): string => JSON.stringify(body);

const workspaceOf = (body: unknown): string => {
  const match = /The working directory is (.+?) and the platform is/.exec(bodyText(body));
  if (match?.[1] === undefined) throw new Error('the system prompt does not name the working directory');
  return match[1];
};

const walkRoute = (task: string, file: string, fragile: boolean): FakeRoute => {
  const steps = new Map<string, number>();
  return {
    match: (body) => !isCompactionRequest(body) && bodyText(body).includes(task),
    reply: (body) => {
      const workspace = workspaceOf(body);
      const step = (steps.get(workspace) ?? 0) + 1;
      steps.set(workspace, step);
      if (step <= STEPS) {
        return {
          kind: 'stream',
          chunks: [
            {
              delta: {
                role: 'assistant',
                tool_calls: [{ index: 0, id: `call_${step}`, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: path.join(workspace, file), offset: step }) } }],
              },
              finishReason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      }
      const text = bodyText(body);
      const summarised = text.includes('GOAL:');
      return textReply(fragile && summarised && !text.includes(KEPT) ? LOST : FINISHED);
    },
  };
};

const candidates = (): FakeRoute => ({
  match: (body) => bodyText(body).includes(JSON.stringify(GUIDELINE_CANDIDATE_INSTRUCTIONS).slice(1, -1)),
  reply: (body) => {
    const drawn = Number(/This is candidate (\d+) of/.exec(bodyText(body))?.[1]);
    if (!Number.isInteger(drawn)) throw new Error('the candidate request does not say which candidate it is');
    return textReply(JSON.stringify({ guideline: drawn === 1 ? WINNER : `${LOSER} Variant ${drawn}.` }));
  },
});

const ROUTES: FakeRoute[] = [
  { match: (body) => isCompactionRequest(body) && bodyText(body).includes(WINNER), reply: textReply(KEEPING_SUMMARY) },
  { match: isCompactionRequest, reply: textReply(PLAIN_SUMMARY) },
  { match: (body) => bodyText(body).includes(JSON.stringify(GUIDELINE_ANALYSIS_INSTRUCTIONS).slice(1, -1)), reply: textReply(CONTRASTIVE_ANALYSIS) },
  candidates(),
  walkRoute(FRAGILE_TASK, 'fragile.txt', true),
  walkRoute(STURDY_TASKS[0] as string, 'first.txt', false),
  walkRoute(STURDY_TASKS[1] as string, 'second.txt', false),
  walkRoute(STURDY_TASKS[2] as string, 'third.txt', false),
];

const paired = (scenario: string, input: string, file: string): Record<string, unknown>[] =>
  (['on', 'off'] as const).map((compaction) => ({
    id: `${scenario}-${compaction}`,
    scenario,
    compaction,
    input,
    files: { [file]: `${'line of the walk\n'.repeat(FILE_LINES)}` },
    permissionMode: 'acceptEdits',
    onAsk: 'allow_once',
    runs: 1,
    minPassRate: 1,
    rules: [],
    revisionDepth: 0,
    noise: { level: 0, topics: ['testing'] },
    graders: [{ kind: 'finalTextIncludes', text: FINISHED }],
  }));

const DATASET = {
  format: 'momonga-eval-context/1',
  name: 'improve-e2e',
  cases: [
    ...paired('fragile', FRAGILE_TASK, 'fragile.txt'),
    ...paired('first', STURDY_TASKS[0] as string, 'first.txt'),
    ...paired('second', STURDY_TASKS[1] as string, 'second.txt'),
    ...paired('third', STURDY_TASKS[2] as string, 'third.txt'),
  ],
};

const BENCHMARKS = 1 + 5;

describe('momonga context improve', () => {
  it(titleOf('context-improve-adopt'), { timeout: 40 * E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const fake = await startUpstream(home, { home, routes: ROUTES });
    writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));
    const dataset = path.join(home.root, 'improve.json');
    fs.writeFileSync(dataset, JSON.stringify(DATASET));
    const boundMs = BENCHMARKS * DATASET.cases.length * E2E_RUN_COMPLETED_BOUND_MS;
    const options = { boundMs, cwd: home.project };

    const declaredFake = await runCli(home, ['context', 'improve', '--dataset', dataset, '--model', 'fake', '--alias', 'default', '--seed', '7', '--adopt'], options);
    expect(declaredFake.code).not.toBe(0);
    expect(declaredFake.stdout).toContain('model: fake');
    expect(declaredFake.stdout).toMatch(/nothing was adopted/i);
    const none = await runCli(home, ['context', 'guideline', 'list'], options);
    expect(none.stdout).not.toContain(WINNER);

    const preview = await runCli(home, ['context', 'improve', '--dataset', dataset, '--model', 'real', '--alias', 'default', '--seed', '7'], options);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain(`+ ${WINNER}`);
    expect((await runCli(home, ['context', 'guideline', 'list'], options)).stdout).not.toContain(WINNER);

    const adopted = await runCli(home, ['context', 'improve', '--dataset', dataset, '--model', 'real', '--alias', 'default', '--seed', '7', '--adopt'], options);
    expect(adopted.code).toBe(0);
    expect(adopted.stdout).toContain('model: real');
    expect(adopted.stdout).toMatch(/declared by the operator/);
    expect(adopted.stdout).toContain('gate: PASS');
    expect(adopted.stdout).toContain('adopted version 1');

    const listed = await runCli(home, ['context', 'guideline', 'list'], options);
    expect(listed.stdout).toContain(WINNER);

    const cost = JSON.parse((await runCli(home, ['cost', '--json'], options)).stdout);
    expect(cost.contextCharges.charges.length).toBeGreaterThan(0);
    expect(cost.contextCharges.charges.every((charge: { purpose: string; project: string }) => charge.purpose === 'guideline' && charge.project === home.project)).toBe(true);
    expect(cost.contextCharges.totalTokens).toBeGreaterThan(0);

    fs.writeFileSync(path.join(home.project, 'fragile.txt'), 'line of the walk\n'.repeat(UNTRUSTED_FILE_LINES));
    const before = chatCompletions(fake).length;
    const following = await runCli(home, ['-p', FRAGILE_TASK, '--output-format', 'stream-json'], options);
    expect(following.code).toBe(0);
    const compactions = chatCompletions(fake).slice(before).filter((call) => isCompactionRequest(call.body));
    expect(compactions.length).toBeGreaterThanOrEqual(1);
    expect(compactions.every((call) => bodyText(call.body).includes(WINNER))).toBe(true);
    const compacted = following.stdout
      .split('\n')
      .filter((line) => line.includes('context.compacted'))
      .map((line) => JSON.parse(line) as { guidelineVersion?: number });
    expect(compacted.length).toBeGreaterThanOrEqual(1);
    expect(compacted.every((event) => event.guidelineVersion === 1)).toBe(true);

    const rolledBack = await runCli(home, ['context', 'guideline', 'rollback', '1'], options);
    expect(rolledBack.code).toBe(0);
    expect((await runCli(home, ['context', 'guideline', 'list'], options)).stdout).toMatch(/\b2\b/);
  });
});
