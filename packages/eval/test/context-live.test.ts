import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import {
  CONTEXT_DATASET_FORMAT,
  EvalError,
  applyWorkspaceStep,
  buildContextReport,
  caseSettingsFor,
  compareContextReports,
  datasetDigestOf,
  decodeTranscript,
  encodeContextReport,
  encodeTranscript,
  expandContextDataset,
  formatContextReport,
  liveBoundsFor,
  parseContextDataset,
  parseContextReport,
  runContextDataset,
} from '@momonga/eval';
import type { EvalRunApi, Transcript } from '@momonga/eval';
import type { PublicRunEvent } from '@momonga/protocol';
import { publicEventsOf } from './fixtures.ts';
import { RECORDED_IDENTITY } from './fixtures.ts';
import { compacted, contextCase, fidelity, governing, recorded } from './context-fixtures.ts';

const pair = (scenario: string, extra: Record<string, unknown> = {}) => [
  { ...contextCase(`${scenario}-on`, scenario, 'on'), ...extra },
  { ...contextCase(`${scenario}-off`, scenario, 'off'), ...extra },
];

const datasetOf = (cases: unknown[]) => parseContextDataset(JSON.stringify({ format: CONTEXT_DATASET_FORMAT, name: 'live', cases }), 'live.json');

type Script = { tokens?: number; hang?: boolean; events?: (caseCwd: string) => PublicRunEvent[] };

const NEVER = (_caseId: string, signal: AbortSignal): Promise<void> =>
  new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const harness = (script: Script = {}) => {
  const log: string[] = [];
  const sessions: Record<string, unknown>[] = [];
  const addedRules: Record<string, any>[] = [];
  const retired: string[] = [];
  const memories: unknown[] = [];
  const inputs: string[] = [];
  const cancelled: string[] = [];
  let runCounter = 0;
  const release: (() => void)[] = [];
  const openCase = async (entry: { id: string }) => {
    log.push(`open ${entry.id}`);
    const cwd = `/w/${entry.id}`;
    const api: EvalRunApi = {
      createSession: async (input) => {
        sessions.push(input);
        return { id: `s-${entry.id}` };
      },
      createRun: async (_sessionId, input) => {
        runCounter += 1;
        inputs.push(input.input);
        log.push(`run ${input.input}`);
        return { id: `r${runCounter}` };
      },
      events: async function* () {
        if (script.hang === true) await new Promise<void>((resolve) => release.push(resolve));
        for (const event of script.events?.(cwd) ?? []) yield event;
      },
      reflectionOf: async () => ({ state: 'none' }),
      getRun: async (runId) => ({ id: runId, status: 'COMPLETED', step: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: script.tokens ?? 10 }, modelAlias: 'gamma' }),
      resolveApproval: async () => undefined,
      cancelRun: async (runId) => {
        cancelled.push(runId);
        for (const resolve of release) resolve();
      },
    };
    return {
      cwd,
      api,
      rules: {
        add: async (request: Record<string, any>) => {
          addedRules.push(request);
          log.push(`rule ${request['text']}`);
          return { fact: { id: `fact-${addedRules.length}` } };
        },
        retire: async (id: string) => void retired.push(id),
      },
      seedMemory: async (memory: unknown) => {
        memories.push(memory);
        log.push('memory');
      },
      applyStep: async (step: { beforeRun: number }) => void log.push(`step ${step.beforeRun}`),
      close: async () => void log.push(`close ${entry.id}`),
    };
  };
  return { log, sessions, addedRules, retired, memories, inputs, cancelled, ports: { ...RECORDED_IDENTITY, openCase, modelAlias: 'gamma', deadline: NEVER, bounds: { datasetTokens: 1_000_000, caseDeadlineMs: {} } } };
};

const rule = (id: string, text: string, overrides: Record<string, unknown> = {}) => ({ id, kind: 'constraint', target: 'test-runner', text, inScope: true, live: true, supersedes: [], ...overrides });

describe('expandContextDataset', () => {
  const noisy = () => datasetOf(pair('a', { noise: { level: 3, topics: ['testing', 'logging'] } }));

  it('gives the same bytes for the same seed', () => {
    expect(canonicalJson(expandContextDataset(noisy(), 7))).toBe(canonicalJson(expandContextDataset(noisy(), 7)));
  });

  it('gives different noise for a different seed', () => {
    const noiseOf = (seed: number) => expandContextDataset(noisy(), seed).cases[0]?.noiseTurns;
    expect(new Set([1, 2, 3, 4, 5, 6].map((seed) => JSON.stringify(noiseOf(seed)))).size).toBeGreaterThan(1);
  });

  it('plays as many noise turns as the level asks, identical in both cases of a pair', () => {
    const [on, off] = expandContextDataset(noisy(), 7).cases;
    expect(on?.noiseTurns).toHaveLength(3);
    expect(on?.noiseTurns).toEqual(off?.noiseTurns);
  });

  it('builds a revision chain from the depth, each rule superseding the one before', () => {
    const dataset = datasetOf(pair('a', { revisionDepth: 2, revisionChain: { id: 'runner', kind: 'constraint', target: 'test-runner', text: 'Use runner {revision}.' } }));
    expect(expandContextDataset(dataset, 7).cases[0]?.rules).toEqual([
      { id: 'runner-0', kind: 'constraint', target: 'test-runner', text: 'Use runner 0.', inScope: true, live: true, supersedes: [] },
      { id: 'runner-1', kind: 'constraint', target: 'test-runner', text: 'Use runner 1.', inScope: true, live: true, supersedes: ['runner-0'] },
      { id: 'runner-2', kind: 'constraint', target: 'test-runner', text: 'Use runner 2.', inScope: true, live: true, supersedes: ['runner-1'] },
    ]);
  });

  it('refuses a pair that differs in its memories', () => {
    const [on, off] = pair('a');
    expect(() => datasetOf([{ ...on, memories: [{ text: 'a note', paths: [] }] }, { ...off, memories: [] }])).toThrow(/differ in memories/);
  });

  it('refuses a memory path outside the case workspace', () => {
    expect(() => datasetOf(pair('a', { memories: [{ text: 'a note', paths: ['../x'] }] }))).toThrow(/inside the workspace/);
  });
});

describe('the dataset digest', () => {
  it('is the hash of the canonical expansion', () => {
    const dataset = datasetOf(pair('a', { noise: { level: 2, topics: ['testing'] } }));
    expect(datasetDigestOf(dataset, 7)).toBe(sha256Hex(canonicalJson(expandContextDataset(dataset, 7))));
  });

  it('changes with the seed', () => {
    const dataset = datasetOf(pair('a', { noise: { level: 2, topics: ['testing', 'logging'] } }));
    expect(datasetDigestOf(dataset, 7)).not.toBe(datasetDigestOf(dataset, 8));
  });
});

describe('runContextDataset', () => {
  it('opens one host per case and closes it', async () => {
    const context = harness();
    await runContextDataset(expandContextDataset(datasetOf(pair('a')), 1), context.ports);
    expect(context.log).toEqual(['open a-on', 'run work on a', 'close a-on', 'open a-off', 'run work on a', 'close a-off']);
  });

  it('pins the alias on every session', async () => {
    const context = harness();
    await runContextDataset(expandContextDataset(datasetOf(pair('a')), 1), context.ports);
    expect(context.sessions.map((session) => session['modelAlias'])).toEqual(['gamma', 'gamma']);
    expect(context.sessions.map((session) => session['cwd'])).toEqual(['/w/a-on', '/w/a-off']);
  });

  it('applies a workspace step between the runs of a case, not before the first', async () => {
    const context = harness();
    const cases = pair('a', { runs: 2, workspace: [{ beforeRun: 1, write: { 'config.ts': '20' } }] });
    await runContextDataset(expandContextDataset(datasetOf(cases), 1), context.ports);
    expect(context.log.slice(0, 5)).toEqual(['open a-on', 'run work on a', 'step 1', 'run work on a', 'close a-on']);
  });

  it('adds rules so that a superseded one exists first, mapping dataset ids to the ids the product gave', async () => {
    const context = harness();
    const rules = [rule('late', 'Use vitest.', { supersedes: ['early'] }), rule('early', 'Use jest.')];
    await runContextDataset(expandContextDataset(datasetOf(pair('a', { rules, revisionDepth: 1 })), 1), context.ports);
    const firstCase = context.addedRules.slice(0, 2);
    expect(firstCase.map((request) => [request['text'], request['supersedes']])).toEqual([
      ['Use jest.', []],
      ['Use vitest.', ['fact-1']],
    ]);
    expect(firstCase[0]?.['scope']).toEqual({ level: 'project', project: '/w/a-on', paths: [] });
  });

  it('retires a rule that is not live and scopes an out-of-scope rule away from the case', async () => {
    const context = harness();
    const rules = [rule('dead', 'Use jest.', { live: false, target: 'old-runner' }), rule('elsewhere', 'Use tabs.', { inScope: false, target: 'style' })];
    await runContextDataset(expandContextDataset(datasetOf(pair('a', { rules })), 1), context.ports);
    expect(context.retired[0]).toBe('fact-1');
    const scope = context.addedRules[1]?.['scope'];
    expect(scope).toMatchObject({ level: 'project', project: '/w/a-on' });
    expect(scope.paths.length).toBeGreaterThan(0);
  });

  it('records which product id stands for which dataset rule in the transcript', async () => {
    const context = harness();
    const stored: Transcript[] = [];
    await runContextDataset(expandContextDataset(datasetOf(pair('a', { rules: [rule('only', 'Use vitest.')] })), 1), { ...context.ports, onTranscript: async (transcript: Transcript) => void stored.push(transcript) });
    expect(stored[0]?.ruleIds).toEqual({ 'fact-1': 'only' });
  });

  it('seeds memories after the rules and before the first run, once per case', async () => {
    const context = harness();
    await runContextDataset(expandContextDataset(datasetOf(pair('a', { runs: 2, memories: [{ text: 'LIMIT is 10', paths: ['config.ts'] }] })), 1), context.ports);
    expect(context.memories).toEqual([{ text: 'LIMIT is 10', paths: ['config.ts'] }, { text: 'LIMIT is 10', paths: ['config.ts'] }]);
    expect(context.log.slice(0, 3)).toEqual(['open a-on', 'memory', 'run work on a']);
  });

  it('plays the noise before the task in the same case', async () => {
    const context = harness();
    const expanded = expandContextDataset(datasetOf(pair('a', { noise: { level: 2, topics: ['testing'] } })), 1);
    await runContextDataset(expanded, context.ports);
    const noise = (expanded.cases[0]?.noiseTurns ?? []).map((turn) => turn.user);
    expect(context.inputs.slice(0, 3)).toEqual([...noise, 'work on a']);
  });

  it('keeps the noise runs out of the transcripts', async () => {
    const context = harness();
    const { transcripts } = await runContextDataset(expandContextDataset(datasetOf(pair('a', { noise: { level: 2, topics: ['testing'] } })), 1), context.ports);
    expect(transcripts.map((transcript) => [transcript.caseId, transcript.runIndex])).toEqual([
      ['a-on', 0],
      ['a-off', 0],
    ]);
  });

  it('records the seed in each transcript', async () => {
    const context = harness();
    const { transcripts } = await runContextDataset(expandContextDataset(datasetOf(pair('a')), 42), context.ports);
    expect(transcripts.map((transcript) => transcript.datasetSeed)).toEqual([42, 42]);
  });

  it('refuses the report of an off case whose run holds a compaction', async () => {
    const events = publicEventsOf([compacted(1, 'model', fidelity([], 1, 1))]);
    const context = harness({ events: (cwd) => (cwd.endsWith('-off') ? events : []) });
    const dataset = datasetOf(pair('a'));
    const { transcripts } = await runContextDataset(expandContextDataset(dataset, 1), context.ports);
    expect(() => buildContextReport({ dataset, transcripts, model: 'fake', seed: 1, datasetSeed: 1 })).toThrow(EvalError);
  });
});

describe('the bounds of a live run', () => {
  it('derives a deadline per case and a token cap for the dataset', () => {
    const dataset = datasetOf([...pair('a', { runs: 2, timeoutMs: 1000 }), ...pair('b')]);
    expect(liveBoundsFor(dataset, { maxTotalTokens: 100, defaultTimeoutMs: 5000 })).toEqual({
      datasetTokens: 600,
      caseDeadlineMs: { 'a-on': 2000, 'a-off': 2000, 'b-on': 5000, 'b-off': 5000 },
    });
  });

  it('cancels a case past its deadline and reports it failed, by name, inside n', async () => {
    const context = harness({ hang: true });
    const dataset = datasetOf(pair('a'));
    const { transcripts } = await runContextDataset(expandContextDataset(dataset, 1), { ...context.ports, deadline: async () => undefined });
    expect(context.cancelled).toEqual(['r1', 'r2']);
    const report = buildContextReport({ dataset, transcripts, model: 'fake', seed: 1, datasetSeed: 1 });
    expect(report.cases.map((entry) => [entry.id, entry.runs, entry.passedRuns])).toEqual([
      ['a-on', 1, 0],
      ['a-off', 1, 0],
    ]);
    expect(report.stopped).toEqual([
      { caseId: 'a-on', runIndex: 0, reason: expect.stringContaining('deadline') },
      { caseId: 'a-off', runIndex: 0, reason: expect.stringContaining('deadline') },
    ]);
    expect(report.passed).toBe(false);
    expect(formatContextReport(report)).toContain('stopped a-on run 0');
  });

  it('stops the dataset at the cost cap and still reports every remaining case as failed', async () => {
    const context = harness({ tokens: 60 });
    const dataset = datasetOf([...pair('a'), ...pair('b')]);
    const { transcripts } = await runContextDataset(expandContextDataset(dataset, 1), { ...context.ports, bounds: { datasetTokens: 100, caseDeadlineMs: {} } });
    expect(context.inputs).toEqual(['work on a', 'work on a']);
    const report = buildContextReport({ dataset, transcripts, model: 'fake', seed: 1, datasetSeed: 1 });
    expect(report.cases.map((entry) => entry.runs)).toEqual([1, 1, 1, 1]);
    expect(report.stopped).toEqual([
      { caseId: 'b-on', runIndex: 0, reason: expect.stringContaining('cost cap') },
      { caseId: 'b-off', runIndex: 0, reason: expect.stringContaining('cost cap') },
    ]);
  });
});

describe('caseSettingsFor', () => {
  const base = { models: { aliases: { gamma: ['t'] } }, sandbox: 'none', context: { adaptiveBudget: true } };

  it.each([
    ['on', true],
    ['off', false],
  ] as const)('sets context.autoCompact for a case with compaction %s and keeps the rest', (compaction, autoCompact) => {
    expect(caseSettingsFor(base, { compaction })).toEqual({ ...base, context: { adaptiveBudget: true, autoCompact } });
  });

  it('overrides a value the operator set', () => {
    expect(caseSettingsFor({ context: { autoCompact: true } }, { compaction: 'off' })).toEqual({ context: { autoCompact: false } });
  });
});

describe('applyWorkspaceStep', () => {
  const roots: string[] = [];
  const temporary = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-eval-test-'));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes and removes files of the case workspace', async () => {
    const root = temporary();
    fs.writeFileSync(path.join(root, 'old.ts'), 'old');
    await applyWorkspaceStep(root, { beforeRun: 1, write: { 'src/new.ts': 'new' }, remove: ['old.ts'] });
    expect(fs.readFileSync(path.join(root, 'src/new.ts'), 'utf8')).toBe('new');
    expect(fs.existsSync(path.join(root, 'old.ts'))).toBe(false);
  });

  it('refuses a write through a symlink that leaves the workspace', async () => {
    const root = temporary();
    const outside = temporary();
    fs.symlinkSync(outside, path.join(root, 'link'));
    await expect(applyWorkspaceStep(root, { beforeRun: 1, write: { 'link/x.ts': 'x' } })).rejects.toThrow(EvalError);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses to remove through a symlink that leaves the workspace', async () => {
    const root = temporary();
    const outside = temporary();
    fs.writeFileSync(path.join(outside, 'keep.ts'), 'keep');
    fs.symlinkSync(outside, path.join(root, 'link'));
    await expect(applyWorkspaceStep(root, { beforeRun: 1, remove: ['link/keep.ts'] })).rejects.toThrow(EvalError);
    expect(fs.existsSync(path.join(outside, 'keep.ts'))).toBe(true);
  });
});

describe('transcripts of a live run', () => {
  const live = (): Transcript => ({ ...recorded('a-on', 0, [governing('fact-1')], { modelAlias: 'gamma' }), ruleIds: { 'fact-1': 'only' }, datasetSeed: 7, stopped: 'past the deadline' });

  it('keeps the rule map, the seed and the stop reason through the file format', () => {
    const decoded = decodeTranscript(encodeTranscript(live()), 'x');
    expect(decoded.ruleIds).toEqual({ 'fact-1': 'only' });
    expect(decoded.datasetSeed).toBe(7);
    expect(decoded.stopped).toBe('past the deadline');
    expect(decoded.run.modelAlias).toBe('gamma');
  });

  it('reads a governing load through the rule map', () => {
    const dataset = datasetOf(pair('a', { rules: [rule('only', 'Use vitest.')] }));
    const transcripts = [live(), { ...recorded('a-off', 0, [governing('fact-9')]), ruleIds: { 'fact-9': 'only' } }];
    const report = buildContextReport({ dataset, transcripts, model: 'fake', seed: 1, datasetSeed: 7 });
    expect(report.metrics.governanceFidelity).toMatchObject({ successes: 2, trials: 2 });
    expect(report.metrics.governanceConsistency).toMatchObject({ successes: 2, trials: 2 });
  });
});

describe('reports of live runs', () => {
  const scenarios = ['a', 'b', 'c', 'd'];
  const dataset = () => datasetOf(scenarios.flatMap((scenario) => pair(scenario)));
  const transcripts = () => scenarios.flatMap((scenario) => [recorded(`${scenario}-on`, 0, [compacted(1, 'model', fidelity([], 1, 1))]), recorded(`${scenario}-off`, 0, [])]);
  const reportWith = (datasetSeed: number) => buildContextReport({ dataset: dataset(), transcripts: transcripts(), model: 'real', seed: 1, datasetSeed });

  it('states the dataset seed', () => {
    expect(reportWith(7).datasetSeed).toBe(7);
  });

  it('keeps the seed and the stopped list through the file format', () => {
    const parsed = parseContextReport(encodeContextReport(reportWith(7)), 'x');
    expect(parsed.datasetSeed).toBe(7);
    expect(parsed.stopped).toEqual([]);
  });

  it('refuses a stored report without a seed', () => {
    const { datasetSeed: _unused, ...bare } = reportWith(7);
    expect(() => parseContextReport(JSON.stringify(bare), 'x')).toThrow(/not a context report/);
  });

  it('compares two reports of one expansion', () => {
    expect(compareContextReports(reportWith(7), reportWith(7), { seed: 1 }).gate.checks.map((check) => check.name)).toContain('real_model');
    expect(reportWith(7).datasetDigest).toBe(sha256Hex(canonicalJson(expandContextDataset(dataset(), 7))));
  });

  it('refuses reports of different expansions', () => {
    expect(() => compareContextReports(reportWith(7), reportWith(8), { seed: 1 })).toThrow(/digests differ/);
  });
});
