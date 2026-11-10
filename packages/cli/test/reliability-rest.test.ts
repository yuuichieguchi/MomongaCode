import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { GATE_NAMES, treeDigest } from '@momonga/eval';
import { REPORT_PAGE_ROWS, REVIEW_SAMPLE_SIZE } from '@momonga/protocol';
import type { RunCallView } from '@momonga/protocol';

type Review = { runId: string; callId: string; label: string; reviewedAt: number };
type ReviewPage = { calls: RunCallView[]; reviews: Review[]; nextCursor: string | null };
type ReviewClient = {
  reportReviews(request: { cursor: string | null; limit: number }): Promise<ReviewPage>;
  storeReview(request: { runId: string; callId: string; label: string }): Promise<Review>;
};
type ReviewCommand = {
  reviewSampleText(client: Pick<ReviewClient, 'reportReviews'>, options: { size: number; seed: string }): Promise<string>;
  storeReviewText(client: Pick<ReviewClient, 'storeReview'>, request: { runId: string; callId: string; label: string }): Promise<string>;
};
type Body = { id: number; spanId: string; kind: string; content: string; createdAtMs: number; expiresAtMs: number };
type ContentSource = { name: string; page(runId: string, after: number, limit: number): Promise<{ bodies: Body[]; next: number | null }> };
type TraceCommand = { writeTraceContent(sources: readonly ContentSource[], runId: string, json: boolean, write: (text: string) => void): Promise<void> };
type Probe = {
  run(command: string, timeoutMs: number, cwd: string): Promise<{ exitCode: number | null; timedOut: boolean }>;
  digest(cwd: string, paths: readonly string[]): Promise<string>;
  changedPaths(cwd: string, baseDir: string): Promise<string[]>;
};
type BenchCommand = {
  evaluateBench(ports: unknown, paths: unknown, directory: string, options: { validate: boolean; model?: string; report?: string }): Promise<number>;
};

const load = async <T>(name: string): Promise<T> => (await import('../src/' + name)) as T;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cli-bench-'));
  dirs.push(dir);
  return dir;
};

const call = (index: number, overrides: Partial<RunCallView>): RunCallView => ({ runId: 'run-1', callId: `call-${String(index).padStart(3, '0')}`, basis: 'rule', sideEffect: 'write', asked: false, ...overrides });

const pagedReviews = (calls: readonly RunCallView[], reviews: readonly Review[], pageSize: number) => {
  const requests: { cursor: string | null; limit: number }[] = [];
  const client: Pick<ReviewClient, 'reportReviews'> = {
    reportReviews: async (request) => {
      requests.push(request);
      const start = request.cursor === null ? 0 : Number(request.cursor);
      const shown = calls.slice(start, start + pageSize);
      const keys = new Set(shown.map((entry) => `${entry.runId}/${entry.callId}`));
      return { calls: shown, reviews: reviews.filter((review) => keys.has(`${review.runId}/${review.callId}`)), nextCursor: start + pageSize < calls.length ? String(start + pageSize) : null };
    },
  };
  return { client, requests };
};

describe('momonga permissions review --sample', () => {
  const calls = [
    ...Array.from({ length: 5 }, (_unused, index) => call(index, {})),
    ...Array.from({ length: 4 }, (_unused, index) => call(100 + index, { basis: 'person', asked: true })),
    call(200, { basis: 'read_only', sideEffect: 'read_only' }),
  ];
  const reviews: Review[] = [
    { runId: 'run-1', callId: 'call-000', label: 'missed_ask', reviewedAt: 1 },
    { runId: 'run-1', callId: 'call-001', label: 'correct', reviewedAt: 2 },
    { runId: 'run-1', callId: 'call-100', label: 'unneeded_ask', reviewedAt: 3 },
  ];

  it('folds every page of /v1/report/reviews and lists the same sample for the same seed, another for another seed', async () => {
    const { reviewSampleText } = await load<ReviewCommand>('commands/review.ts');
    const { client, requests } = pagedReviews(calls, reviews, 4);
    const first = await reviewSampleText(client, { size: 2, seed: 'seed-a' });
    expect(requests).toEqual([
      { cursor: null, limit: REPORT_PAGE_ROWS },
      { cursor: '4', limit: REPORT_PAGE_ROWS },
      { cursor: '8', limit: REPORT_PAGE_ROWS },
    ]);
    expect(await reviewSampleText(pagedReviews(calls, reviews, 3).client, { size: 2, seed: 'seed-a' })).toBe(first);
    const seeds = await Promise.all(['seed-b', 'seed-c', 'seed-d', 'seed-e'].map((seed) => reviewSampleText(client, { size: 2, seed })));
    expect(seeds.some((text) => text !== first)).toBe(true);
  });

  it('draws the size from each of the two denominators, shows the label of a reviewed call, and prints the two rates with the reviewed number, the frame and the sentence about the sample', async () => {
    const { reviewSampleText } = await load<ReviewCommand>('commands/review.ts');
    const text = await reviewSampleText(pagedReviews(calls, reviews, 4).client, { size: 3, seed: 'seed-a' });
    const lines = text.split('\n');
    expect(lines).toContain('Calls allowed without a person that have a side effect: 3 drawn of 5');
    expect(lines).toContain('Asks: 3 drawn of 4');
    expect(lines.filter((line) => line.startsWith('  run-1 call-0'))).toHaveLength(3);
    expect(lines.filter((line) => line.startsWith('  run-1 call-1'))).toHaveLength(3);
    expect(text).not.toContain('call-200');
    expect(lines).toContain('missed_ask: 1/2 of the reviewed calls allowed without a person that have a side effect (frame 5)');
    expect(lines).toContain('unneeded_ask: 1/1 of the reviewed asks (frame 4)');
    expect(lines).toContain('These rates describe the reviewed calls, not every call of the record.');
    expect(text).toMatch(/call-\d+ .*(not reviewed|missed_ask|correct|unneeded_ask)/);
  });

  it('the default sample size is the 73 of decision 54', () => {
    expect(REVIEW_SAMPLE_SIZE).toBe(73);
  });
});

describe('momonga permissions review <run> --call --label', () => {
  it('stores the label through the client and says what was stored', async () => {
    const { storeReviewText } = await load<ReviewCommand>('commands/review.ts');
    const stored: unknown[] = [];
    const text = await storeReviewText(
      {
        storeReview: async (request) => {
          stored.push(request);
          return { ...request, reviewedAt: 5 };
        },
      },
      { runId: 'run-1', callId: 'call-1', label: 'missed_ask' },
    );
    expect(stored).toEqual([{ runId: 'run-1', callId: 'call-1', label: 'missed_ask' }]);
    expect(text).toBe('Stored the label missed_ask for call call-1 of run run-1.\n');
  });

  it('refuses a label outside the three before any request', async () => {
    const { storeReviewText } = await load<ReviewCommand>('commands/review.ts');
    const client = { storeReview: async (): Promise<Review> => Promise.reject(new Error('must not be called')) };
    await expect(storeReviewText(client, { runId: 'run-1', callId: 'call-1', label: 'wrong' })).rejects.toThrow(/correct, unneeded_ask or missed_ask/);
  });
});

describe('momonga trace --content', () => {
  const body = (id: number, content: string): Body => ({ id, spanId: `span-${id}`, kind: 'gen_ai.input.messages', content, createdAtMs: 0, expiresAtMs: Date.UTC(2026, 11, 1) });
  const source = (name: string, bodies: readonly Body[]) => {
    const asked: number[] = [];
    const content: ContentSource = {
      name,
      page: async (_runId, after, limit) => {
        asked.push(after);
        const rest = bodies.filter((entry) => entry.id > after);
        const shown = rest.slice(0, Math.min(limit, 2));
        return { bodies: shown, next: rest.length > shown.length ? (shown.at(-1) as Body).id : null };
      },
    };
    return { content, asked };
  };

  it('follows the cursor of every store to the end and prints each body under a line that names its store, span, kind and expiry', async () => {
    const { writeTraceContent } = await load<TraceCommand>('commands/trace.ts');
    const runtime = source('runtime', [body(1, 'tool arguments'), body(2, 'tool result'), body(3, 'more')]);
    const gateway = source('gateway', [body(7, 'the messages')]);
    const out: string[] = [];
    await writeTraceContent([runtime.content, gateway.content], 'run-1', false, (text) => out.push(text));
    const text = out.join('');
    expect(runtime.asked).toEqual([0, 2]);
    expect(gateway.asked).toEqual([0]);
    expect(text).toContain('runtime body 1  span span-1  gen_ai.input.messages  expires 2026-12-01T00:00:00.000Z\ntool arguments\n');
    expect(text).toContain('gateway body 7  span span-7  gen_ai.input.messages  expires 2026-12-01T00:00:00.000Z\nthe messages\n');
    expect(text.indexOf('more')).toBeLessThan(text.indexOf('the messages'));
  });

  it('says so when no body of the run is stored, and prints one JSON object per body with --json', async () => {
    const { writeTraceContent } = await load<TraceCommand>('commands/trace.ts');
    const out: string[] = [];
    await writeTraceContent([source('runtime', []).content], 'run-1', false, (text) => out.push(text));
    expect(out.join('')).toBe('No stored content for run run-1: message content is stored only while telemetry.captureMessageContent is on, and each body is removed when it expires.\n');
    const json: string[] = [];
    await writeTraceContent([source('gateway', [body(7, 'the messages')]).content], 'run-1', true, (text) => json.push(text));
    expect(json.join('').trim().split('\n').map((line) => JSON.parse(line))).toEqual([{ store: 'gateway', ...body(7, 'the messages') }]);
  });
});

describe('momonga eval bench --validate', () => {
  const BUGGY = 'exports.add = (a, b) => a - b;\n';
  const FIXED = 'exports.add = (a, b) => a + b;\n';
  const TEST = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/add.js');\ntest('adds', () => assert.strictEqual(add(2, 3), 5));\n";

  const benchmark = async (repositorySource: string): Promise<string> => {
    const dir = tempDir();
    const write = (relative: string, content: string): void => {
      fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
      fs.writeFileSync(path.join(dir, relative), content);
    };
    write('repos/fix/src/add.js', repositorySource);
    write('repos/fix/test/add.test.js', TEST);
    write('solutions/fix/src/add.js', FIXED);
    write(
      'benchmark.json',
      JSON.stringify({
        format: 'momonga-bench/1',
        name: 'fixture',
        repositories: { fix: { directory: 'repos/fix', digest: await treeDigest(path.join(dir, 'repos/fix')) } },
        tasks: [
          {
            id: 'fix',
            repository: 'fix',
            taskType: 'bug_fix',
            difficulty: 'easy',
            labelledBy: 'fixture',
            labelledAt: '2026-11-06',
            prompt: 'Fix add.',
            permissionMode: 'acceptEdits',
            onAsk: 'allow_once',
            budget: { maxSteps: 10, maxTotalTokens: 100000, timeoutMs: 60000 },
            setup: [],
            graderFiles: {},
            declaration: [],
            oracle: [
              { id: 'tests', kind: 'command', run: 'node --test', expectExit: 0, evidence: 'unit', timeoutMs: 30000 },
              { id: 'scope', kind: 'changedPathsWithin', paths: ['src/'] },
            ],
            reference: { directory: 'solutions/fix' },
          },
        ],
      }),
    );
    return dir;
  };

  const portsOf = async (cwd: string) => {
    const { createWorkspaceProbe } = await load<{ createWorkspaceProbe(env: Readonly<Record<string, string>>): Probe }>('node-ports.ts');
    const out: string[] = [];
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    return { ports: { cwd, stdout: { write: (text: string) => out.push(text) }, probe: createWorkspaceProbe(env) }, out };
  };

  it('exits 0 and names every task as valid when each fails first and passes with its reference, without a model or a daemon', async () => {
    const { evaluateBench } = await load<BenchCommand>('commands/bench.ts');
    const dir = await benchmark(BUGGY);
    const { ports, out } = await portsOf(path.dirname(dir));
    expect(await evaluateBench(ports, undefined, path.basename(dir), { validate: true })).toBe(0);
    expect(out.join('')).toBe('Task fix: valid; labelled easy by fixture on 2026-11-06; the reference changes 1 file, 1 line added and 1 removed\nThe benchmark fixture is valid: 1 task.\n');
  });

  it('exits 1 and says what is wrong with a task that already passes', async () => {
    const { evaluateBench } = await load<BenchCommand>('commands/bench.ts');
    const dir = await benchmark(FIXED);
    const { ports, out } = await portsOf(dir);
    expect(await evaluateBench(ports, undefined, dir, { validate: true })).toBe(1);
    expect(out.join('')).toBe('Task fix: the oracle already passes on the initial repository; labelled easy by fixture on 2026-11-06; the reference changes 0 files, 0 lines added and 0 removed\nThe benchmark fixture is not valid: 1 of 1 task has a problem.\n');
  });

  it('a run needs --model, and --validate takes none', async () => {
    const { evaluateBench } = await load<BenchCommand>('commands/bench.ts');
    const dir = await benchmark(BUGGY);
    const { ports } = await portsOf(dir);
    await expect(evaluateBench(ports, undefined, dir, { validate: false })).rejects.toThrow(/--model <model> is required/);
    await expect(evaluateBench(ports, undefined, dir, { validate: true, model: 'fake/system' })).rejects.toThrow(/--validate runs no model/);
  });

  it('the probe reports a command that outlives its time as timed out, and the paths that differ from a base', async () => {
    const dir = await benchmark(BUGGY);
    const { ports } = await portsOf(dir);
    const repository = path.join(dir, 'repos/fix');
    const solved = path.join(dir, 'solutions/fix');
    expect(await ports.probe.run('exit 4', 5000, repository)).toEqual({ exitCode: 4, timedOut: false });
    expect((await ports.probe.run('sleep 30', 200, repository)).timedOut).toBe(true);
    expect(await ports.probe.changedPaths(solved, repository)).toEqual(['src/add.js', 'test/add.test.js']);
    expect(await ports.probe.digest(repository, ['src/add.js'])).not.toBe(await ports.probe.digest(solved, ['src/add.js']));
    expect(await ports.probe.digest(repository, ['missing.js'])).toBe(await ports.probe.digest(solved, ['missing.js']));
  });
});

describe('the commands of the reliability report are registered', () => {
  const program = async (): Promise<Command> => {
    const { registerProductCommands } = await load<{ registerProductCommands(program: Command, deps: unknown): void }>('commands/register.ts');
    const root = new Command();
    registerProductCommands(root, { ports: {}, complete: () => undefined, interrupt: new AbortController().signal });
    return root;
  };
  const sub = (parent: Command, name: string): Command => {
    const found = parent.commands.find((command) => command.name() === name);
    if (found === undefined) throw new Error(`no command ${name} under ${parent.name()}`);
    return found;
  };
  const flags = (command: Command): string[] => command.options.map((option) => option.long ?? '');

  it('eval bench takes a directory, --validate, --model and --report', async () => {
    const bench = sub(sub(await program(), 'eval'), 'bench');
    expect(bench.registeredArguments.map((argument) => argument.name())).toEqual(['directory']);
    expect(flags(bench)).toEqual(expect.arrayContaining(['--validate', '--model', '--report']));
  });

  it('reliability takes --days, 30 when it is not given, and refuses a number that is not a positive integer', async () => {
    const reliability = sub(await program(), 'reliability');
    const days = reliability.options.find((option) => option.long === '--days');
    expect(days?.defaultValue).toBe(30);
    expect(days?.parseArg?.('7', 30)).toBe(7);
    for (const wrong of ['0', '-1', '1.5', 'week']) expect(() => days?.parseArg?.(wrong, 30)).toThrow();
  });

  it('permissions review takes an optional run, --sample, --seed, --call and --label', async () => {
    const review = sub(sub(await program(), 'permissions'), 'review');
    expect(review.registeredArguments.map((argument) => [argument.name(), argument.required])).toEqual([['run', false]]);
    expect(flags(review)).toEqual(expect.arrayContaining(['--sample', '--seed', '--call', '--label']));
  });

  it('the help of eval compare --gate names every gate', async () => {
    const compare = sub(sub(await program(), 'eval'), 'compare');
    const gate = compare.options.find((option) => option.long === '--gate');
    for (const name of GATE_NAMES) expect(gate?.description).toContain(name);
  });
});
