import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createTempDir } from '@momonga/testkit';
import { spawnSync } from '@momonga/testkit/child-process';
import { REUSE_RECORD_FORMAT, createRepoDigests, globalsOf, harnessOf, readRecord, fileFiltersOf, projectsOf, replayedSelected, inputsOf, isReplayable, recordFor, replayedLine, testReuseModeOf } from './support/test-reuse.ts';
import type { ReuseGlobals } from './support/test-reuse.ts';

const GLOBALS: ReuseGlobals = { node: 'v24.0.0', platform: 'darwin', arch: 'arm64', harness: { unit: { 'package-lock.json': 'lock' }, e2e: { 'package-lock.json': 'lock' } }, env: {} };

const digestsOf = (files: Record<string, string>) => ({
  digestOf: (file: string): string => (file in files ? `file:${files[file]}` : 'absent'),
  treeDigest: (): string => JSON.stringify(files),
});

describe('the reuse mode of a test run', () => {
  it('replays only under MOMONGA_TEST_REUSE=1, never when it is 0 or unset, and refuses another value', () => {
    expect(testReuseModeOf({ MOMONGA_TEST_REUSE: '1' })).toBe('on');
    expect(testReuseModeOf({ MOMONGA_TEST_REUSE: '0' })).toBe('off');
    expect(testReuseModeOf({})).toBe('off');
    expect(() => testReuseModeOf({ MOMONGA_TEST_REUSE: 'yes' })).toThrow(/MOMONGA_TEST_REUSE/);
  });

  it('npm test never replays and npm run test:reuse does', () => {
    const scripts = (JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['test']).toMatch(/(^| )MOMONGA_TEST_REUSE=0 /);
    expect(scripts['test:reuse']).toMatch(/(^| )MOMONGA_TEST_REUSE=1 /);
  });
});

describe('the record of a green test file', () => {
  const files = { 'test/a.test.ts': '1', 'src/a.ts': '2', 'src/b.ts': '3' };

  it('is replayed while every input it observed is unchanged', () => {
    const record = recordFor({ project: 'unit', file: 'test/a.test.ts', inputs: ['test/a.test.ts', 'src/a.ts'], whole: false }, digestsOf(files), GLOBALS);
    expect(record.format).toBe(REUSE_RECORD_FORMAT);
    expect(isReplayable(record, digestsOf(files), GLOBALS)).toBe(true);
    expect(isReplayable(record, digestsOf({ ...files, 'src/b.ts': 'changed' }), GLOBALS)).toBe(true);
  });

  it('is not replayed when one input changed, or when an input that was absent appeared', () => {
    const record = recordFor({ project: 'unit', file: 'test/a.test.ts', inputs: ['test/a.test.ts', 'src/a.ts', 'src/missing.json'], whole: false }, digestsOf(files), GLOBALS);
    expect(isReplayable(record, digestsOf({ ...files, 'src/a.ts': 'changed' }), GLOBALS)).toBe(false);
    expect(isReplayable(record, digestsOf({ ...files, 'src/missing.json': 'new' }), GLOBALS)).toBe(false);
  });

  it('of a file that started a child process is replayed only while no tracked file of the repository changed', () => {
    const record = recordFor({ project: 'e2e', file: 'test/a.test.ts', inputs: ['test/a.test.ts'], whole: true }, digestsOf(files), GLOBALS);
    expect(isReplayable(record, digestsOf(files), GLOBALS)).toBe(true);
    expect(isReplayable(record, digestsOf({ ...files, 'src/b.ts': 'changed' }), GLOBALS)).toBe(false);
  });

  it('is not replayed under another Node version, lockfile, harness file or MOMONGA_ variable', () => {
    const record = recordFor({ project: 'unit', file: 'test/a.test.ts', inputs: ['test/a.test.ts'], whole: false }, digestsOf(files), GLOBALS);
    expect(isReplayable(record, digestsOf(files), { ...GLOBALS, node: 'v25.0.0' })).toBe(false);
    expect(isReplayable(record, digestsOf(files), { ...GLOBALS, harness: { ...GLOBALS.harness, unit: { 'package-lock.json': 'other' } } })).toBe(false);
    expect(isReplayable(record, digestsOf(files), { ...GLOBALS, env: { MOMONGA_TLC_TIER: 'deep' } })).toBe(false);
  });

  it('is not replayed for a file of another project or another path', () => {
    const record = recordFor({ project: 'unit', file: 'test/a.test.ts', inputs: ['test/a.test.ts'], whole: false }, digestsOf(files), GLOBALS);
    expect(isReplayable({ ...record, project: 'e2e' }, digestsOf(files), GLOBALS)).toBe(false);
    expect(isReplayable({ ...record, file: 'test/b.test.ts' }, digestsOf(files), GLOBALS)).toBe(false);
  });
});

describe('the inputs a test file observed', () => {
  it('are the repository files it imported or read, as repository paths, without node_modules, the reuse store, paths outside the repository and paths no file can have', () => {
    const root = path.join(path.sep, 'repo');
    expect(
      inputsOf(root, [
        path.join(root, 'test', 'a.test.ts'),
        path.join(root, 'packages', 'x', 'src', 'a.ts'),
        path.join(root, 'node_modules', 'vitest', 'index.js'),
        path.join(root, '.cache', 'test-reuse', 'unit', 'r.json'),
        path.join(path.sep, 'tmp', 'scratch'),
        path.join(root, 'test', 'a.test.ts'),
        path.join(root, 'a\0b'),
        root,
      ]),
    ).toEqual(['', 'packages/x/src/a.ts', 'test/a.test.ts']);
  });
});

describe('the digests of the repository', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tell a file by its content, a directory by its listing and an absent path apart', () => {
    const root = createTempDir();
    made.push(root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'one');
    fs.mkdirSync(path.join(root, 'dir'));
    fs.writeFileSync(path.join(root, 'dir', 'b.txt'), 'two');
    const before = createRepoDigests(root, ['a.txt', 'dir/b.txt']);
    const file = before.digestOf('a.txt');
    const listing = before.digestOf('dir');
    expect(before.digestOf('missing')).toBe('absent');
    expect(before.digestOf(`${'x'.repeat(300)}/y`)).toBe('absent');
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed');
    fs.writeFileSync(path.join(root, 'dir', 'c.txt'), 'three');
    const after = createRepoDigests(root, ['a.txt', 'dir/b.txt']);
    expect(after.digestOf('a.txt')).not.toBe(file);
    expect(after.digestOf('dir')).not.toBe(listing);
    expect(after.treeDigest()).not.toBe(before.treeDigest());
  });
});

describe('the line of replayed files', () => {
  it('counts the files the run replayed', () => {
    expect(replayedLine(12)).toBe('Replayed 12 test files, unchanged since their last green run on this machine');
  });
});

describe('the replayed files a run counts', () => {
  const replayed = new Map([['unit', ['test/a.test.ts', 'test/b.test.ts']], ['e2e', ['e2e/c.test.ts']]]);

  it('are the replayed files of the projects and the file filters the run names', () => {
    const whole = ['node', 'vitest', 'run', '--project', 'unit', '--project', 'e2e', '--project', 'packaging'];
    expect(replayedSelected(replayed, projectsOf(whole), fileFiltersOf(whole))).toBe(3);
    const named = ['node', 'vitest', 'run', '--project', 'unit', 'test/a.test.ts', '-t', 'name'];
    expect(replayedSelected(replayed, projectsOf(named), fileFiltersOf(named))).toBe(1);
  });
});

describe('the harness files in the key of a project', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const repoOf = (files: Record<string, string>): string => {
    const root = createTempDir();
    roots.push(root);
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    return root;
  };

  const repo = {
    'package.json': '{}',
    'vitest.config.ts': "import { plan } from './test/support/plan.ts';\n",
    'test/support/plan.ts': "export const plan = 1;\n",
    'test/support/unit-setup.ts': "import { shared } from './shared.ts';\n",
    'test/support/shared.ts': "import x from '@momonga/foundation';\n",
    'packages/foundation/package.json': JSON.stringify({ name: '@momonga/foundation', exports: { '.': './src/index.ts' } }),
    'packages/foundation/src/index.ts': "export * from './a.ts';\n",
    'packages/foundation/src/a.ts': 'export const a = 1;\n',
    'e2e/global-setup.ts': "import { ledger } from './support/ledger.ts';\n",
    'e2e/support/ledger.ts': 'export const ledger = 1;\n',
    'test/support/loaded.ts': 'export const loaded = 1;\n',
    'packages/vendored/package.json': JSON.stringify({ name: '@momonga/vendored', exports: { './lite': { types: './lite.d.ts', default: './lite.js' } } }),
  };
  const spec = { shared: ['package.json', 'vitest.config.ts'], projects: { unit: ['test/support/unit-setup.ts'], e2e: ['e2e/global-setup.ts'] } };

  it('holds the config and the setup files of each project with their static import closure, computed', () => {
    const harness = harnessOf(repoOf(repo), spec);

    expect(harness['unit']).toEqual(['package.json', 'packages/foundation/src/a.ts', 'packages/foundation/src/index.ts', 'test/support/plan.ts', 'test/support/shared.ts', 'test/support/unit-setup.ts', 'vitest.config.ts']);
    expect(harness['e2e']).toEqual(['e2e/global-setup.ts', 'e2e/support/ledger.ts', 'package.json', 'test/support/plan.ts', 'vitest.config.ts']);
  });

  const recordsUnder = (files: Record<string, string>) => {
    const root = repoOf(files);
    const digests = createRepoDigests(root, Object.keys(files));
    const globals = globalsOf(harnessOf(root, spec), digests, {});
    return { digests, globals };
  };

  const changed = (file: string) => ({ ...repo, [file]: `${repo[file as keyof typeof repo]}// edited\n` });

  it('leaves a unit record replayable after an edit to a support file only the e2e setup loads', () => {
    const before = recordsUnder(repo);
    const unit = recordFor({ project: 'unit', file: 'test/a.test.ts', inputs: [], whole: false }, before.digests, before.globals);
    const e2e = recordFor({ project: 'e2e', file: 'e2e/a.test.ts', inputs: [], whole: false }, before.digests, before.globals);
    const after = recordsUnder(changed('e2e/support/ledger.ts'));

    expect(isReplayable(unit, after.digests, after.globals)).toBe(true);
    expect(isReplayable(e2e, after.digests, after.globals)).toBe(false);
  });

  it('invalidates exactly the records whose test file loaded an edited support file', () => {
    const before = recordsUnder(repo);
    const loaded = recordFor({ project: 'unit', file: 'test/a.test.ts', inputs: ['test/support/loaded.ts'], whole: false }, before.digests, before.globals);
    const other = recordFor({ project: 'unit', file: 'test/b.test.ts', inputs: [], whole: false }, before.digests, before.globals);
    const after = recordsUnder(changed('test/support/loaded.ts'));

    expect(isReplayable(loaded, after.digests, after.globals)).toBe(false);
    expect(isReplayable(other, after.digests, after.globals)).toBe(true);
  });

  it('invalidates the records of the project whose setup file, or a file it imports, was edited', () => {
    const before = recordsUnder(repo);
    const unit = recordFor({ project: 'unit', file: 'test/a.test.ts', inputs: [], whole: false }, before.digests, before.globals);
    const e2e = recordFor({ project: 'e2e', file: 'e2e/a.test.ts', inputs: [], whole: false }, before.digests, before.globals);

    for (const file of ['test/support/unit-setup.ts', 'test/support/shared.ts', 'packages/foundation/src/a.ts']) {
      const after = recordsUnder(changed(file));
      expect(isReplayable(unit, after.digests, after.globals), file).toBe(false);
      expect(isReplayable(e2e, after.digests, after.globals), file).toBe(true);
    }
    const afterConfig = recordsUnder(changed('test/support/plan.ts'));
    expect(isReplayable(unit, afterConfig.digests, afterConfig.globals)).toBe(false);
    expect(isReplayable(e2e, afterConfig.digests, afterConfig.globals)).toBe(false);
  });
});

describe('a stored record of another format', () => {
  it('is read as no record, never thrown on and never replayed, so the next green run replaces it', () => {
    const dir = createTempDir();
    try {
      const file = path.join(dir, 'old.json');
      fs.writeFileSync(file, JSON.stringify({ format: 'momonga-test-reuse/1', project: 'unit', file: 'test/a.test.ts', whole: false, inputs: [], key: 'k' }));
      expect(readRecord(file)).toBeUndefined();
      fs.writeFileSync(file, JSON.stringify({ format: REUSE_RECORD_FORMAT, project: 'unit' }));
      expect(() => readRecord(file)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the run CPU budget variable out of the key, since it cannot change a green outcome', () => {
    expect(globalsOf({}, digestsOf({}), { MOMONGA_RUN_CPU_BUDGET_SECONDS: '60', MOMONGA_TLC_TIER: 'deep' }).env).toEqual({ MOMONGA_TLC_TIER: 'deep' });
  });
});

describe('the files the main process loaded for a project', () => {
  const SUPPORT = path.join(import.meta.dirname, 'support');
  const VITEST = path.join(import.meta.dirname, '..', 'node_modules', 'vitest', 'vitest.mjs');
  let root = '';

  afterEach(() => {
    if (root !== '') fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  const write = (file: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };

  const fixture = (): void => {
    root = createTempDir();
    write(
      'vitest.config.mjs',
      [
        `import { testReusePlan } from ${JSON.stringify(path.join(SUPPORT, 'test-reuse.ts'))};`,
        "testReusePlan(import.meta.dirname, { shared: ['vitest.config.mjs'], projects: { unit: [] } });",
        'export default {',
        `  test: { pool: 'forks', reporters: ['default', ${JSON.stringify(path.join(SUPPORT, 'reuse-reporter.ts'))}], projects: [{ test: { name: 'unit', include: ['t/**/*.test.ts'], setupFiles: [${JSON.stringify(path.join(SUPPORT, 'reuse-recorder.ts'))}], globalSetup: [${JSON.stringify(path.join(SUPPORT, 'main-observation.ts'))}, './setup.ts'] } }] },`,
        '};',
        '',
      ].join('\n'),
    );
    write('setup.ts', "import { loaded } from './product/loaded.ts';\nexport default function setup(): void {\n  if (loaded !== 1) throw new Error('not loaded');\n}\n");
    write('product/loaded.ts', 'export const loaded = 1;\n');
    write('product/unloaded.ts', 'export const unloaded = 1;\n');
    write('packages/.keep', '');
    write('t/a.test.ts', "import { test } from 'vitest';\ntest('a', () => {});\n");
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    expect(spawnSync('git', ['add', '-A'], { cwd: root }).status).toBe(0);
  };

  const run = (): string => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('VITEST') && key !== 'MOMONGA_RUN_LOCK') env[key] = value;
    const result = spawnSync(process.execPath, [VITEST, 'run', '--config', 'vitest.config.mjs'], { cwd: root, encoding: 'utf8', env: { ...env, MOMONGA_TEST_REUSE: '1' } });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return result.stdout;
  };

  const edit = (file: string): void => {
    fs.appendFileSync(path.join(root, file), 'export const edited = 1;\n');
  };

  it(
    'leaves the records replayable after an edit to a product file the global setup did not load, and clears them after an edit to one it loaded',
    () => {
      fixture();
      run();
      expect(run()).toContain('Replayed 1 test files');
      edit('product/unloaded.ts');
      expect(run()).toContain('Replayed 1 test files');
      edit('product/loaded.ts');
      expect(run()).toContain('Replayed 0 test files');
    },
    REAL_PROCESS_TEST_TIMEOUT_MS * 4,
  );
});
