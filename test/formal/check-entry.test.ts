import { spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import type { ProcessGroupPort, Timing } from '@momonga/foundation';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRoot, removeTempRoot } from '../../scripts/support/temp.ts';
import { checkEntry, createTierReport } from './check-entry.ts';
import type { CheckOutcome, CheckRequest } from './check-entry.ts';
import { cfgFor, completedOutput, holdsEntry, invariantEntry, invariantViolationOutput, temporalEntry, temporalViolationOutput, tinySpec, writeFile } from './fixtures.ts';
import type { ManifestEntry } from './manifest.ts';
import { TLC_WORKERS } from './runner.ts';
import { HARNESS_FILES, RAN_REASONS, createJavaIdentityReader, createResultStore } from './reuse.ts';
import type { JavaIdentity, ResultStore } from './reuse.ts';

const realRoot = path.resolve(import.meta.dirname, '..', '..');
const NOW = '2026-11-10T04:05:06.000Z';
const JAVA: JavaIdentity = { runtime: '22.0.1+8-16', vm: 'OpenJDK 64-Bit Server VM', os: 'Mac OS X', arch: 'aarch64' };
const NESTED_RUN_TIMEOUT_MS = 180000;

const limitOf = (entry: ManifestEntry): number => entry.budgetCpuSeconds * TLC_WORKERS * 1000;

const timingThatPassesOnEveryRead = (onRead: (read: number) => void): Timing => {
  let clock = 0;
  return {
    now: () => clock,
    monotonicMs: () => {
      clock += 100;
      onRead(clock);
      return clock;
    },
    setTimeout: (wake) => void queueMicrotask(wake),
    clearTimeout: () => undefined,
  };
};

const executable = (file: string, lines: readonly string[]): string => {
  writeFile(file, ['#!/bin/sh', ...lines, ''].join('\n'));
  fs.chmodSync(file, 0o755);
  return file;
};

const javaStubBin = (dir: string): string => {
  const bin = path.join(dir, 'java-bin');
  executable(path.join(bin, 'java'), [
    'echo "Property settings:" >&2',
    `echo "    java.runtime.version = ${JAVA.runtime}" >&2`,
    `echo "    java.vm.name = ${JAVA.vm}" >&2`,
    `echo "    os.name = ${JAVA.os}" >&2`,
    `echo "    os.arch = ${JAVA.arch}" >&2`,
    'exit 0',
  ]);
  return bin;
};

const fixtureRepository = (root: string): void => {
  for (const file of HARNESS_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(realRoot, file), path.join(root, file));
  }
  writeFile(path.join(root, '.cache', 'tla', 'tla2tools.jar'), 'fake jar bytes');
  writeFile(path.join(root, 'specs', 'tla', 'Tiny.tla'), tinySpec);
  for (const config of ['Tiny', 'Tiny.broken', 'Tiny.live']) writeFile(path.join(root, 'specs', 'tla', `${config}.cfg`), cfgFor('Small'));
};

type Fake = { script: string; counter: string; pidFile: string; output: string; exit: string };

const countingScript = (dir: string): Fake => {
  const fake = { script: path.join(dir, 'fake-tlc.sh'), counter: path.join(dir, 'calls'), pidFile: path.join(dir, 'pid'), output: path.join(dir, 'output'), exit: path.join(dir, 'exit') };
  executable(fake.script, [`echo "$*" >> "${fake.counter}"`, `echo $$ > "${fake.pidFile}"`, `cat "${fake.output}"`, `exit $(cat "${fake.exit}")`]);
  return fake;
};

const answer = (fake: Fake, exitCode: number, stdout: string): void => {
  fs.writeFileSync(fake.output, `${stdout}\n`);
  fs.writeFileSync(fake.exit, String(exitCode));
};

const callsOf = (fake: Fake): string[] => (fs.existsSync(fake.counter) ? fs.readFileSync(fake.counter, 'utf8').split('\n').filter((line) => line.length > 0) : []);

const recordFiles = (storeDir: string, config: string): string[] => {
  const dir = path.join(storeDir, config);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
};

type CountingStore = { store: ResultStore; reads: () => number; writes: () => number; orphanRemovals: () => number };

const counting = (inner: ResultStore): CountingStore => {
  let reads = 0;
  let writes = 0;
  let orphanRemovals = 0;
  const store = new Proxy(inner, {
    get: (target, property) => {
      const value = Reflect.get(target, property, target) as unknown;
      if ((property !== 'read' && property !== 'write' && property !== 'removeOrphans') || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (property === 'read') reads += 1;
        if (property === 'write') writes += 1;
        if (property === 'removeOrphans') orphanRemovals += 1;
        return Reflect.apply(value as (...callArgs: unknown[]) => unknown, target, args);
      };
    },
  });
  return { store, reads: () => reads, writes: () => writes, orphanRemovals: () => orphanRemovals };
};

describe('checking one configuration', () => {
  let temp = '';
  let repoRoot = '';
  let storeDir = '';
  let fake: Fake;
  let javaEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    temp = createTempRoot();
    repoRoot = path.join(temp, 'repo');
    storeDir = path.join(temp, 'state', 'tlc-results');
    fixtureRepository(repoRoot);
    fake = countingScript(temp);
    answer(fake, 0, completedOutput(3));
    javaEnv = { ...process.env, PATH: `${javaStubBin(temp)}:/usr/bin:/bin` };
  });

  afterEach(() => {
    removeTempRoot(temp);
  });

  const request = (overrides: Partial<CheckRequest> = {}): CheckRequest => {
    const entry = overrides.entry ?? holdsEntry;
    return {
      entry,
      script: fake.script,
      repoRoot,
      tier: 'every-run',
      mode: 'on',
      env: {},
      store: createResultStore(storeDir),
      java: createJavaIdentityReader({ env: javaEnv }),
      limitMs: limitOf(entry),
      now: () => new Date(NOW),
      ...overrides,
    };
  };

  const argvOfLastCall = (): string[] => (callsOf(fake).at(-1) ?? '').split(' ');

  it('runs and stores, then reuses, then runs again after the configuration file changes', async () => {
    expect(await checkEntry(request())).toEqual({ outcome: 'ran', reason: 'no record', problems: [], stored: 'stored' });
    expect(callsOf(fake)).toHaveLength(1);
    expect(await checkEntry(request())).toEqual({ outcome: 'reused', producedAt: NOW });
    expect(callsOf(fake)).toHaveLength(1);
    fs.appendFileSync(path.join(repoRoot, 'specs', 'tla', 'Tiny.cfg'), '\n');
    const third = await checkEntry(request());
    expect(third.outcome).toBe('ran');
    expect((third as { reason: string }).reason).toBe('no record');
    expect(callsOf(fake)).toHaveLength(2);
  });

  it.each([
    ['a holding run with the completion line and 3 distinct states', holdsEntry, 0, completedOutput(3)],
    ['an invariant violation of Small with exit 12', invariantEntry, 12, invariantViolationOutput('Small')],
    ['a temporal violation with exit 13', temporalEntry, 13, temporalViolationOutput],
  ] as const)('stores %s', async (_label, entry, exitCode, stdout) => {
    answer(fake, exitCode, stdout);
    const outcome = await checkEntry(request({ entry }));
    expect(outcome).toEqual({ outcome: 'ran', reason: 'no record', problems: [], stored: 'stored' });
    expect(recordFiles(storeDir, entry.config)).toHaveLength(1);
  });

  const notStoredCases: readonly (readonly [string, () => Partial<CheckRequest>])[] = [
    [
      'a run killed at a CPU budget of 2',
      () => {
        const entry = { ...holdsEntry, budgetCpuSeconds: 2 };
        return { entry, limitMs: limitOf(entry), script: executable(path.join(temp, 'burn.sh'), ['while :; do :; done']) };
      },
    ],
    ['a run that ends itself with SIGTERM', () => ({ script: executable(path.join(temp, 'term.sh'), ['kill -TERM $$']) })],
    ...[3, 5, 71].map((code) => [`a script failure with exit ${code}`, () => (answer(fake, code, ''), {})] as const),
    ['exit 0 without the completion line', () => (answer(fake, 0, '3 states generated, 3 distinct states found, 0 states left on queue.'), {})],
    ['exit 0 with 4 distinct states against 3', () => (answer(fake, 0, completedOutput(4)), {})],
    ['exit 12 naming Other', () => (answer(fake, 12, invariantViolationOutput('Other')), { entry: invariantEntry })],
    [
      'a run whose process group stays alive',
      () => {
        const port: ProcessGroupPort = { signal: async () => undefined, alive: async () => true };
        return { groupPort: port, timing: timingThatPassesOnEveryRead(() => undefined) };
      },
    ],
    ['a holding entry whose run violates Small with exit 12', () => (answer(fake, 12, invariantViolationOutput('Small')), {})],
  ];

  it.each(notStoredCases)(
    'does not store %s',
    async (_label, setUp) => {
      const outcome = await checkEntry(request(setUp()));
      expect(outcome.outcome).toBe('ran');
      expect((outcome as { stored: unknown }).stored).toBe('not eligible');
      expect(recordFiles(storeDir, 'Tiny')).toEqual([]);
      expect(recordFiles(storeDir, 'Tiny.broken')).toEqual([]);
    },
    limitOf({ ...holdsEntry, budgetCpuSeconds: 5 }) + 30000,
  );

  it.each([
    ['every-run, mode on, no arguments', {}, holdsEntry, ['Tiny', '-fp', '0', '-workers', String(TLC_WORKERS)]],
    ['every-run, mode on, final liveness', {}, { ...holdsEntry, args: ['-lncheck', 'final'] }, ['Tiny', '-lncheck', 'final', '-fp', '0', '-workers', String(TLC_WORKERS)]],
    ['mode off', { mode: 'off' }, holdsEntry, ['Tiny', '-workers', String(TLC_WORKERS)]],
    ['tier deep', { tier: 'deep' }, holdsEntry, ['Tiny', '-workers', String(TLC_WORKERS)]],
  ] as const)('passes the arguments of %s', async (_label, overrides, entry, argv) => {
    await checkEntry(request({ ...(overrides as Partial<CheckRequest>), entry }));
    expect(argvOfLastCall()).toEqual(argv);
  });

  it('stores nothing for a run that fails its row and runs it again next time', async () => {
    answer(fake, 12, invariantViolationOutput('Other'));
    const first = await checkEntry(request({ entry: invariantEntry }));
    expect(first.outcome).toBe('ran');
    expect((first as { problems: readonly string[] }).problems).not.toEqual([]);
    expect(recordFiles(storeDir, 'Tiny.broken')).toEqual([]);
    await checkEntry(request({ entry: invariantEntry }));
    expect(callsOf(fake)).toHaveLength(2);
  });

  it('replaces a record that no longer satisfies the row with a fresh run that does', async () => {
    await checkEntry(request());
    const changedRow = { ...holdsEntry, distinctStates: 4 };
    answer(fake, 0, completedOutput(4));
    const outcome = await checkEntry(request({ entry: changedRow }));
    expect(outcome).toEqual({ outcome: 'ran', reason: 'record does not satisfy the manifest entry', problems: [], stored: 'stored' });
    expect(recordFiles(storeDir, 'Tiny')).toHaveLength(1);
    expect(await checkEntry(request({ entry: changedRow }))).toEqual({ outcome: 'reused', producedAt: NOW });
    expect(callsOf(fake)).toHaveLength(2);
  });

  it('keeps a record that no longer satisfies the row when the fresh run does not satisfy it either', async () => {
    await checkEntry(request());
    const [file] = recordFiles(storeDir, 'Tiny') as [string];
    const before = fs.readFileSync(path.join(storeDir, 'Tiny', file));
    answer(fake, 0, completedOutput(5));
    const outcome = await checkEntry(request({ entry: { ...holdsEntry, distinctStates: 4 } }));
    expect(outcome.outcome).toBe('ran');
    expect((outcome as { reason: string }).reason).toBe('record does not satisfy the manifest entry');
    expect((outcome as { problems: readonly string[] }).problems).not.toEqual([]);
    expect(fs.readFileSync(path.join(storeDir, 'Tiny', file))).toEqual(before);
  });

  it.each([
    ['mode off', { mode: 'off' }, 'reuse off'],
    ['tier deep', { tier: 'deep' }, 'deep tier'],
  ] as const)('neither reads nor writes the store with a valid record under %s and passes no -fp', async (_label, overrides, reason) => {
    await checkEntry(request());
    const watched = counting(createResultStore(storeDir));
    const outcome = await checkEntry(request({ ...(overrides as Partial<CheckRequest>), store: watched.store }));
    expect(outcome.outcome).toBe('ran');
    expect((outcome as { reason: string }).reason).toBe(reason);
    expect([watched.reads(), watched.writes(), watched.orphanRemovals()]).toEqual([0, 0, 0]);
    expect(argvOfLastCall()).not.toContain('-fp');
  });

  const refusalCases: readonly (readonly [string, () => Partial<CheckRequest>, string])[] = [
    ['JAVA_TOOL_OPTIONS', () => ({ env: { JAVA_TOOL_OPTIONS: '-Dx=1' } }), 'JAVA_TOOL_OPTIONS is set'],
    ['_JAVA_OPTIONS', () => ({ env: { _JAVA_OPTIONS: '-Dx=1' } }), '_JAVA_OPTIONS is set'],
    ['JDK_JAVA_OPTIONS', () => ({ env: { JDK_JAVA_OPTIONS: '-Dx=1' } }), 'JDK_JAVA_OPTIONS is set'],
    ['a reader returning no identity', () => ({ java: async () => undefined }), 'java not readable'],
    ['the jar missing', () => (fs.rmSync(path.join(repoRoot, '.cache', 'tla', 'tla2tools.jar')), {}), 'input not readable'],
  ];

  it.each(refusalCases)('runs fresh without touching the store when refused for %s', async (_label, setUp, reason) => {
    await checkEntry(request());
    const watched = counting(createResultStore(storeDir));
    const overrides = setUp();
    const outcome = await checkEntry(request({ ...overrides, store: watched.store }));
    expect(outcome.outcome).toBe('ran');
    expect((outcome as { reason: string }).reason).toBe(reason);
    expect([watched.reads(), watched.writes(), watched.orphanRemovals()]).toEqual([0, 0, 0]);
    expect(argvOfLastCall()).not.toContain('-fp');
    expect(callsOf(fake)).toHaveLength(2);
  });

  const precedenceCases: readonly (readonly [string, () => Partial<CheckRequest>, string])[] = [
    ['deep, mode off and a Java variable', () => ({ tier: 'deep', mode: 'off', env: { JAVA_TOOL_OPTIONS: '-Dx=1' } }), 'deep tier'],
    ['every-run, mode off and a Java variable', () => ({ mode: 'off', env: { JAVA_TOOL_OPTIONS: '-Dx=1' } }), 'reuse off'],
    ['mode on, a Java variable and an unreadable Java', () => ({ env: { JAVA_TOOL_OPTIONS: '-Dx=1' }, java: async () => undefined }), 'JAVA_TOOL_OPTIONS is set'],
    ['mode on, an unreadable Java and a missing jar', () => (fs.rmSync(path.join(repoRoot, '.cache', 'tla', 'tla2tools.jar')), { java: async () => undefined }), 'java not readable'],
    ['mode on, a missing jar and no record', () => (fs.rmSync(path.join(repoRoot, '.cache', 'tla', 'tla2tools.jar')), {}), 'input not readable'],
  ];

  it.each(precedenceCases)('names the first reason that applies for %s', async (_label, setUp, reason) => {
    const outcome = await checkEntry(request(setUp()));
    expect(outcome.outcome).toBe('ran');
    expect((outcome as { reason: string }).reason).toBe(reason);
  });

  it.each([
    ['the configuration file', 'specs/tla/Tiny.cfg'],
    ['a module of the closure', 'specs/tla/Tiny.tla'],
  ])('stores nothing when %s changes while the run is under way, and runs again next time', async (_label, input) => {
    const changing = executable(path.join(temp, 'changing-tlc.sh'), [`echo "$*" >> "${fake.counter}"`, `echo " " >> "${path.join(repoRoot, input)}"`, `cat "${fake.output}"`, `exit $(cat "${fake.exit}")`]);
    const watched = counting(createResultStore(storeDir));
    const first = await checkEntry(request({ script: changing, store: watched.store }));
    expect(first).toEqual({ outcome: 'ran', reason: 'inputs changed during the run', problems: [], stored: 'not eligible' });
    expect(RAN_REASONS).toContain('inputs changed during the run');
    expect(watched.writes()).toBe(0);
    expect(recordFiles(storeDir, 'Tiny')).toEqual([]);
    const second = await checkEntry(request({ script: changing }));
    expect(second.outcome).toBe('ran');
    expect(callsOf(fake)).toHaveLength(2);
    expect(recordFiles(storeDir, 'Tiny')).toEqual([]);
  });

  it('fails a run whose process group still has members at the test limit and stores nothing', async () => {
    let probes = 0;
    const port: ProcessGroupPort = {
      signal: async () => undefined,
      alive: async () => {
        probes += 1;
        return true;
      },
    };
    const seen: number[] = [];
    const timing = timingThatPassesOnEveryRead((read) => void seen.push(read));
    const limitMs = 1000;
    const outcome = await checkEntry(request({ groupPort: port, timing, limitMs }));
    const pid = Number(fs.readFileSync(fake.pidFile, 'utf8').trim());
    expect(outcome.outcome).toBe('ran');
    expect((outcome as { problems: readonly string[] }).problems).toEqual([`Tiny: process group ${pid} still has members after the run`]);
    expect((outcome as { stored: unknown }).stored).toBe('not eligible');
    expect(recordFiles(storeDir, 'Tiny')).toEqual([]);
    expect(probes).toBeGreaterThan(0);
    expect(probes).toBeLessThanOrEqual(limitMs / 100 + 2);
    expect((seen.at(-1) as number) - (seen[0] as number)).toBeGreaterThanOrEqual(limitMs - 100);
  });
});

describe('the summary of a tier', () => {
  const ran = (reason: string, notStored?: string): CheckOutcome =>
    ({ outcome: 'ran', reason, problems: [], stored: notStored === undefined ? 'stored' : { notStored } }) as CheckOutcome;

  it('states what was reused and why each other configuration ran', () => {
    const report = createTierReport('every-run');
    report.add('A', { outcome: 'reused', producedAt: '2026-11-10T02:00:00.000Z' });
    report.add('B', { outcome: 'reused', producedAt: '2026-11-10T01:00:00.000Z' });
    report.add('C', { outcome: 'reused', producedAt: '2026-11-10T03:00:00.000Z' });
    report.add('Z', ran('reuse off'));
    report.add('X', ran('no record', 'disk full'));
    report.add('Y', ran('no record'));
    expect(report.lines()).toEqual([
      'TLC every-run: 6 configurations, 3 reused, 3 ran',
      'reused: 3 (records produced 2026-11-10T01:00:00.000Z to 2026-11-10T03:00:00.000Z)',
      'ran (reuse off): 1: Z',
      'ran (no record): 2: X, Y',
      'not stored (disk full): 1: X',
    ]);
  });

  it('says nothing when no configuration was checked', () => {
    expect(createTierReport('every-run').lines()).toEqual([]);
  });

  it('names the deep tier', () => {
    const report = createTierReport('deep');
    report.add('Deep.one', { outcome: 'ran', reason: 'deep tier', problems: [], stored: 'not eligible' } as CheckOutcome);
    expect(report.lines()).toEqual(['TLC deep: 1 configurations, 0 reused, 1 ran', 'ran (deep tier): 1: Deep.one']);
  });

  it('writes every line with a newline to the writer it is given', () => {
    const report = createTierReport('every-run');
    report.add('A', { outcome: 'reused', producedAt: '2026-11-10T01:00:00.000Z' });
    const written: string[] = [];
    report.print((text) => written.push(text));
    expect(written.join('')).toBe('TLC every-run: 1 configurations, 1 reused, 0 ran\nreused: 1 (records produced 2026-11-10T01:00:00.000Z to 2026-11-10T01:00:00.000Z)\n');
  });
});

type NestedRun = { code: number | null; stdout: string; stderr: string };

const runNestedVitest = (root: string, args: readonly string[], env: Record<string, string | undefined>): Promise<NestedRun> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(realRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--root', root, '--config', path.join(root, 'vitest.config.mjs'), ...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });

const nestedEnv = (extra: Record<string, string>): Record<string, string | undefined> => {
  const inherited: Record<string, string | undefined> = { ...process.env };
  delete inherited['MOMONGA_RUN_LOCK'];
  delete inherited['MOMONGA_TLC_REUSE'];
  return { ...inherited, ...extra };
};

const packageScripts = (JSON.parse(fs.readFileSync(path.join(realRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

const quoted = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

const runPackageScript = (name: string, root: string, args: readonly string[], env: Record<string, string | undefined>): Promise<NestedRun> =>
  new Promise((resolve, reject) => {
    const commandLine = [packageScripts[name] as string, ...['--root', root, '--config', path.join(root, 'vitest.config.mjs'), ...args].map(quoted)].join(' ');
    const child = spawn('/bin/sh', ['-c', commandLine], {
      cwd: root,
      env: { ...env, PATH: `${path.join(realRoot, 'node_modules', '.bin')}${path.delimiter}${env['PATH'] ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });

const storeSnapshot = (storeDir: string): string[] =>
  fs.existsSync(storeDir)
    ? (fs.readdirSync(storeDir, { recursive: true }) as string[])
        .sort()
        .map((name) => {
          const file = path.join(storeDir, name);
          const status = fs.statSync(file);
          return status.isDirectory() ? `${name}/` : `${name} ${status.mtimeMs} ${fs.readFileSync(file, 'utf8')}`;
        })
    : [];

type JsonReport = { testResults: { assertionResults: { title: string; fullName: string; status: string; failureMessages: string[] }[] }[] };

const assertionsOf = (file: string): JsonReport['testResults'][number]['assertionResults'] =>
  (JSON.parse(fs.readFileSync(file, 'utf8')) as JsonReport).testResults.flatMap((result) => result.assertionResults);

describe('the summary under a real vitest run', () => {
  let temp = '';

  beforeEach(() => {
    temp = createTempRoot();
    writeFile(path.join(temp, 'project', 'vitest.config.mjs'), "export default { test: { globals: true, include: ['*.test.ts'] } };\n");
  });

  afterEach(() => {
    removeTempRoot(temp);
  });

  it.each(['default', 'minimal'])(
    'reaches standard error under the %s reporter',
    async (reporter) => {
      const project = path.join(temp, 'project');
      writeFile(
        path.join(project, 'summary.test.ts'),
        [
          `import { createTierReport } from ${JSON.stringify(path.join(realRoot, 'test', 'formal', 'check-entry.ts'))};`,
          "const report = createTierReport('every-run');",
          "it('adds one reused configuration', () => { report.add('Tiny', { outcome: 'reused', producedAt: '2026-11-10T01:00:00.000Z' }); });",
          'afterAll(() => { report.print(); });',
          '',
        ].join('\n'),
      );
      const run = await runNestedVitest(project, [`--reporter=${reporter}`], nestedEnv({ MOMONGA_DEV_STATE_DIR: path.join(temp, 'state') }));
      expect(run.code).toBe(0);
      expect(run.stderr).toContain('TLC every-run: 1 configurations, 1 reused, 0 ran');
    },
    NESTED_RUN_TIMEOUT_MS,
  );

  it(
    'runs, stores and then reuses through describeTier, removes orphans, and fails every test of the tier on a wrong mode',
    async () => {
      const project = path.join(temp, 'project');
      const repoRoot = path.join(temp, 'repo');
      fixtureRepository(repoRoot);
      const counter = path.join(temp, 'calls');
      const script = executable(path.join(temp, 'fake-tlc.sh'), [
        `echo "$*" >> "${counter}"`,
        'if [ "$1" = "Tiny" ]; then',
        ...completedOutput(3)
          .split('\n')
          .map((line) => `  echo ${JSON.stringify(line)}`),
        '  exit 0',
        'fi',
        ...invariantViolationOutput('Small')
          .split('\n')
          .map((line) => `echo ${JSON.stringify(line)}`),
        'exit 12',
      ]);
      const entries = [holdsEntry, invariantEntry];
      writeFile(
        path.join(project, 'tier.test.ts'),
        [
          `import { describeTier } from ${JSON.stringify(path.join(realRoot, 'test', 'formal', 'tier.ts'))};`,
          `describeTier({ tier: 'every-run', entries: ${JSON.stringify(entries)}, manifestConfigs: ['Tiny', 'Tiny.broken'], script: ${JSON.stringify(script)}, repoRoot: ${JSON.stringify(repoRoot)}, env: process.env });`,
          '',
        ].join('\n'),
      );
      const stateDir = path.join(temp, 'state');
      const storeDir = path.join(stateDir, 'tlc-results');
      fs.mkdirSync(path.join(storeDir, 'Old'), { recursive: true });
      const jsonFile = path.join(temp, 'report.json');
      const args = ['--reporter=default', '--reporter=json', `--outputFile.json=${jsonFile}`];
      const env = (mode: string) => nestedEnv({ MOMONGA_TLC_REUSE: mode, MOMONGA_DEV_STATE_DIR: stateDir, PATH: `${javaStubBin(temp)}:${process.env['PATH'] ?? ''}` });

      const first = await runNestedVitest(project, args, env('1'));
      const firstTests = assertionsOf(jsonFile).filter((test) => test.title !== 'has configurations in this tier');
      expect(firstTests.map((test) => [test.title, test.status])).toEqual([
        ['Tiny holds', 'passed'],
        ['Tiny.broken violates Small', 'passed'],
      ]);
      expect(first.code).toBe(0);
      expect(first.stderr).toContain('TLC every-run: 2 configurations, 0 reused, 2 ran');
      expect(first.stderr).toContain('ran (no record): 2: Tiny, Tiny.broken');
      expect(fs.existsSync(path.join(storeDir, 'Old'))).toBe(false);
      expect(recordFiles(storeDir, 'Tiny').length + recordFiles(storeDir, 'Tiny.broken').length).toBe(2);
      const callsAfterFirst = fs.readFileSync(counter, 'utf8');

      const second = await runNestedVitest(project, args, env('1'));
      expect(second.code).toBe(0);
      expect(second.stderr).toContain('TLC every-run: 2 configurations, 2 reused, 0 ran');
      expect(fs.readFileSync(counter, 'utf8')).toBe(callsAfterFirst);

      const third = await runNestedVitest(project, args, env('yes'));
      expect(third.code).not.toBe(0);
      const thirdTests = assertionsOf(jsonFile);
      expect(thirdTests.map((test) => test.title).sort()).toEqual(['Tiny holds', 'Tiny.broken violates Small', 'has configurations in this tier']);
      for (const test of thirdTests) {
        expect(test.status, test.title).toBe('failed');
        expect(test.failureMessages.join('\n'), test.title).toContain('MOMONGA_TLC_REUSE must be 1 or 0, got "yes"');
      }
    },
    3 * NESTED_RUN_TIMEOUT_MS,
  );

  const tierFixture = (entriesSource: string, manifestConfigs: readonly string[]): { project: string; counter: string; stateDir: string; storeDir: string; jsonFile: string; args: string[]; env: (mode: string) => Record<string, string | undefined> } => {
    const project = path.join(temp, 'project');
    const repoRoot = path.join(temp, 'repo');
    fixtureRepository(repoRoot);
    const counter = path.join(temp, 'calls');
    const script = executable(path.join(temp, 'fake-tlc.sh'), [
      `echo "$*" >> "${counter}"`,
      'if [ "$1" = "Tiny" ]; then',
      ...completedOutput(3)
        .split('\n')
        .map((line) => `  echo ${JSON.stringify(line)}`),
      '  exit 0',
      'fi',
      ...invariantViolationOutput('Small')
        .split('\n')
        .map((line) => `echo ${JSON.stringify(line)}`),
      'exit 12',
    ]);
    writeFile(path.join(project, 'vitest.config.mjs'), "export default { test: { name: 'unit', globals: true, include: ['*.test.ts'] } };\n");
    writeFile(
      path.join(project, 'tier.test.ts'),
      [
        `import { describeTier } from ${JSON.stringify(path.join(realRoot, 'test', 'formal', 'tier.ts'))};`,
        `describeTier({ tier: 'every-run', entries: ${entriesSource}, manifestConfigs: ${JSON.stringify(manifestConfigs)}, script: ${JSON.stringify(script)}, repoRoot: ${JSON.stringify(repoRoot)}, env: process.env });`,
        '',
      ].join('\n'),
    );
    const stateDir = path.join(temp, 'state');
    const jsonFile = path.join(temp, 'report.json');
    return {
      project,
      counter,
      stateDir,
      storeDir: path.join(stateDir, 'tlc-results'),
      jsonFile,
      args: ['--reporter=default', '--reporter=json', `--outputFile.json=${jsonFile}`],
      env: (mode) => nestedEnv({ MOMONGA_TLC_REUSE: mode, MOMONGA_DEV_STATE_DIR: stateDir, PATH: `${javaStubBin(temp)}:${process.env['PATH'] ?? ''}` }),
    };
  };

  const callsIn = (counter: string): string[] => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').split('\n').filter((line) => line.length > 0) : []);

  it(
    'runs every configuration fresh through the text of the test script when the calling environment exports MOMONGA_TLC_REUSE=1',
    async () => {
      const fixture = tierFixture(JSON.stringify([holdsEntry, invariantEntry]), ['Tiny', 'Tiny.broken']);
      const stored = await runNestedVitest(fixture.project, fixture.args, fixture.env('1'));
      expect(stored.code).toBe(0);
      expect(recordFiles(fixture.storeDir, 'Tiny').length + recordFiles(fixture.storeDir, 'Tiny.broken').length).toBe(2);
      fs.mkdirSync(path.join(fixture.storeDir, 'Old'));
      const storeBefore = storeSnapshot(fixture.storeDir);
      const callsBefore = callsIn(fixture.counter).length;

      const run = await runPackageScript('test', fixture.project, fixture.args, fixture.env('1'));

      expect(run.code).toBe(0);
      expect(run.stderr).toContain('TLC every-run: 2 configurations, 0 reused, 2 ran');
      expect(run.stderr).toContain('ran (reuse off): 2: Tiny, Tiny.broken');
      const calls = callsIn(fixture.counter).slice(callsBefore);
      expect(calls.map((line) => line.split(' ')).sort()).toEqual([
        ['Tiny', '-workers', String(TLC_WORKERS)],
        ['Tiny.broken', '-workers', String(TLC_WORKERS)],
      ]);
      expect(storeSnapshot(fixture.storeDir)).toEqual(storeBefore);
    },
    2 * NESTED_RUN_TIMEOUT_MS,
  );

  it(
    'fails the first test of the tier with the load error of the manifest and leaves the store as it was',
    async () => {
      const fixture = tierFixture("new Error('the manifest of this fixture did not load')", []);
      fs.mkdirSync(path.join(fixture.storeDir, 'Tiny'), { recursive: true });
      fs.mkdirSync(path.join(fixture.storeDir, 'Old'));
      writeFile(path.join(fixture.storeDir, 'Tiny', 'kept.json'), '{}');
      const storeBefore = storeSnapshot(fixture.storeDir);

      const run = await runNestedVitest(fixture.project, fixture.args, fixture.env('1'));

      expect(run.code).not.toBe(0);
      const tests = assertionsOf(fixture.jsonFile);
      expect(tests.map((test) => test.status)).toEqual(['failed']);
      const [first] = tests as [(typeof tests)[number]];
      expect(first.failureMessages.join('\n')).toContain('the manifest of this fixture did not load');
      expect(first.failureMessages.join('\n')).not.toContain('to be greater than 0');
      expect(storeSnapshot(fixture.storeDir)).toEqual(storeBefore);
      expect(callsIn(fixture.counter)).toEqual([]);
    },
    NESTED_RUN_TIMEOUT_MS,
  );

  it(
    'removes the orphans of the store at the end of a reuse-mode run whose manifest loaded',
    async () => {
      const fixture = tierFixture(JSON.stringify([holdsEntry, invariantEntry]), ['Tiny', 'Tiny.broken']);
      fs.mkdirSync(path.join(fixture.storeDir, 'Old'), { recursive: true });

      const run = await runNestedVitest(fixture.project, fixture.args, fixture.env('1'));

      expect(run.code).toBe(0);
      expect(fs.readdirSync(fixture.storeDir).sort()).toEqual(['Tiny', 'Tiny.broken']);
    },
    NESTED_RUN_TIMEOUT_MS,
  );
});
