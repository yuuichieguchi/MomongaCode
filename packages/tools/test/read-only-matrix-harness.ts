import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { protectedSetFor, ruleEnforcementOf, momongaLayout } from '@momonga/foundation';
import { EMPTY_GLOB_TABLE, computeFileRules, createGlobDeadline, decide, prepareGlobs, settleGlobs, askedBy } from '@momonga/policy';
import type { Sandbox } from '@momonga/sandbox';
import { createTempDir, isWritableFor, NEVER_CANCELLED, REAL_PROCESS_TEST_TIMEOUT_MS, TEST_SEARCH_PATH, testProbes, testSecretLocations } from '@momonga/testkit';
import { buildSandboxPolicy, createPolicyFilesystem } from '@momonga/tools';
import { makeBuiltins, resultOf } from './builtins/fixtures.ts';
import { collect } from './read-only-collect.ts';
import { approvableForms, exitStatusOf, normalised, outputDiffersByNature, permittedPsStatuses, seesOnlyItsOwnNamespace } from './read-only-forms.ts';
import { HOST_SANDBOX_KIND } from './helpers.ts';
import { HAS_REAL_SANDBOX, realSandbox, recordingSandbox, withoutRefusedXcrunCacheWrite } from './read-only-support.ts';
import type { RecordedSpawn } from './read-only-support.ts';

const FIXED_DATE = '2001-01-01T00:00:00Z';
const GLOB_BUDGET_MS = 60_000;
const PLAIN_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

export const FORMS = approvableForms(process.platform);
export const OTHER_PLATFORM: NodeJS.Platform = process.platform === 'darwin' ? 'linux' : 'darwin';

export const READ_ONLY_SHARDS = 8;

export const shardOf = <T>(items: readonly T[], index: number, count: number): T[] => items.filter((_item, at) => at % count === index);

export type ReadOnlyHarness = {
  decideOn(command: string, filesystem?: ReturnType<typeof createPolicyFilesystem>): ReturnType<typeof decide>;
  runPlain(command: string): { stdout: string; stderr: string; status: ReturnType<typeof exitStatusOf> };
  sandboxed(command: string): Promise<{ stdout: string; stderr: string; status: ReturnType<typeof exitStatusOf> }>;
  writableRoots(): readonly string[];
  project(): string;
};

export const readOnlyHarness = (): ReadOnlyHarness => {
  let base = '';
  let project = '';
  let home = '';
  let plainEnv: NodeJS.ProcessEnv = {};
  let inner: Sandbox;
  let spawned: RecordedSpawn;
  const hostFilesystem = createPolicyFilesystem();
  const filesystem = hostFilesystem;

  const git = (...args: string[]): void => {
    const result = spawnSync('/usr/bin/git', args, { cwd: project, env: { ...plainEnv, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE }, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };

  const decideOn = async (command: string, filesystem = hostFilesystem) => {
    const roots = [project];
    const subject = { kind: 'command', tool: 'Bash', command } as const;
    const globs = await prepareGlobs({ expand: filesystem.expandGlob, platform: filesystem.platform, subject, cwd: project, home, deadline: createGlobDeadline(GLOB_BUDGET_MS), signal: new AbortController().signal });
    return decide({ secretLocations: testSecretLocations(home),
      tool: { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' },
      subject,
      mode: 'manual',
      rules: [],
      roots,
      home,
      cwd: project,
      fileRules: await computeFileRules([], roots, null, ruleEnforcementOf(HOST_SANDBOX_KIND), testProbes()),
      protectedSet: await protectedSetFor(roots, askedBy(filesystem, NEVER_CANCELLED)),
      fs: settleGlobs(filesystem, globs ?? EMPTY_GLOB_TABLE, NEVER_CANCELLED),
      searchPath: TEST_SEARCH_PATH,
      isWritable: isWritableFor(roots),
    });
  };

  const runPlain = (command: string) => {
    const done = spawnSync('/bin/bash', ['-c', command], { cwd: project, env: plainEnv, encoding: 'utf8', maxBuffer: PLAIN_OUTPUT_LIMIT_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout: done.stdout, stderr: done.stderr, status: exitStatusOf(done) };
  };

  const sandboxed = async (command: string) => {
    const { markerFile: _spentMarker, ...replayed } = spawned.command;
    const child = inner.spawn({ ...replayed, argv: ['/bin/bash', '-c', command], cwd: project }, spawned.policy, new AbortController().signal);
    const [stdout, stderr, exit] = await Promise.all([collect((await child).stdout), collect((await child).stderr), (await child).exited]);
    return {
      stdout,
      stderr: withoutRefusedXcrunCacheWrite(stderr, process.platform),
      status: exitStatusOf({ status: exit.code, signal: exit.signal as NodeJS.Signals | null }),
    };
  };

  beforeAll(async () => {
    base = createTempDir();
    project = path.join(base, 'project');
    home = path.join(base, 'home');
    const tmpDir = path.join(base, 'sessions', 'session-0');
    for (const directory of [project, home, tmpDir, path.join(project, 'sub')]) fs.mkdirSync(directory, { recursive: true });
    plainEnv = { HOME: home, PATH: TEST_SEARCH_PATH, LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    fs.writeFileSync(path.join(project, 'tracked'), 'one\ntwo\n');
    fs.writeFileSync(path.join(project, 'stable'), 'same\n');
    fs.writeFileSync(path.join(project, 'sub', 'inner'), 'inner\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'one');
    git('tag', 'v1');
    fs.appendFileSync(path.join(project, 'tracked'), 'three\n');
    fs.writeFileSync(path.join(project, 'untracked'), 'new\n');
    fs.utimesSync(path.join(project, 'stable'), new Date(FIXED_DATE), new Date(FIXED_DATE));

    inner = realSandbox(path.join(base, 'sandbox-tmp'));
    const recorded = recordingSandbox(inner);
    const built = await makeBuiltins({ sandbox: recorded.sandbox });
    const roots = [project];
    const sandboxPolicy = await buildSandboxPolicy({ layout: momongaLayout(home, process.platform, process.env), roots, home, tmpDir, sessionsTmpRoot: path.join(base, 'sessions'), fileRules: await computeFileRules([], roots, tmpDir, ruleEnforcementOf(HOST_SANDBOX_KIND), testProbes()), protectedSet: await protectedSetFor(roots, askedBy(filesystem, NEVER_CANCELLED)), network: 'deny' }, NEVER_CANCELLED);
    resultOf(await built.run('Bash', { command: 'pwd' }, { env: plainEnv as Record<string, string>, roots, home, tmpDir, sandboxPolicy, session: { cwd: project, workingDirectory: project, readLedger: new Map() } }));
    spawned = recorded.spawns[0] as RecordedSpawn;
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  return { decideOn, runPlain, sandboxed, writableRoots: () => spawned.policy.writableRoots, project: () => project };
};

export const expectSameUnderSandbox = async (harness: ReadOnlyHarness, command: string): Promise<void> => {
  const decision = await harness.decideOn(command);
  expect(decision.kind).toBe('allow');
  expect(decision.basis).toBe('read_only');
  expect(harness.writableRoots()).not.toContain(harness.project());
  const plain = harness.runPlain(command);
  const result = await harness.sandboxed(command);
  if (seesOnlyItsOwnNamespace(command)) {
    expect(permittedPsStatuses(command)).toContain(result.status);
    return;
  }
  if (outputDiffersByNature(command)) {
    expect(result.status).toBe(plain.status);
    return;
  }
  expect({ stdout: normalised(command, result.stdout), stderr: normalised(command, result.stderr), status: result.status }).toEqual({
    stdout: normalised(command, plain.stdout),
    stderr: normalised(command, plain.stderr),
    status: plain.status,
  });
};

export const SHARD_TITLE = 'every approvable command form prints the same under the read-only sandbox';

export const readOnlyMatrixShard = (index: number): void => {
  describe.runIf(HAS_REAL_SANDBOX)(`${SHARD_TITLE} (shard ${index + 1} of ${READ_ONLY_SHARDS})`, () => {
    vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });
    const harness = readOnlyHarness();
    it.each(shardOf(FORMS, index, READ_ONLY_SHARDS))('%s', async (command) => {
      await expectSameUnderSandbox(harness, command);
    });
  });
};
