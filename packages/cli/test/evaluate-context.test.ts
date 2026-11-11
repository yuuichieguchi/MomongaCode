import { describe, expect, it } from 'vitest';
import type { OutputFormatterName } from '@momonga/protocol';
import { freshHome } from './fresh-home.ts';
import { CONTEXT_DATASET_FORMAT, DATASET_FORMAT, encodeTranscript } from '@momonga/eval';
import type { Transcript } from '@momonga/eval';
import { canonicalJson } from '@momonga/foundation';
import type { EntryIo } from '@momonga/foundation';
import { toPublicRunEvent } from '@momonga/protocol';
import { fixtureCompactionItem, materializeEvents } from '@momonga/testkit';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';
import { NO_HELPER } from './no-helper.ts';

const pairedCase = (id: string, scenario: string, compaction: 'on' | 'off') => ({
  id,
  scenario,
  compaction,
  input: 'work',
  permissionMode: 'manual',
  onAsk: 'reject_once',
  runs: 1,
  minPassRate: 1,
  rules: [],
  revisionDepth: 0,
  noise: { level: 0, topics: ['testing'] },
  graders: [{ kind: 'status', equals: 'COMPLETED' }],
});

const SCENARIOS = ['a', 'b', 'c', 'd'] as const;

const CONTEXT_DATASET = JSON.stringify({
  format: CONTEXT_DATASET_FORMAT,
  name: 'sample',
  cases: SCENARIOS.flatMap((scenario) => [pairedCase(`${scenario}-on`, scenario, 'on'), pairedCase(`${scenario}-off`, scenario, 'off')]),
});

const GOLDEN_DATASET = JSON.stringify({
  format: DATASET_FORMAT,
  name: 'golden',
  cases: [{ id: 'a-on', input: 'x', permissionMode: 'manual', onAsk: 'reject_once', runs: 1, minPassRate: 1, graders: [{ kind: 'status', equals: 'COMPLETED' }] }],
});

const compactionEvents = (caseId: string): Transcript['events'] =>
  materializeEvents(
    [{ type: 'context.compacted', item: fixtureCompactionItem(`cmp-${caseId}`, 'summary'), summary: 'summary', replacedThroughSeq: 1, source: 'model', fidelity: { fabricated: [], identifiers: 1, retained: 1, sections: 'complete' } }],
    { runId: `run-${caseId}` },
  ).map(toPublicRunEvent);

const RECORDED_CODE = 'c'.repeat(64);

const RESOLVED_ON = {
  context: { adaptiveBudget: true, autoCompact: true, cachePrefix: true, loopGuidance: true, observedCapacity: true, outputFormatters: ['grep', 'identicalOutput', 'json', 'log'] as OutputFormatterName[], unboundedOutputReserve: true },
  tools: { conciseDescriptions: true, deferral: true },
  memory: { reflection: { enabled: true }, repositoryFacts: true },
};
const CACHE_PREFIX_OFF = { ...RESOLVED_ON, context: { ...RESOLVED_ON.context, cachePrefix: false } };

type Answers = 'model' | 'script';

const transcript = (caseId: string, status: 'COMPLETED' | 'FAILED' = 'COMPLETED', answers: Answers = 'script'): Transcript =>
  ({
    caseId,
    runIndex: 0,
    costs: [],
    run: { id: `run-${caseId}`, status, step: 1, usage: { inputTokens: 9, outputTokens: 1, totalTokens: 10 } },
    events: caseId.endsWith('-on') ? compactionEvents(caseId) : [],
    children: [],
    policy: RESOLVED_ON,
    codeDigest: RECORDED_CODE,
    answeredBy: [{ target: answers === 'model' ? 'opus' : 'scripted', adapter: 'anthropic', upstreamModel: 'claude-opus', answers }],
  }) as Transcript;

const harness = (failingOn: number = 0, answers: Answers = 'script') => {
  const stored = new Map<string, string>([
    ['/w/context.json', CONTEXT_DATASET],
    ['/w/golden.json', GOLDEN_DATASET],
    ...SCENARIOS.flatMap((scenario, index): [string, string][] => [
      [`/w/t/${scenario}-on.0.transcript.jsonl`, encodeTranscript(transcript(`${scenario}-on`, index < failingOn ? 'FAILED' : 'COMPLETED', answers))],
      [`/w/t/${scenario}-off.0.transcript.jsonl`, encodeTranscript(transcript(`${scenario}-off`, 'COMPLETED', answers))],
    ]),
    ['/w/g/a-on.0.transcript.jsonl', encodeTranscript(transcript('a-on'))],
  ]);
  const stdout: string[] = [];
  const completed: number[] = [];
  const ports = {
    version: '9.9.9',
    home: freshHome(),
    platform: process.platform,
    env: {},
    cwd: '/w',
    env: {},
    platform: process.platform,
    terminal: undefined,
    stdout: { write: (text: string) => stdout.push(text) },
    files: {
      readText: async (file: string) => {
        const text = stored.get(file);
        if (text === undefined) throw new Error(`no fixture for ${file}`);
        return text;
      },
      writeText: async (file: string, text: string) => void stored.set(file, text),
      listFiles: async (directory: string) => [...stored.keys()].filter((file) => file.startsWith(`${directory}/`)).sort(),
    },
    interrupt: new AbortController().signal,
  } as unknown as CliPorts;
  const entries = {} as DaemonEntries;
  const program = buildProgram({
    ports,
    policyVerify: () => nodePolicyVerifyHost(ports, { executables: '/w/cache/executables' }),
    entries,
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: (code) => completed.push(code),
  });
  program.exitOverride().configureOutput({ writeErr: () => undefined });
  for (const command of program.commands) {
    command.exitOverride().configureOutput({ writeErr: () => undefined });
    for (const nested of command.commands) nested.exitOverride().configureOutput({ writeErr: () => undefined });
  }
  return { program, stored, stdout, completed };
};

const run = (program: ReturnType<typeof harness>['program'], ...args: string[]): Promise<unknown> => program.parseAsync(args, { from: 'user' });

const reportFile = async (name: string, failingOn: number, model: 'fake' | 'real'): Promise<string> => {
  const { program, stored } = harness(failingOn, model === 'real' ? 'model' : 'script');
  await run(program, 'eval', 'context', 'context.json', '--replay', 't', '--report', name);
  const text = stored.get(`/w/${name}`);
  if (text === undefined) throw new Error('the command stored no report');
  return text;
};

describe('momonga eval context', () => {
  it('replays a dataset with no model and states the provenance it derived from the pins', async () => {
    const { program, stdout, completed } = harness();
    await run(program, 'eval', 'context', 'context.json', '--replay', 't');
    expect(completed).toEqual([0]);
    expect(stdout.join('')).toContain('model: fake');
    expect(stdout.join('')).toContain('machinery');
    expect(stdout.join('')).not.toContain('declared by the operator');
  });

  it('takes the provenance of a replay from the transcripts: declared models give real', async () => {
    const { program, stdout } = harness(0, 'model');
    await run(program, 'eval', 'context', 'context.json', '--replay', 't');
    expect(stdout.join('')).toContain('model: real');
  });

  it('exits 1 when a case misses its required pass rate', async () => {
    const { program, completed } = harness(1);
    await run(program, 'eval', 'context', 'context.json', '--replay', 't');
    expect(completed).toEqual([1]);
  });

  it('--alias is no longer an option of eval context, and --model belongs to a live run', async () => {
    const { program } = harness();
    await expect(run(program, 'eval', 'context', 'context.json', '--alias', 'devstral-small-2')).rejects.toThrow(/unknown option '--alias'/);
    await expect(run(harness().program, 'eval', 'context', 'context.json', '--replay', 't', '--model', 'devstral-small-2')).rejects.toThrow(
      '--model and --seed belong to a live run; a replay takes the models and the seed from the transcripts',
    );
  });

  it('requires the model of a live run', async () => {
    const { program } = harness();
    await expect(run(program, 'eval', 'context', 'context.json')).rejects.toThrow('--model <model> is required for a live run: it names the model every session of the run uses');
  });

  it('refuses --record together with --replay', async () => {
    const { program } = harness();
    await expect(run(program, 'eval', 'context', 'context.json', '--replay', 't', '--record', 'r')).rejects.toThrow(/--record and --replay cannot be combined/);
  });

  it('refuses a seed that is not an integer', async () => {
    const { program } = harness();
    await expect(run(program, 'eval', 'context', 'context.json', '--model', 'devstral-small-2', '--seed', 'x')).rejects.toThrow(/--seed/);
  });

  it('takes the seed of a replay from the transcripts', async () => {
    const context = harness();
    for (const scenario of SCENARIOS) {
      for (const suffix of ['on', 'off']) {
        const caseId = `${scenario}-${suffix}`;
        context.stored.set(`/w/t/${caseId}.0.transcript.jsonl`, encodeTranscript({ ...transcript(caseId), datasetSeed: 7 }));
      }
    }
    await run(context.program, 'eval', 'context', 'context.json', '--replay', 't', '--report', 'seeded.json');
    expect(JSON.parse(context.stored.get('/w/seeded.json') ?? '{}')).toMatchObject({ datasetSeed: 7 });
  });

  it('states unknown for transcripts that do not record what answered, instead of guessing', async () => {
    const context = harness();
    for (const scenario of SCENARIOS) {
      for (const suffix of ['on', 'off']) {
        const caseId = `${scenario}-${suffix}`;
        const { answeredBy: _dropped, ...bare } = transcript(caseId) as Transcript & { answeredBy?: unknown };
        context.stored.set(`/w/t/${caseId}.0.transcript.jsonl`, encodeTranscript(bare as Transcript));
      }
    }
    await run(context.program, 'eval', 'context', 'context.json', '--replay', 't');
    expect(context.stdout.join('')).toContain('model: unknown');
  });

  it('stores a report that compare can read', async () => {
    const parsed: unknown = JSON.parse(await reportFile('a.json', 0, 'real'));
    expect(parsed).toMatchObject({ dataset: 'sample', model: 'real' });
  });
});

const QUALITY_NAMES = ['continuationRate', 'governanceFidelity', 'governanceConsistency', 'governanceMinimality', 'memoryStaleRate', 'retrievalPrecision', 'retrievalRecall'];

const measuredQuality = (reportText: string): string => {
  const report = JSON.parse(reportText) as { cases: Record<string, unknown>[] };
  const cells = Object.fromEntries(QUALITY_NAMES.map((name) => [name, { numerator: 1, denominator: 2 }]));
  return JSON.stringify({ ...report, cases: report.cases.map((entry) => ({ ...entry, quality: cells })) });
};

describe('momonga eval compare', () => {
  const comparing = async (baseline: string, candidate: string) => {
    const context = harness();
    context.stored.set('/w/a.json', baseline);
    context.stored.set('/w/b.json', candidate);
    await run(context.program, 'eval', 'compare', 'a.json', 'b.json');
    return context;
  };

  it('exits 0 and prints PASS when the candidate clears the gate', async () => {
    const { completed, stdout } = await comparing(measuredQuality(await reportFile('a.json', 2, 'real')), measuredQuality(await reportFile('b.json', 0, 'real')));
    expect(stdout.join('')).toContain('gate: PASS');
    expect(completed).toEqual([0]);
  });

  it('exits 1 and prints FAIL when it does not', async () => {
    const { completed, stdout } = await comparing(await reportFile('a.json', 0, 'real'), await reportFile('b.json', 1, 'real'));
    expect(stdout.join('')).toContain('gate: FAIL');
    expect(completed).toEqual([1]);
  });

  it('exits 1 for fake reports', async () => {
    const { completed } = await comparing(await reportFile('a.json', 2, 'fake'), await reportFile('b.json', 0, 'fake'));
    expect(completed).toEqual([1]);
  });

  it('judges the token terms with --gate token and prints why a term with no measure fails', async () => {
    const context = harness();
    context.stored.set('/w/a.json', await reportFile('a.json', 0, 'real'));
    context.stored.set('/w/b.json', JSON.stringify({ ...JSON.parse(await reportFile('b.json', 0, 'real')), codeDigest: 'f'.repeat(64) }));
    await run(context.program, 'eval', 'compare', 'a.json', 'b.json', '--gate', 'token');
    const text = context.stdout.join('');
    expect(text).toContain('gate: FAIL');
    expect(text).toMatch(/FAIL (costPerSuccess|uncachedInputPerSuccess): no measure: /);
    expect(text).toContain('passRate');
    expect(text).not.toContain('contrastiveFailures:');
    expect(context.completed).toEqual([1]);
  });

  it('refuses a gate it does not know', async () => {
    const context = harness();
    context.stored.set('/w/a.json', await reportFile('a.json', 0, 'real'));
    context.stored.set('/w/b.json', await reportFile('b.json', 0, 'real'));
    await expect(run(context.program, 'eval', 'compare', 'a.json', 'b.json', '--gate', 'speed')).rejects.toThrow(/--gate.*context.*token/);
    const named = harness();
    named.stored.set('/w/a.json', await reportFile('a.json', 0, 'real'));
    named.stored.set('/w/b.json', await reportFile('b.json', 0, 'real'));
    await run(named.program, 'eval', 'compare', 'a.json', 'b.json', '--gate', 'context');
    expect(named.stdout.join('')).toContain('contrastiveFailures');
  });

  it('refuses a file that is not a context report', async () => {
    const context = harness();
    context.stored.set('/w/a.json', '{}');
    context.stored.set('/w/b.json', '{}');
    await expect(run(context.program, 'eval', 'compare', 'a.json', 'b.json')).rejects.toThrow(/not a context report/);
  });
});

describe('momonga eval <dataset>', () => {
  it('still replays a golden dataset', async () => {
    const { program, stdout, completed } = harness();
    await run(program, 'eval', 'golden.json', '--replay', 'g');
    expect(stdout.join('')).toContain('dataset golden: PASS');
    expect(completed).toEqual([0]);
  });
});

describe('momonga eval context --settings', () => {
  it('belongs to a live run, so a replay refuses it', async () => {
    const { program, stored } = harness();
    stored.set('/w/policy.json', JSON.stringify({ context: { cachePrefix: true } }));
    await expect(run(program, 'eval', 'context', 'context.json', '--replay', 't', '--settings', 'policy.json')).rejects.toThrow(/--settings.*live run/);
  });

  it('refuses an overlay with a non-core key (design-core-on 3.2, 3.5 item 2) before any case runs, and names the file', async () => {
    const { program, stored, completed } = harness();
    stored.set('/w/bad.json', JSON.stringify({ tools: { ripgrep: 'system' } }));
    await expect(run(program, 'eval', 'context', 'context.json', '--model', 'devstral-small-2', '--settings', 'bad.json')).rejects.toThrow(/bad\.json/);
    expect(completed).toEqual([]);
  });
});

describe('momonga eval compare --gate token, the policies and the code digests', () => {
  it('takes the policy and the code digest of a replay report from its transcripts', async () => {
    const context = harness();
    const policy = CACHE_PREFIX_OFF;
    for (const scenario of SCENARIOS) {
      for (const side of ['on', 'off'] as const) {
        context.stored.set(`/w/t/${scenario}-${side}.0.transcript.jsonl`, encodeTranscript({ ...transcript(`${scenario}-${side}`), policy, codeDigest: 'e'.repeat(64) }));
      }
    }
    await run(context.program, 'eval', 'context', 'context.json', '--replay', 't', '--report', 'r.json');
    const report = JSON.parse(context.stored.get('/w/r.json') ?? '{}');
    expect(report.policy).toEqual(policy);
    expect(report.codeDigest).toBe('e'.repeat(64));
  });

  it('refuses a replay whose transcripts record different code digests', async () => {
    const context = harness();
    context.stored.set('/w/t/a-on.0.transcript.jsonl', encodeTranscript({ ...transcript('a-on'), codeDigest: 'f'.repeat(64) }));
    await expect(run(context.program, 'eval', 'context', 'context.json', '--replay', 't')).rejects.toThrow(/codeDigest/);
    expect(context.completed).toEqual([]);
  });

  it('refuses two reports with the same policy produced by the same code', async () => {
    const context = harness();
    context.stored.set('/w/a.json', await reportFile('a.json', 0, 'real'));
    context.stored.set('/w/b.json', await reportFile('b.json', 0, 'real'));
    await expect(run(context.program, 'eval', 'compare', 'a.json', 'b.json', '--gate', 'token')).rejects.toThrow(/identical/);
    expect(context.completed).toEqual([]);
  });

  it('prints both policies when they differ', async () => {
    const context = harness();
    const baseline = JSON.parse(await reportFile('a.json', 0, 'real'));
    const candidate = { ...JSON.parse(await reportFile('b.json', 0, 'real')), policy: CACHE_PREFIX_OFF };
    context.stored.set('/w/a.json', JSON.stringify(baseline));
    context.stored.set('/w/b.json', `${JSON.stringify(candidate, null, 2)}\n`);
    await run(context.program, 'eval', 'compare', 'a.json', 'b.json', '--gate', 'token');
    const text = context.stdout.join('');
    expect(text).toContain(`baseline policy: ${canonicalJson(RESOLVED_ON)}`);
    expect(text).toContain(`candidate policy: ${canonicalJson(CACHE_PREFIX_OFF)}`);
    expect(text).toContain('policy differs in: context.cachePrefix');
    expect(text).toMatch(/baseline codeDigest: [0-9a-f]{64}/);
    expect(text).toContain(`candidate codeDigest: ${String(candidate.codeDigest)}`);
  });
});
