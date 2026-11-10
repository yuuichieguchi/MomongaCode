import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { titleOf } from './support/cases.ts';
import type { FakeRoute } from '@momonga/testkit';
import { CONTEXT_REPORT_FORMAT, GUIDELINE_OUTCOME_FORMAT } from '@momonga/eval';
import { runCli } from './support/cli.ts';
import { createE2eHome } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { UPSTREAM_MODEL, UPSTREAM_MODEL_REF, baseSettings, sandboxChoiceOf, startUpstream, upstreamModelRef, withStructuredRole, writeSettingsFile } from './support/stack.ts';
import { chatCompletions, textReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

const QUICK_TASK = 'Say done.';
const ANALYSIS_MODEL_ID = 'analyst';
const ANALYSIS_MODEL = upstreamModelRef(ANALYSIS_MODEL_ID);
const CASES = ['on', 'off'] as const;
const CLI_BOUND_MS = 4 * E2E_RUN_COMPLETED_BOUND_MS;

const userMessages = (body: unknown): string[] =>
  ((body as { messages?: { role?: unknown; content?: unknown }[] }).messages ?? []).filter((message) => message.role === 'user').map((message) => String(message.content));

const ROUTES: FakeRoute[] = [{ match: (body) => userMessages(body).some((text) => text.includes(QUICK_TASK)), reply: textReply('Done.') }];

const DATASET = {
  format: 'momonga-eval-context/1',
  name: 'quick',
  cases: CASES.map((compaction) => ({
    id: `quick-${compaction}`,
    scenario: 'quick',
    compaction,
    input: QUICK_TASK,
    permissionMode: 'acceptEdits',
    onAsk: 'allow_once',
    runs: 1,
    minPassRate: 1,
    rules: [],
    revisionDepth: 0,
    noise: { level: 0, topics: ['testing'] },
    graders: [{ kind: 'status', equals: 'COMPLETED' }],
  })),
};

const writeDataset = (home: E2eHome): string => {
  const file = path.join(home.root, 'quick.json');
  fs.writeFileSync(file, JSON.stringify(DATASET));
  return file;
};

const writtenModelsOf = (home: E2eHome): Record<string, unknown> => (JSON.parse(fs.readFileSync(home.paths.settingsFile, 'utf8')) as { models: Record<string, unknown> }).models;

describe('eval context and context improve with models by their own names', () => {
  it(titleOf('eval-context-own-name'), { timeout: 4 * E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const fake = await startUpstream(home, { home, routes: ROUTES });
    writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));
    expect(Object.keys(writtenModelsOf(home)).sort()).toEqual(['connections', 'start']);
    const dataset = writeDataset(home);
    const recordings = path.join(home.root, 'recordings');
    const reportFile = path.join(home.root, 'report.json');

    const ran = await runCli(home, ['eval', 'context', dataset, '--model', UPSTREAM_MODEL, '--record', recordings, '--report', reportFile], { boundMs: CLI_BOUND_MS });

    expect(ran.stderr).toBe('');
    expect(ran.stdout).toContain(`the models the runs used: ${UPSTREAM_MODEL_REF}`);
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as Record<string, unknown>;
    expect(report).toMatchObject({ format: CONTEXT_REPORT_FORMAT, model: 'fake', models: [UPSTREAM_MODEL_REF] });
    const headers = fs
      .readdirSync(recordings)
      .filter((name) => name.endsWith('.transcript.jsonl'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(recordings, name), 'utf8').split('\n')[0] ?? '{}') as { run: Record<string, unknown> });
    expect(headers).toHaveLength(CASES.length);
    for (const header of headers) {
      expect(header.run).toMatchObject({ model: UPSTREAM_MODEL_REF });
    }
    expect(chatCompletions(fake).map((request) => (request.body as { model?: unknown }).model)).toEqual(CASES.map(() => UPSTREAM_MODEL));
  });

  it(titleOf('context-improve-own-name'), { timeout: 4 * E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    await startUpstream(home, { home, routes: ROUTES });
    writeSettingsFile(home, withStructuredRole(baseSettings(home, sandboxChoiceOf({ home }).kind), 'analysis', ANALYSIS_MODEL_ID));
    expect(writtenModelsOf(home)).toMatchObject({ start: UPSTREAM_MODEL_REF, roles: { analysis: ANALYSIS_MODEL } });
    const dataset = writeDataset(home);
    const outcomeFile = path.join(home.root, 'outcome.json');

    const improved = await runCli(home, ['context', 'improve', '--dataset', dataset, '--model', UPSTREAM_MODEL_REF, '--token-cap', '1', '--seed', '7', '--outcome', outcomeFile], { boundMs: CLI_BOUND_MS });

    expect(improved.stderr).toBe('');
    expect(improved.stdout).toContain(`model: fake (derived from the pinned provenance of the models that answered the benchmark; the analysis and candidate calls used the model ${ANALYSIS_MODEL})`);
    const outcome = JSON.parse(fs.readFileSync(outcomeFile, 'utf8')) as Record<string, unknown>;
    expect(outcome).toMatchObject({ format: GUIDELINE_OUTCOME_FORMAT, model: 'fake', analysisModel: ANALYSIS_MODEL, tokenCap: 1 });
  });
});
