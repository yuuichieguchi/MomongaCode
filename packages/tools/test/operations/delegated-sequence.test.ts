import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { supersededVerdictOf } from '@momonga/policy';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startFakeForge, startFakeGitHttp } from '@momonga/testkit';
import { COVERED_PROGRAMS, OPERATION_SPECS, createForgeAccess, createOperationTools, hostGitReader, loadForgeDescriptors, supersededForms } from '@momonga/tools';
import type { CallOutcome, ResultOutcome } from '@momonga/tools';
import { mintServerCertificate } from '../../../cli/test/minted-certificates.ts';
import { call, makeHarness, toolSetOf } from '../harness.ts';
import { makeLayout, ruleFor } from '../helpers.ts';
import type { Layout } from '../helpers.ts';
import { TEST_FETCH, countingRunner, makeGitWorld, onCleanup } from './support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const CREDENTIAL = 'fake-forge-credential-for-tests';
const TLS_HOST = 'localhost';
const FORMS = supersededForms(OPERATION_SPECS);

const MANDATE_ALLOW = ['GitBranch', 'GitStage', 'GitCommit', 'GitFetch(origin:main)', 'GitUpdate(:main)', 'GitPush(origin:feature/*)', 'PullRequestCreate(*)'];

const setup = async () => {
  const world = makeGitWorld();
  const served = path.join(world.base, 'served');
  const bare = path.join(served, 'acme', 'widgets.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  fs.renameSync(world.bare, bare);
  const minted = mintServerCertificate(TLS_HOST);
  const caFile = path.join(world.base, 'ca.pem');
  fs.writeFileSync(caFile, minted.caPem);
  fs.appendFileSync(world.env['GIT_CONFIG_GLOBAL'] as string, `[http]\n\tsslCAInfo = ${caFile}\n`);
  const descriptor = loadForgeDescriptors().find((candidate) => candidate.id === 'github');
  if (descriptor === undefined) throw new Error('no shipped descriptor with id github');
  const gitServer = await startFakeGitHttp({ projectRoot: served, username: descriptor.auth.gitUsername, password: CREDENTIAL, tls: { certPem: minted.certPem, keyPem: minted.keyPem, host: TLS_HOST } });
  onCleanup(() => gitServer.close());
  const forge = await startFakeForge('hub', CREDENTIAL);
  onCleanup(() => forge.close());

  world.git(world.work, 'remote', 'set-url', 'origin', path.join(served, 'acme', 'widgets.git'));
  world.write('a.txt', 'one\n');
  world.commitAll('base');
  world.git(world.work, 'push', '-q', 'origin', 'main');
  const other = path.join(world.base, 'other');
  world.git(world.base, 'clone', '-q', bare, other);
  fs.writeFileSync(path.join(other, 'upstream.txt'), 'from a colleague\n');
  world.git(other, 'add', 'upstream.txt');
  world.git(other, 'commit', '-q', '-m', 'colleague');
  world.git(other, 'push', '-q', 'origin', 'main');
  world.git(world.work, 'remote', 'set-url', 'origin', `${gitServer.origin}/acme/widgets.git`);

  const runner = countingRunner();
  const tools = createOperationTools({
    runArgv: runner.run,
    readGit: hostGitReader,
    forge: createForgeAccess({
      descriptors: [descriptor],
      instances: [{ id: 'local', descriptor: descriptor.id, host: gitServer.host, apiBaseUrl: forge.origin, credential: { env: 'FAKE_FORGE_TOKEN' } }],
      fetch: TEST_FETCH,
      readCredential: async () => CREDENTIAL,
    }),
    settings: {},
  });
  const toolSet = await toolSetOf(...tools);
  const harness = makeHarness();
  const layout: Layout = { ...makeLayout(), root: world.base, home: world.home, project: world.work, outside: path.join(world.base, 'outside') };
  const rules = MANDATE_ALLOW.map((text) => ruleFor(layout)('allow', text));
  let sequence = 0;
  const run = async (name: string, args: unknown): Promise<CallOutcome | undefined> => {
    sequence += 1;
    const [outcome] = await harness.executor.runBatch({
      ...(await harness.input(toolSet, [call(`c${sequence}`, name, args)], {
        env: world.env,
        roots: [world.work],
        home: world.home,
        session: { cwd: world.work, workingDirectory: world.work, readLedger: new Map() },
        rules,
        mandate: { supersededForms: FORMS, coveredPrograms: COVERED_PROGRAMS },
        hold: { blockers: [] },
      })),
      step: sequence,
    });
    return outcome;
  };
  return { world, bare, forge, runner, run };
};

const completed = (outcome: CallOutcome | undefined): ResultOutcome['result'] => {
  expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
  return (outcome as ResultOutcome).result;
};

describe('a run under a mandate does the whole job through operations, with no person', () => {
  it('switches to a new branch, stages, commits, fetches and updates, pushes over https, opens a pull request and reads its status, and no call asks', async () => {
    const { world, bare, forge, runner, run } = await setup();
    const outcomes: Array<CallOutcome | undefined> = [];
    const step = async (name: string, args: unknown): Promise<ResultOutcome['result']> => {
      const outcome = await run(name, args);
      outcomes.push(outcome);
      return completed(outcome);
    };

    await step('GitFetch', { remote: 'origin', branch: 'main' });
    await step('GitUpdate', { remote: 'origin', branch: 'main' });
    expect(fs.existsSync(path.join(world.work, 'upstream.txt'))).toBe(true);
    await step('GitBranch', { name: 'feature/x', create: true });
    world.write('a.txt', 'two\n');
    world.write('new.txt', 'new\n');
    await step('GitStage', { paths: ['a.txt', 'new.txt'] });
    await step('GitCommit', { message: 'Change a and add new' });
    const head = world.git(world.work, 'rev-parse', 'HEAD');
    await step('GitPush', { remote: 'origin', branch: 'feature/x' });
    expect(world.git(bare, 'rev-parse', 'refs/heads/feature/x')).toBe(head);
    forge.branchSha.set('feature/x', head);
    const created = await step('PullRequestCreate', { head: 'feature/x', base: 'main', title: 'Change a', body: 'Changes a and adds new', headSha: head });
    expect(created.output).toContain(forge.urlOf(1));
    const status = await step('PullRequestStatus', { number: 1 });
    expect(status.output).toContain(head);

    expect(outcomes.map((outcome) => outcome?.kind)).toEqual(outcomes.map(() => 'result'));
    expect(forge.openPullsFor('feature/x', 'main')).toHaveLength(1);
    expect(world.git(world.work, 'log', '-1', '--format=%s')).toBe('Change a and add new');
    expect(world.git(world.work, 'status', '--porcelain')).toBe('');
    expect(runner.calls.flat().some((argument) => argument.includes(CREDENTIAL))).toBe(false);
    expect(JSON.stringify(outcomes)).not.toContain(CREDENTIAL);
  });

  it('denies an operation the mandate does not allow instead of asking', async () => {
    const { run } = await setup();
    const outcome = await run('GitPush', { remote: 'origin', branch: 'main' });
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed', denial: { source: 'mandate' } } });
  });

  it.each([
    ['git add a.txt', 'GitStage'],
    ['git fetch origin main', 'GitFetch'],
    ['git pull --ff-only', 'GitUpdate'],
    ['git switch -c feature/x', 'GitBranch'],
    ['git commit -m x', 'GitCommit'],
    ['git push origin feature/x', 'GitPush'],
    ['gh pr create --fill', 'PullRequestCreate'],
    ['gh pr view 1', 'PullRequestStatus'],
  ])('names the operation that replaces the Bash form %s', (command, operation) => {
    expect(supersededVerdictOf(command, FORMS, undefined, COVERED_PROGRAMS)).toMatchObject({ kind: 'superseded', form: { operation } });
  });
});
