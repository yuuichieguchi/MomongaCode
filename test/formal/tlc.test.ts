import { spawn, spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_SETUP_COMMAND, requireTlaJar } from '../../scripts/fetch-tla.ts';
import { systemTempRoot, tempDirPrefixFor, testRunToken } from '../../packages/testkit/src/test-support.ts';
import { createTempRoot, removeTempRoot } from '../../scripts/support/temp.ts';
import { MANIFEST_FORMAT, TLC_WORKERS, discoveryProblems, readManifest, runTlc, verdictProblems } from './manifest.ts';
import type { Manifest, ManifestEntry, TlcRun } from './manifest.ts';
import { groupKiller, killGroup } from './runner.ts';
import { LIVENESS_ARGS, actionPropertyViolationOutput, cfgFor, completedOutput, endlessSpec, holdsEntry, invariantEntry, invariantViolationOutput, runOf, temporalEntry, temporalViolationOutput, tinySpec, writeFile } from './fixtures.ts';
import { describeTier } from './tier.ts';
import { hostTlcRowsAtOnce } from './tlc-rows.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const specDir = path.join(repoRoot, 'specs', 'tla');
const manifestPath = path.join(specDir, 'manifest.json');
const tlcScript = path.join(repoRoot, 'scripts', 'tlc.sh');
const jarPath = path.join(repoRoot, '.cache', 'tla', 'tla2tools.jar');
const REAP_SLACK_MS = 5000;
const FETCH_COMMAND = 'curl -L -o .cache/tla/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar';
const ENDLESS_BUDGET_CPU_SECONDS = 8;

const loadManifest = (): { manifest: Manifest } | { error: Error } => {
  try {
    return { manifest: readManifest(manifestPath) };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
};

const loaded = loadManifest();
const manifestOrThrow = (): Manifest => {
  if ('error' in loaded) throw loaded.error;
  return loaded.manifest;
};

const selectedTier = process.env['MOMONGA_TLC_TIER'] === 'deep' ? 'deep' : 'every-run';
const tierEntries = 'manifest' in loaded ? loaded.manifest.entries.filter((entry) => entry.tier === selectedTier) : loaded.error;
const manifestConfigs = 'manifest' in loaded ? loaded.manifest.entries.map((entry) => entry.config) : [];

const discoveryManifest = (configs: readonly string[], modules: readonly string[] = ['Tiny']): Manifest => ({
  format: MANIFEST_FORMAT,
  unitSuiteSeconds: 100,
  startupCpuSeconds: 3,
  modules: modules.map((module) => ({ module, abstractions: ['the fixture leaves out time'], notProved: ['the fixture proves nothing'] })),
  entries: configs.map((config) => ({ ...holdsEntry, config })),
});

const groupMembers = (pgid: number): number[] =>
  spawnSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
    .stdout.split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, group]) => group === pgid && pid !== undefined)
    .map(([pid]) => pid as number);

const groupGoneWithin = async (pgid: number, deadlineMs: number): Promise<number[]> => {
  const deadline = Date.now() + deadlineMs;
  let members = groupMembers(pgid);
  while (members.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    members = groupMembers(pgid);
  }
  return members;
};

const sandboxWithScript = (root: string, specs: Readonly<Record<string, string>>, withJar: boolean): string => {
  const script = path.join(root, 'scripts', 'tlc.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(tlcScript, script);
  fs.chmodSync(script, 0o755);
  for (const [name, text] of Object.entries(specs)) writeFile(path.join(root, 'specs', 'tla', name), text);
  if (withJar) {
    fs.mkdirSync(path.join(root, '.cache', 'tla'), { recursive: true });
    fs.symlinkSync(jarPath, path.join(root, '.cache', 'tla', 'tla2tools.jar'));
  }
  return script;
};

const pathWithoutJava = (root: string): string => {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const dir of ['/usr/bin', '/bin']) {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'java' || fs.existsSync(path.join(bin, name))) continue;
      fs.symlinkSync(path.join(dir, name), path.join(bin, name));
    }
  }
  return bin;
};

const pathWithOldJava = (root: string): string => {
  const bin = path.join(root, 'old-java-bin');
  writeFile(
    path.join(bin, 'java'),
    ['#!/bin/sh', 'echo "Property settings:" >&2', 'echo "    java.specification.version = 1.7" >&2', 'echo "java version \\"1.7.0_80\\"" >&2', 'exit 0', ''].join('\n'),
  );
  fs.chmodSync(path.join(bin, 'java'), 0o755);
  return `${bin}:/usr/bin:/bin`;
};

const pathWithChattyJava = (root: string): string => {
  const bin = path.join(root, 'chatty-java-bin');
  writeFile(
    path.join(bin, 'java'),
    [
      '#!/bin/sh',
      'echo "Property settings:" >&2',
      'echo "    java.specification.version = 17" >&2',
      'i=0',
      'while [ "$i" -lt 30000 ]; do echo "    other.property.$i = 0123456789012345678901234567890123456789" >&2; i=$((i + 1)); done',
      'exit 0',
      '',
    ].join('\n'),
  );
  fs.chmodSync(path.join(bin, 'java'), 0o755);
  return `${bin}:/usr/bin:/bin`;
};

beforeAll(() => {
  requireTlaJar(repoRoot);
});

describe('the tools the formal suite needs', () => {
  let root = '';

  beforeEach(() => {
    root = createTempRoot();
  });

  afterEach(async () => {
    await removeTempRoot(root);
  });

  it('fails with the setup command, never a skip, in a checkout whose .cache/tla is absent', () => {
    expect(fs.existsSync(path.join(root, '.cache', 'tla'))).toBe(false);
    expect(() => requireTlaJar(root)).toThrow(`run ${TEST_SETUP_COMMAND}`);
    expect(TEST_SETUP_COMMAND).toBe('npm run test:setup');
  });
});

describe('the manifest of specs/tla', () => {
  it('is readable and declares its format', () => {
    expect(manifestOrThrow().format).toBe(MANIFEST_FORMAT);
  });

  it('lists exactly the configurations on disk, each module exists, and every module has a configuration', () => {
    expect(discoveryProblems(specDir, manifestOrThrow())).toEqual([]);
  });

  it('records the measured wall seconds of every entry as a positive number', () => {
    for (const entry of manifestOrThrow().entries) {
      expect(entry.measuredSeconds, entry.config).toBeGreaterThan(0);
    }
  });

  it('records the JVM start-up CPU seconds under load as a positive number', () => {
    const manifest = manifestOrThrow() as Manifest & { readonly startupCpuSeconds?: unknown };
    expect(typeof manifest.startupCpuSeconds).toBe('number');
    expect(manifest.startupCpuSeconds as number).toBeGreaterThan(0);
  });

  it('records measured CPU seconds and derives every CPU budget as twice them rounded up plus the start-up CPU', () => {
    const manifest = manifestOrThrow() as Manifest & { readonly startupCpuSeconds: number };
    for (const entry of manifest.entries as readonly (ManifestEntry & { readonly measuredCpuSeconds: number; readonly budgetCpuSeconds: number })[]) {
      expect(typeof entry.measuredCpuSeconds, entry.config).toBe('number');
      expect(entry.measuredCpuSeconds, entry.config).toBeGreaterThan(0);
      expect(Number.isInteger(entry.budgetCpuSeconds), entry.config).toBe(true);
      expect(entry.budgetCpuSeconds, entry.config).toBe(Math.ceil(2 * entry.measuredCpuSeconds) + manifest.startupCpuSeconds);
    }
  });

  it('records a positive whole number of distinct states for every configuration', () => {
    for (const entry of manifestOrThrow().entries) {
      expect(Number.isInteger(entry.distinctStates) && entry.distinctStates > 0, entry.config).toBe(true);
    }
  });
});

describe('discovery against a spec directory', () => {
  let root = '';

  beforeEach(() => {
    root = createTempRoot();
    writeFile(path.join(root, 'Tiny.tla'), tinySpec);
    writeFile(path.join(root, 'Tiny.cfg'), cfgFor('Small'));
    writeFile(path.join(root, 'Tiny.broken.cfg'), cfgFor('Small'));
  });

  afterEach(async () => {
    await removeTempRoot(root);
  });

  it('finds no problem when the manifest and the disk agree', () => {
    expect(discoveryProblems(root, discoveryManifest(['Tiny', 'Tiny.broken']))).toEqual([]);
  });

  it('fails on a configuration file the manifest does not list', () => {
    writeFile(path.join(root, 'Tiny.extra.cfg'), cfgFor('Small'));
    const problems = discoveryProblems(root, discoveryManifest(['Tiny', 'Tiny.broken']));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Tiny.extra');
  });

  it('fails on a manifest entry with no configuration file on disk', () => {
    const problems = discoveryProblems(root, discoveryManifest(['Tiny', 'Tiny.broken', 'Tiny.gone']));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Tiny.gone');
  });

  it('fails on a configuration whose module does not exist', () => {
    writeFile(path.join(root, 'Ghost.cfg'), cfgFor('Small'));
    const problems = discoveryProblems(root, discoveryManifest(['Tiny', 'Tiny.broken', 'Ghost']));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Ghost');
  });

  it('fails on a module that has no configuration', () => {
    writeFile(path.join(root, 'Lonely.tla'), tinySpec.replace('MODULE Tiny', 'MODULE Lonely'));
    const problems = discoveryProblems(root, discoveryManifest(['Tiny', 'Tiny.broken'], ['Tiny', 'Lonely']));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Lonely');
  });

  it('fails on a module with no entry in the modules of the manifest', () => {
    const problems = discoveryProblems(root, discoveryManifest(['Tiny', 'Tiny.broken'], []));
    expect(problems).toEqual(["Tiny.tla has no entry in the manifest's modules"]);
  });

  it('fails on a modules entry whose module is not on disk', () => {
    const problems = discoveryProblems(root, discoveryManifest(['Tiny', 'Tiny.broken'], ['Tiny', 'Gone']));
    expect(problems).toEqual(["the manifest's modules list Gone, but Gone.tla is not on disk"]);
  });

  it('fails when the same configuration is listed twice', () => {
    const problems = discoveryProblems(root, discoveryManifest(['Tiny', 'Tiny.broken', 'Tiny']));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Tiny');
  });
});

describe('the verdict on one TLC run', () => {
  it('accepts a holding run with exit 0, the completion line and the exact distinct states', () => {
    expect(verdictProblems(holdsEntry, runOf(0, completedOutput(3)))).toEqual([]);
  });

  it('fails a holding entry when TLC exits with a violation code', () => {
    expect(verdictProblems(holdsEntry, runOf(12, invariantViolationOutput('Small')))).not.toEqual([]);
  });

  it('fails a holding entry when the distinct states differ from the record', () => {
    expect(verdictProblems(holdsEntry, runOf(0, completedOutput(4)))).not.toEqual([]);
  });

  it('fails a holding entry when exit 0 comes without the completion line', () => {
    expect(verdictProblems(holdsEntry, runOf(0, '3 states generated, 3 distinct states found, 0 states left on queue.'))).not.toEqual([]);
  });

  it('accepts an invariant violation with the declared exit code and the named invariant', () => {
    expect(verdictProblems(invariantEntry, runOf(12, invariantViolationOutput('Small')))).toEqual([]);
  });

  it('fails an expected violation when TLC exits 0', () => {
    expect(verdictProblems(invariantEntry, runOf(0, completedOutput(3)))).not.toEqual([]);
  });

  it('fails an expected violation when TLC exits with a different code', () => {
    expect(verdictProblems(invariantEntry, runOf(13, invariantViolationOutput('Small')))).not.toEqual([]);
  });

  it('fails an expected violation when a different invariant is violated', () => {
    expect(verdictProblems(invariantEntry, runOf(12, invariantViolationOutput('Other')))).not.toEqual([]);
  });

  it('accepts a temporal violation with exit 13 and the temporal line', () => {
    expect(verdictProblems(temporalEntry, runOf(13, temporalViolationOutput))).toEqual([]);
  });

  it('fails a temporal expectation when TLC exits 12', () => {
    expect(verdictProblems(temporalEntry, runOf(12, temporalViolationOutput))).not.toEqual([]);
  });

  it('accepts an action property violation with exit 13 and the named property', () => {
    expect(verdictProblems(temporalEntry, runOf(13, actionPropertyViolationOutput('Settles')))).toEqual([]);
  });

  it('fails an action property violation that names another property', () => {
    expect(verdictProblems(temporalEntry, runOf(13, actionPropertyViolationOutput('Other')))).not.toEqual([]);
  });

  it('fails a run killed at its budget', () => {
    const killed: TlcRun = { ...runOf(0, ''), exitCode: null, signal: 'SIGKILL', killedAtCpuBudget: true };
    expect(verdictProblems(holdsEntry, killed)).not.toEqual([]);
  });

  it.each([
    [3, `tla2tools.jar is missing\n  fetch: ${FETCH_COMMAND}\n`],
    [5, 'java.specification.version 1.8 or later is required; install a JDK on macOS or openjdk-17-jre-headless on Debian\n'],
  ])('fails with the script stderr when the script exits %i', (code, stderr) => {
    const problems = verdictProblems(holdsEntry, runOf(code, '', stderr));
    expect(problems).not.toEqual([]);
    expect(problems.join('\n')).toContain(stderr.trim());
  });
});

describe('running tlc.sh under the harness', () => {
  let root = '';

  beforeEach(() => {
    root = createTempRoot();
  });

  afterEach(async () => {
    await removeTempRoot(root);
  });

  it('runs TLC on half the cores, rounded up', () => {
    expect(TLC_WORKERS).toBe(Math.ceil(os.availableParallelism() / 2));
  });

  it('passes the config, its args and the worker count, and owns a leak-guarded metadir that it removes', async () => {
    const script = path.join(root, 'echo-tlc.sh');
    writeFile(script, ['#!/bin/sh', 'echo "ARGS $*"', 'echo "METADIR $TLC_METADIR"', 'test -d "$TLC_METADIR" && echo "METADIR_EXISTS"', 'exit 0', ''].join('\n'));
    fs.chmodSync(script, 0o755);
    const run = await runTlc({ script, config: 'RunRecovery.liveNone', args: LIVENESS_ARGS, budgetCpuSeconds: 30 });
    expect(run.exitCode).toBe(0);
    const argsLine = run.stdout.split('\n').find((line) => line.startsWith('ARGS ')) ?? '';
    const argv = argsLine.slice('ARGS '.length).split(' ');
    expect(argv[0]).toBe('RunRecovery.liveNone');
    expect(argv.slice(1).join(' ')).toContain('-lncheck final');
    expect(argv.slice(1).join(' ')).toContain(`-workers ${TLC_WORKERS}`);
    const metadir = (run.stdout.split('\n').find((line) => line.startsWith('METADIR ')) ?? '').slice('METADIR '.length);
    expect(metadir).toBe(run.metadir);
    expect(path.dirname(run.metadir)).toBe(systemTempRoot());
    expect(path.basename(run.metadir).startsWith(tempDirPrefixFor(testRunToken()))).toBe(true);
    expect(run.stdout).toContain('METADIR_EXISTS');
    expect(fs.existsSync(run.metadir)).toBe(false);
  });

  it(
    'fails a missing jar with the fetch command, never a skip',
    async () => {
      const script = sandboxWithScript(root, { 'Tiny.tla': tinySpec, 'Tiny.cfg': cfgFor('Small') }, false);
      const run = await runTlc({ script, config: 'Tiny', args: [], budgetCpuSeconds: 30 });
      expect(run.exitCode).toBe(3);
      const problems = verdictProblems(holdsEntry, run);
      expect(problems).not.toEqual([]);
      expect(problems.join('\n')).toContain('https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar');
      expect(problems.join('\n')).toContain('curl -L -o');
    },
    30000 + REAP_SLACK_MS,
  );

  it(
    'fails a missing java with the requirement and the install hints, never a skip',
    async () => {
      const script = sandboxWithScript(root, { 'Tiny.tla': tinySpec, 'Tiny.cfg': cfgFor('Small') }, true);
      const run = await runTlc({ script, config: 'Tiny', args: [], budgetCpuSeconds: 30, env: { PATH: pathWithoutJava(root) } });
      expect(run.exitCode).toBe(5);
      const problems = verdictProblems(holdsEntry, run).join('\n');
      expect(problems).toContain('java.specification.version');
      expect(problems).toContain('1.8');
      expect(problems).toContain('openjdk-17-jre-headless');
    },
    30000 + REAP_SLACK_MS,
  );

  it(
    'fails a java older than 1.8 with the requirement and the install hints',
    async () => {
      const script = sandboxWithScript(root, { 'Tiny.tla': tinySpec, 'Tiny.cfg': cfgFor('Small') }, true);
      const run = await runTlc({ script, config: 'Tiny', args: [], budgetCpuSeconds: 30, env: { PATH: pathWithOldJava(root) } });
      expect(run.exitCode).toBe(5);
      const problems = verdictProblems(holdsEntry, run).join('\n');
      expect(problems).toContain('1.8');
      expect(problems).toContain('openjdk-17-jre-headless');
    },
    30000 + REAP_SLACK_MS,
  );

  it(
    'reads a java whose settings list is far larger than a pipe without dying of SIGPIPE',
    async () => {
      const script = sandboxWithScript(root, { 'Tiny.tla': tinySpec, 'Tiny.cfg': cfgFor('Small') }, false);
      const run = await runTlc({ script, config: 'Tiny', args: [], budgetCpuSeconds: 30, env: { PATH: pathWithChattyJava(root) } });
      expect(run.exitCode).toBe(3);
    },
    30000 + REAP_SLACK_MS,
  );

  const unparsableModule = ['---- MODULE Broken ----', 'VARIABLE x', 'Init == x = = 0', '===='].join('\n');
  const brokenInputs = [
    ['a module that does not parse', 'Broken', { 'Broken.tla': unparsableModule, 'Broken.cfg': cfgFor('Small') }],
    ['a configuration that names an undefined invariant', 'Tiny.undefined', { 'Tiny.tla': tinySpec, 'Tiny.undefined.cfg': cfgFor('Undefined') }],
  ] as const;

  it.each(brokenInputs.flatMap(([input, config, specs]) => [holdsEntry, invariantEntry].map((entry) => [input, entry.expect === 'holds' ? 'holds' : 'violates', config, specs, entry] as const)))(
    'reports the exit code, the configuration and the whole output of TLC for %s expected to %s',
    async (_input, _expectation, config, specs, entry) => {
      const script = sandboxWithScript(root, specs, true);
      const run = await runTlc({ script, config, args: [], budgetCpuSeconds: 30 });
      expect(run.killedAtCpuBudget).toBe(false);
      expect(run.exitCode).not.toBeNull();
      expect([0, 12, 13]).not.toContain(run.exitCode);
      expect(run.stdout.trim().length + run.stderr.trim().length).toBeGreaterThan(0);
      const report = verdictProblems({ ...entry, config }, run).join('\n');
      expect(report).toContain(config);
      expect(report).toContain(`exited ${run.exitCode}`);
      expect(report).toContain(run.stdout.trim());
      expect(report).toContain(run.stderr.trim());
    },
    30000 + REAP_SLACK_MS,
  );

  it(
    'keeps the standard modules TLC unpacks inside its own run, never in the shared Java temporary directory',
    async () => {
      const shared = path.join(root, 'shared-java-tmp');
      const foreign = path.join(shared, 'Naturals.tla');
      writeFile(foreign, 'owned by another run');
      const script = sandboxWithScript(root, { 'Tiny.tla': tinySpec, 'Tiny.cfg': cfgFor('Small') }, true);
      const run = await runTlc({ script, config: 'Tiny', args: [], budgetCpuSeconds: 30, env: { JAVA_TOOL_OPTIONS: `-Djava.io.tmpdir=${shared}` } });
      expect(run.exitCode).toBe(0);
      expect(fs.readdirSync(shared)).toEqual(['Naturals.tla']);
      expect(fs.readFileSync(foreign, 'utf8')).toBe('owned by another run');
    },
    30000 + REAP_SLACK_MS,
  );

  it(
    'kills the script and its JVM as one process group at the CPU budget and leaves no JVM',
    async () => {
      const script = sandboxWithScript(root, { 'Endless.tla': endlessSpec, 'Endless.cfg': cfgFor('Fine') }, true);
      const run = await runTlc({ script, config: 'Endless', args: [], budgetCpuSeconds: ENDLESS_BUDGET_CPU_SECONDS });
      expect(run.killedAtCpuBudget).toBe(true);
      expect(run.signal).toBe('SIGKILL');
      expect(run.stdout).toContain('TLC2 Version');
      expect(await groupGoneWithin(run.pid, REAP_SLACK_MS)).toEqual([]);
      expect(fs.existsSync(run.metadir)).toBe(false);
      expect(verdictProblems({ ...holdsEntry, config: 'Endless', budgetCpuSeconds: ENDLESS_BUDGET_CPU_SECONDS }, run)).not.toEqual([]);
    },
    ENDLESS_BUDGET_CPU_SECONDS * TLC_WORKERS * 1000 + 2 * REAP_SLACK_MS,
  );
});

type CpuRunOptions = { readonly script: string; readonly config: string; readonly args: readonly string[]; readonly budgetCpuSeconds: number };
type CpuRun = TlcRun & { readonly killedAtCpuBudget: boolean };

const runUnderCpuBudget = (options: CpuRunOptions): Promise<CpuRun> => (runTlc as unknown as (options: CpuRunOptions) => Promise<CpuRun>)(options);

const CPU_BUDGET_SECONDS = 2;
const IDLE_WALL_GUARD_MS = CPU_BUDGET_SECONDS * TLC_WORKERS * 1000;

describe('the CPU budget of the harness', () => {
  let root = '';

  beforeEach(() => {
    root = createTempRoot();
  });

  afterEach(async () => {
    await removeTempRoot(root);
  });

  const standIn = (name: string, lines: readonly string[]): string => {
    const script = path.join(root, name);
    writeFile(script, ['#!/bin/sh', ...lines, ''].join('\n'));
    fs.chmodSync(script, 0o755);
    return script;
  };

  it(
    'kills a process that burns CPU past its CPU budget as one process group and says the CPU budget was exceeded',
    async () => {
      const script = standIn('burn.sh', ['echo STARTED', 'while :; do :; done']);
      const run = await runUnderCpuBudget({ script, config: 'Burn', args: [], budgetCpuSeconds: CPU_BUDGET_SECONDS });
      expect(run.killedAtCpuBudget).toBe(true);
      expect(run.stdout).toContain('STARTED');
      expect(run.signal).toBe('SIGKILL');
      expect(await groupGoneWithin(run.pid, REAP_SLACK_MS)).toEqual([]);
    },
    IDLE_WALL_GUARD_MS + 30000,
  );

  it(
    'lets a process that sleeps longer than its CPU budget in wall seconds complete without a kill',
    async () => {
      const sleepSeconds = CPU_BUDGET_SECONDS + 2;
      expect(sleepSeconds * 1000).toBeLessThan(IDLE_WALL_GUARD_MS);
      const script = standIn('idle.sh', [`sleep ${sleepSeconds}`, 'echo DONE', 'exit 0']);
      const startedAt = Date.now();
      const run = await runUnderCpuBudget({ script, config: 'Idle', args: [], budgetCpuSeconds: CPU_BUDGET_SECONDS });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(sleepSeconds * 1000);
      expect(run.killedAtCpuBudget).toBe(false);
      expect(run.exitCode).toBe(0);
      expect(run.signal).toBeNull();
      expect(run.stdout).toContain('DONE');
    },
    IDLE_WALL_GUARD_MS + REAP_SLACK_MS,
  );

  it(
    'counts the CPU of a child process toward the budget, not only the parent',
    async () => {
      const script = standIn('parent.sh', ["sh -c 'while :; do :; done' &", 'echo CHILD_STARTED', 'sleep 30', 'echo PARENT_DONE', 'exit 0']);
      const run = await runUnderCpuBudget({ script, config: 'Parent', args: [], budgetCpuSeconds: CPU_BUDGET_SECONDS });
      expect(run.killedAtCpuBudget).toBe(true);
      expect(run.stdout).toContain('CHILD_STARTED');
      expect(run.stdout).not.toContain('PARENT_DONE');
      expect(run.signal).toBe('SIGKILL');
      expect(await groupGoneWithin(run.pid, REAP_SLACK_MS)).toEqual([]);
    },
    45000,
  );
});

const ZOMBIE_GROUP_POLLS = 40;

const zombieGroupsOf = (parentPid: number): number[] =>
  spawnSync('ps', ['-A', '-o', 'pid=,pgid=,ppid=,stat='], { encoding: 'utf8' })
    .stdout.split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([pid, pgid, ppid, stat]) => Number(ppid) === parentPid && pid === pgid && stat?.startsWith('Z') === true)
    .map(([, pgid]) => Number(pgid));

describe('killing a process group', () => {
  it('treats a group whose only members are zombies as already killed', async () => {
    const holder = spawn('perl', ['-e', 'my $child = fork; if ($child == 0) { setpgrp(0, 0); exit 0 } exec "sleep", "60"'], { stdio: 'ignore' });
    try {
      const holderPid = holder.pid as number;
      let groups = zombieGroupsOf(holderPid);
      for (let poll = 0; groups.length === 0 && poll < ZOMBIE_GROUP_POLLS; poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        groups = zombieGroupsOf(holderPid);
      }
      expect(groups).toHaveLength(1);
      const [zombieGroup] = groups as [number];
      expect(() => killGroup(zombieGroup)).not.toThrow();
    } finally {
      holder.kill('SIGKILL');
    }
  });

  const refusedGroupSignal = (): never => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  };
  const killerSeeing = (rows: string[]) => groupKiller({ signalGroup: refusedGroupSignal, groupStates: () => `${rows.join('\n')}\n` });

  it.each([
    ['a macOS member that is exiting', ['41 40 ?E', '42 40 RE']],
    ['a macOS zombie', ['41 40 Z']],
    ['a Linux zombie', ['41 40 Z+']],
    ['a Linux dead task', ['41 40 X']],
  ])('treats a refused group signal as done when the only members left are %s', (_label, rows) => {
    expect(() => killerSeeing([...rows, '50 51 R', '52 53 S'])(40)).not.toThrow();
  });

  it.each([
    ['a macOS runnable member', '41 40 R'],
    ['a macOS sleeping member', '41 40 Ss'],
    ['a Linux uninterruptible member', '41 40 D'],
    ['a Linux stopped member', '41 40 T'],
  ])('rethrows a refused group signal while %s can still run', (_label, row) => {
    expect(() => killerSeeing(['42 40 ?E', row])(40)).toThrow('kill EPERM');
  });
});

describe('the rows of a tier run at once', () => {
  const root = createTempRoot();
  const modules = [{ module: 'Tiny', abstractions: ['time'], notProved: ['liveness of Tiny'] }];

  const rowsOf = (tier: 'deep' | 'every-run', count: number): ManifestEntry[] =>
    Array.from({ length: count }, (_unused, index) => ({
      config: `Tiny.${tier === 'deep' ? 'deep' : 'every'}${index}`,
      role: 'check',
      expect: 'holds',
      args: [],
      tier,
      distinctStates: 3,
      measuredSeconds: 1,
      measuredCpuSeconds: 1,
      budgetCpuSeconds: 5,
    }));

  const sleepingScript = (name: string, log: string): string => {
    const script = path.join(root, `${name}.sh`);
    writeFile(path.join(root, `${name}-output`), `${completedOutput(3)}\n`);
    writeFile(script, ['#!/bin/sh', `echo "start $1" >> "${log}"`, 'sleep 1', `echo "end $1" >> "${log}"`, `cat "${path.join(root, `${name}-output`)}"`, 'exit 0', ''].join('\n'));
    fs.chmodSync(script, 0o755);
    return script;
  };

  const deepLog = path.join(root, 'deep.log');
  const everyRunLog = path.join(root, 'every-run.log');
  const deepRows = rowsOf('deep', 3);
  const everyRunRows = rowsOf('every-run', 3);

  afterAll(() => removeTempRoot(root));

  describeTier({
    tier: 'deep',
    entries: deepRows,
    modules,
    manifestConfigs: deepRows.map((entry) => entry.config),
    script: sleepingScript('deep', deepLog),
    repoRoot: root,
    env: {},
  });

  describeTier({
    tier: 'every-run',
    entries: everyRunRows,
    modules,
    manifestConfigs: everyRunRows.map((entry) => entry.config),
    script: sleepingScript('every-run', everyRunLog),
    repoRoot: root,
    env: {},
  });

  const mostAtOnce = (log: string): number => {
    let running = 0;
    let most = 0;
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : [];
    for (const line of lines) {
      if (line.startsWith('start ')) running += 1;
      if (line.startsWith('end ')) running -= 1;
      most = Math.max(most, running);
    }
    return most;
  };

  describe('the rows of a tier run at once', () => {
    it('runs the deep rows as many at once as the formula of the host allows', () => {
      expect(fs.readFileSync(deepLog, 'utf8').split('\n').filter((line) => line.startsWith('end ')).length).toBe(deepRows.length);
      expect(mostAtOnce(deepLog)).toBe(Math.min(deepRows.length, hostTlcRowsAtOnce()));
    });

    it('runs the every-run rows one at a time', () => {
      expect(mostAtOnce(everyRunLog)).toBe(1);
    });
  });
});

describeTier({ tier: selectedTier, entries: tierEntries, modules: 'manifest' in loaded ? loaded.manifest.modules : [], manifestConfigs, script: tlcScript, repoRoot, env: process.env });
