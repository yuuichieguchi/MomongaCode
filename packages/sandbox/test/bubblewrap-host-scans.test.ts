import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, systemTiming } from '@momonga/foundation';
import type { PlaceholderForm } from '@momonga/foundation';
import { createBubblewrapSandbox, createPlaceholderJournal, nodeFilesystemPort, planBubblewrap } from '@momonga/sandbox';
import type { FilesystemPort, PlaceholderJournal, SandboxPolicy } from '@momonga/sandbox';
import { NEVER_CANCELLED, REAL_PROCESS_TEST_TIMEOUT_MS, testKernelLock } from '@momonga/testkit';
import { fileRulesOf, fileSpec } from './file-rule-specs.ts';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const STAND_IN_BWRAP = `#!/bin/sh
while [ "$1" != "--" ]; do
  shift
done
shift
exec "$@"
`;

const MODULE_ENTRIES = 1_000;

let base = '';
let work = '';
let home = '';

beforeEach(() => {
  base = fs.realpathSync(makeTempDir());
  work = path.join(base, 'work');
  home = path.join(base, 'home');
  fs.mkdirSync(path.join(work, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(work, 'src', 'deep', '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(work, '.env'), 'SECRET=2');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const policy = (overrides: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  writableRoots: [work],
  writeDenied: [],
  writeDeniedLiterals: [],
  protectedSet: EMPTY_PROTECTED_SET,
  fileRules: EMPTY_FILE_RULES,
  readDenied: [],
  network: 'deny',
  ...overrides,
});

const later = async <T>(value: () => T): Promise<T> => {
  await Promise.resolve();
  return value();
};

const deferring = (inner: FilesystemPort): FilesystemPort => ({
  kindOf: (target) => later(async () => await inner.kindOf(target)).then((value) => value),
  isSymbolicLink: (target) => later(async () => await inner.isSymbolicLink(target)).then((value) => value),
  realpath: (target) => later(async () => await inner.realpath(target)).then((value) => value),
  children: (directory) => later(async () => await inner.children(directory)).then((value) => value),
  createPlaceholder: (target, form) => later(async () => await inner.createPlaceholder(target, form)).then((value) => value),
  removePlaceholder: (target, identity, form) => later(async () => await inner.removePlaceholder(target, identity, form)).then((value) => value),
  requireExecutable: (file) => later(async () => await inner.requireExecutable(file)).then((value) => value),
  makeScratchDirectory: (parent, prefix) => inner.makeScratchDirectory(parent, prefix),
});

const listing = (inner: FilesystemPort, visited: string[], onChildren: () => void = () => undefined): FilesystemPort => ({
  ...inner,
  children: (directory) => {
    visited.push(directory);
    onChildren();
    return inner.children(directory);
  },
});

const tmpfsTargets = (args: readonly string[]): string[] => args.flatMap((arg, index) => (args[index - 1] === '--tmpfs' ? [arg] : []));

const SOURCES = ['bubblewrap.ts', 'placeholder-journal.ts'].map((name) => fileURLToPath(new URL(`../src/${name}`, import.meta.url)));

describe('the bubblewrap planner reaches the file system only through its port, asynchronously', () => {
  it('has no synchronous file-system call in the planner, the sandbox or the placeholder journal', () => {
    for (const source of SOURCES) expect(fs.readFileSync(source, 'utf8')).not.toMatch(/\b[a-zA-Z]+Sync\(/);
  });

  it('plans the same mounts when every port answer arrives later', async () => {
    const fileRules = await fileRulesOf([fileSpec('**/.env', { roots: [work], home, tool: 'Read' })], [work]);
    const input = policy({ fileRules, writeDenied: [path.join(work, '.mcp.json')] });
    const direct = await planBubblewrap(input, { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    const deferred = await planBubblewrap(input, { cwd: work }, NEVER_CANCELLED, deferring(nodeFilesystemPort(testKernelLock())));
    expect(deferred).toEqual(direct);
    expect(tmpfsTargets(deferred.args)).toContain(path.join(work, 'src'));
  });
});

describe('the walk for blocked paths', () => {
  it('visits only folders below the anchor of a deny pattern: a node_modules tree beside it is never listed', async () => {
    for (let index = 0; index < MODULE_ENTRIES; index += 1) fs.mkdirSync(path.join(work, 'node_modules', `pkg-${index}`), { recursive: true });
    const fileRules = await fileRulesOf([fileSpec('src/**/.env', { roots: [work], home, tool: 'Read' })], [work]);
    const visited: string[] = [];
    const plan = await planBubblewrap(policy({ fileRules }), { cwd: work }, NEVER_CANCELLED, listing(nodeFilesystemPort(testKernelLock()), visited));
    expect(visited.filter((directory) => directory.startsWith(path.join(work, 'node_modules')))).toEqual([]);
    expect(tmpfsTargets(plan.args)).toContain(path.join(work, 'src'));
  });

  it('stops when the signal of the asker aborts, and the plan rejects', async () => {
    fs.mkdirSync(path.join(work, 'src', 'other', 'more'), { recursive: true });
    const fileRules = await fileRulesOf([fileSpec('**/.env', { roots: [work], home, tool: 'Read' })], [work]);
    const controller = new AbortController();
    const visited: string[] = [];
    const port = listing(nodeFilesystemPort(testKernelLock()), visited, () => controller.abort(new Error('the asker stopped')));
    await expect(planBubblewrap(policy({ fileRules }), { cwd: work }, controller.signal, port)).rejects.toThrow('the asker stopped');
    expect(visited).toHaveLength(1);
  });
});

describe('the sandbox releases its placeholders (stand-in bwrap)', () => {
  const recording = (inner: PlaceholderJournal, intents: number[]): PlaceholderJournal => ({
    ...inner,
    intend: (target: string, intentMs: number, form?: PlaceholderForm) => {
      intents.push(intentMs);
      return inner.intend(target, intentMs, form);
    },
  });

  const sandboxWith = (holders: () => ReadonlySet<string>, journal: PlaceholderJournal, now: () => number) => {
    fs.writeFileSync(path.join(base, 'bwrap'), STAND_IN_BWRAP, { mode: 0o755 });
    fs.mkdirSync(path.join(base, 'tmp'));
    return createBubblewrapSandbox({
      lock: testKernelLock(),
      bwrapPath: path.join(base, 'bwrap'),
      tmpRoot: path.join(base, 'tmp'),
      killGraceMs: 300,
      journal,
      holders,
      timing: { ...systemTiming, now },
    });
  };

  const placeholders = (): string[] => ['.mcp.json', '.envrc', '.vscode-settings'].map((name) => path.join(work, name));

  it('reads the mount table once for a release of three placeholders', async () => {
    let scans = 0;
    const sandbox = sandboxWith(() => {
      scans += 1;
      return new Set<string>();
    }, createPlaceholderJournal(path.join(base, 'journal')), () => 0);
    const child = await sandbox.spawn({ argv: ['/bin/sh', '-c', 'true'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy({ writeDenied: placeholders() }), new AbortController().signal);
    expect((await run(child)).code).toBe(0);
    expect(scans).toBe(1);
    for (const placeholder of placeholders()) expect(fs.existsSync(placeholder)).toBe(false);
  });

  it('records the intent of a placeholder at the time of the clock it is given', async () => {
    const intents: number[] = [];
    const sandbox = sandboxWith(() => new Set<string>(), recording(createPlaceholderJournal(path.join(base, 'journal')), intents), () => 4_242);
    const child = await sandbox.spawn({ argv: ['/bin/sh', '-c', 'true'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy({ writeDenied: placeholders() }), new AbortController().signal);
    expect((await run(child)).code).toBe(0);
    expect(intents).toEqual([4_242, 4_242, 4_242]);
  });
});

describe('the placeholder lifecycle runs through one serialization (stand-in bwrap)', () => {
  const target = (): string => path.join(work, '.mcp.json');

  const keptSandbox = (removals: string[], pause: () => Promise<void>) => {
    let holding: ReadonlySet<string> = new Set([target()]);
    fs.writeFileSync(path.join(base, 'bwrap'), STAND_IN_BWRAP, { mode: 0o755 });
    fs.mkdirSync(path.join(base, 'tmp'));
    const inner = nodeFilesystemPort(testKernelLock());
    const sandbox = createBubblewrapSandbox({
      lock: testKernelLock(),
      bwrapPath: path.join(base, 'bwrap'),
      tmpRoot: path.join(base, 'tmp'),
      killGraceMs: 300,
      journal: createPlaceholderJournal(path.join(base, 'journal')),
      holders: () => holding,
      filesystem: {
        ...inner,
        removePlaceholder: async (placeholder, identity, form) => {
          removals.push(placeholder);
          await pause();
          await inner.removePlaceholder(placeholder, identity, form);
        },
      },
    });
    const spawn = async (script: string) => run(await sandbox.spawn({ argv: ['/bin/sh', '-c', script], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy({ writeDenied: [target()] }), new AbortController().signal));
    return { sandbox, spawn, free: () => { holding = new Set(); } };
  };

  it('a hold that starts while a sweep is removing the placeholder gets a placeholder that stays while its command runs', async () => {
    const removals: string[] = [];
    let entered: () => void = () => undefined;
    const removing = new Promise<void>((resolve) => { entered = resolve; });
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let first = true;
    const { sandbox, spawn, free } = keptSandbox(removals, async () => {
      if (!first) return;
      first = false;
      entered();
      await gate;
    });
    expect((await spawn('true')).code).toBe(0);
    expect(fs.existsSync(target())).toBe(true);
    free();
    const sweeping = sandbox.sweep?.();
    await removing;
    const second = spawn(`sleep 0.3; test -e ${target()}`);
    open();
    await sweeping;
    expect((await second).code).toBe(0);
  });

  it('two sweeps at once remove each kept placeholder once', async () => {
    const removals: string[] = [];
    const { sandbox, spawn, free } = keptSandbox(removals, async () => undefined);
    expect((await spawn('true')).code).toBe(0);
    free();
    await Promise.all([sandbox.sweep?.(), sandbox.sweep?.()]);
    expect(removals).toEqual([target()]);
    expect(fs.existsSync(target())).toBe(false);
  });
});
