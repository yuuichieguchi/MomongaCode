import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VERIFICATION_COMMANDS, DEFAULT_VERIFICATION_MANIFESTS } from '@momonga/config';
import { HOST_RULE_ENFORCEMENT, ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import type { MemoryRecord } from '@momonga/protocol';
import { DEFAULT_BWRAP_PATH, createBubblewrapSandbox, createPlaceholderJournal, createSeatbeltSandbox, heldMountPoints } from '@momonga/sandbox';
import type { Sandbox } from '@momonga/sandbox';
import type { RuntimeStore } from '@momonga/store';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeTimers, fakePolicyFilesystem, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { enqueue, harness, newSession } from '../../../store/test/helpers.ts';
import { createEvidenceRunner } from '../../src/process/evidence-run.ts';
import { createFakeGateway } from '../worker/fake-gateway.ts';
import { capabilitiesFor } from '../worker/harness.ts';
import { withInProcessFacts } from './in-process-facts.ts';
import { textStep } from '../worker/scripts.ts';
import { bash, exported, fileTool, finishClaimed } from './reflection-fixture.ts';
import { fixedSandboxBindings } from '@momonga/runtime';

const HAS_REAL_SANDBOX = process.platform === 'darwin' || process.platform === 'linux';

const SIGNAL = new AbortController().signal;

const realSandbox = (tmpRoot: string): Sandbox => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  if (process.platform === 'darwin') return createSeatbeltSandbox({ tmpRoot, killGraceMs: 300 });
  if (!fs.existsSync(DEFAULT_BWRAP_PATH)) throw new Error(`the evidence test needs real bwrap at ${DEFAULT_BWRAP_PATH}`);
  return createBubblewrapSandbox({ tmpRoot, killGraceMs: 300, journal: createPlaceholderJournal(`${tmpRoot}-journal`), holders: () => heldMountPoints() });
};

type Reflector = { runOne(signal: AbortSignal): Promise<string> };

const reflectInRepository = async (context: TestContext, options: { trusted: boolean }) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home);
  await ensureMomongaDirs(paths);
  const root = fs.realpathSync(withTempDir(context));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const gitEnv = { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: project, env: gitEnv, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(project, 'a.ts'), 'one\n');
  git('add', 'a.ts');
  git('commit', '-q', '-m', 'one');
  const head = git('rev-parse', 'HEAD');

  const opened = harness();
  const { clock } = opened;
  const store = withInProcessFacts(opened.store, opened.dbPath);
  store.trust.set(project, 'trusted');
  const session = newSession(store, project);
  const gateway = createFakeGateway(capabilitiesFor(100_000, { structuredOutput: 'json_schema' }));
  const settings = {
    trusted: () => options.trusted,
    verification: async () => ({ commands: [...DEFAULT_VERIFICATION_COMMANDS], manifests: [...DEFAULT_VERIFICATION_MANIFESTS] }),
    memory: async () => ({ reflection: { enabled: true }, forgetAfterDays: 90 }),
  };
  const run = enqueue(store, session.id, 'change a');
  await finishClaimed(store, [
    ...fileTool('w1', 'Write', { path: path.join(project, 'a.ts'), sha256: 'a'.repeat(64), access: 'write' }),
    ...bash('t1', 'npm test', 0, 'ok'),
  ]);
  expect(store.reflection.get(run.id)?.state).toBe('pending');
  const evidenceRun = createEvidenceRunner({ paths, home, fs: fakePolicyFilesystem(), sandboxes: fixedSandboxBindings(realSandbox(path.join(root, 'scratch'))), env: { PATH: '/usr/bin:/bin' } });
  const reflector = exported<(options: unknown) => Reflector>('createReflector')({ store, gateway, settings, clock, isIdle: () => true, evidenceRun, maxAttempts: 3, attemptTimeoutMs: 600_000, timers: createFakeTimers(clock), random: () => 0.5 });
  gateway.script.push(textStep(JSON.stringify({ candidates: [{ text: 'a.ts is the entry point', kind: 'fact', paths: ['a.ts'] }] })));
  expect(await reflector.runOne(SIGNAL)).toBe('ran');
  const candidates = (store.memories as RuntimeStore['memories'] & { candidates(): MemoryRecord[] }).candidates();
  return { head, candidates };
};

describe.runIf(HAS_REAL_SANDBOX)('a candidate and the real evidence runner', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('binds the commit that git reports for HEAD, beside the file and the passing check', async (context) => {
    const { head, candidates } = await reflectInRepository(context, { trusted: true });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.evidence).toContainEqual({ kind: 'commit', sha: head });
    expect(candidates[0]?.evidence).toContainEqual({ kind: 'file', project: expect.any(String), path: 'a.ts', sha256: 'a'.repeat(64) });
    expect(candidates[0]?.evidence).toContainEqual(expect.objectContaining({ kind: 'check', command: 'npm test', exitCode: 0 }));
  });

  it('binds no commit when the folder is not trusted at reflection time, because git must not run in it', async (context) => {
    const { candidates } = await reflectInRepository(context, { trusted: false });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.evidence.some((entry) => entry.kind === 'commit')).toBe(false);
  });
});
