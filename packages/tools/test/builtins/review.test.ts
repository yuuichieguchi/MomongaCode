import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, afterMicrotasks } from '@momonga/testkit';
import { createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox, SandboxedProcess } from '@momonga/sandbox';
import { keyFor } from '../helpers.ts';
import { HAS_RG, RG_PATH, makeBuiltins, onCleanup, resultOf, sha256 } from './fixtures.ts';
import type { Builtins, RunExtra } from './fixtures.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const BASE_TIME = 1_700_000_000;
const ACCEPT = { mode: 'acceptEdits' } as const;

const put = (tools: Builtins, relative: string, content: string, secondsAfterBase = 0): string => {
  const file = tools.write(relative, content);
  fs.utimesSync(file, BASE_TIME + secondsAfterBase, BASE_TIME + secondsAfterBase);
  return file;
};

const withReadDenied = (tools: Builtins, ...entries: string[]) => ({
  ...tools.sandboxPolicy,
  readDenied: [...tools.sandboxPolicy.readDenied, ...entries],
});

const unblockFifo = (fifo: string): void => {
  try {
    fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
  } catch {
    return;
  }
};

const makeFifo = (dir: string, name: string): string => {
  const fifo = path.join(dir, name);
  execFileSync('/usr/bin/mkfifo', [fifo]);
  onCleanup(() => {
    unblockFifo(fifo);
    fs.rmSync(fifo, { force: true });
  });
  return fifo;
};

const runWithin = async (tools: Builtins, name: string, args: unknown, extra: RunExtra, ms: number, onHang: () => void) => {
  const controller = new AbortController();
  const started = Date.now();
  const running = tools.executor.runBatch(tools.batch(name, args, { ...extra, signal: controller.signal }));
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<'hung'>((resolve) => {
    timer = setTimeout(() => resolve('hung'), ms);
  });
  const first = await Promise.race([running, hung]);
  clearTimeout(timer);
  if (first === 'hung') {
    controller.abort();
    onHang();
    await running;
    return { hung: true as const, elapsed: Date.now() - started };
  }
  return { hung: false as const, elapsed: Date.now() - started, result: resultOf(first[0]) };
};

describe('review 1: ripgrep excludes readDenied entries inside the search target', () => {
  const makeVaultTree = async (realSandbox: boolean) => {
    const tools = await makeBuiltins({ realSandbox });
    const visible = put(tools, 'src/visible.ts', 'alpha visible\n', 2);
    put(tools, 'src/vault/secret.ts', 'alpha secret\n', 3);
    put(tools, 'src/vault/nested/deeper.ts', 'alpha deeper\n', 4);
    const vault = path.join(tools.layout.project, 'src', 'vault');
    return { tools, visible, vault };
  };

  describe.runIf(HAS_RG).each(['content', 'files_with_matches', 'count'] as const)('%s mode', (outputMode) => {
    it('never shows readDenied content with an unsandboxed ripgrep', async () => {
      const { tools, visible, vault } = await makeVaultTree(false);
      const unsandboxed: Sandbox = createUnsandboxed({ killGraceMs: 300 });
      const result = resultOf(
        await tools.run('Grep', { pattern: 'alpha', output_mode: outputMode }, { sandbox: unsandboxed, sandboxPolicy: withReadDenied(tools, vault), env: { PATH: RG_PATH } }),
      );
      expect(result.status).toBe('completed');
      expect(result.output).toContain(path.relative(tools.layout.project, visible));
      expect(result.output).not.toContain('vault');
      expect(result.output).not.toContain('secret');
      expect(result.output).not.toContain('deeper');
    });

    it('adds no unreadable-path note for readDenied entries under Seatbelt', async () => {
      const { tools, visible, vault } = await makeVaultTree(true);
      const result = resultOf(await tools.run('Grep', { pattern: 'alpha', output_mode: outputMode }, { sandboxPolicy: withReadDenied(tools, vault), env: { PATH: RG_PATH } }));
      expect(result.output).toContain(path.relative(tools.layout.project, visible));
      expect(result.output).not.toContain('vault');
      expect(result.output).not.toContain('(some paths could not be read)');
    });
  });
});

describe('review 2: non-regular files are refused without opening them', () => {
  const PROMPT_MS = 3000;

  it('Read refuses a FIFO promptly', async () => {
    const tools = await makeBuiltins();
    const fifo = makeFifo(tools.layout.project, 'pipe');
    const outcome = await runWithin(tools, 'Read', { file_path: fifo }, {}, PROMPT_MS, () => unblockFifo(fifo));
    expect(outcome.hung).toBe(false);
    expect(outcome.result?.status).toBe('failed');
    expect(outcome.result?.output).toMatch(/^pipe is not a regular file/);
  });

  it('Edit refuses a FIFO promptly', async () => {
    const tools = await makeBuiltins();
    const fifo = makeFifo(tools.layout.project, 'pipe');
    tools.session.readLedger.set(fifo, { sha256: sha256(''), mtimeMs: fs.statSync(fifo).mtimeMs });
    const outcome = await runWithin(tools, 'Edit', { file_path: fifo, old_string: 'a', new_string: 'b' }, ACCEPT, PROMPT_MS, () => unblockFifo(fifo));
    expect(outcome.hung).toBe(false);
    expect(outcome.result?.status).toBe('failed');
    expect(outcome.result?.output).toMatch(/^pipe is not a regular file/);
  });

  it('Write refuses to overwrite a FIFO promptly', async () => {
    const tools = await makeBuiltins();
    const fifo = makeFifo(tools.layout.project, 'pipe');
    tools.session.readLedger.set(fifo, { sha256: sha256(''), mtimeMs: fs.statSync(fifo).mtimeMs });
    const outcome = await runWithin(tools, 'Write', { file_path: fifo, content: 'x' }, ACCEPT, PROMPT_MS, () => unblockFifo(fifo));
    expect(outcome.hung).toBe(false);
    expect(outcome.result?.status).toBe('failed');
    expect(outcome.result?.output).toMatch(/^pipe is not a regular file/);
    expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
  });

  it('Grep refuses a FIFO path promptly, before it locates ripgrep', async () => {
    const tools = await makeBuiltins();
    const fifo = makeFifo(tools.layout.project, 'pipe');
    let located = 0;
    const ripgrep = { locate: async () => ({ ok: false as const, cause: `located ${(located += 1)} times` }) };
    const outcome = await runWithin(tools, 'Grep', { pattern: 'alpha', path: fifo }, { ripgrep }, PROMPT_MS, () => unblockFifo(fifo));
    expect(outcome.hung).toBe(false);
    expect(outcome.result?.status).toBe('failed');
    expect(outcome.result?.output).toMatch(/^pipe is not a regular file/);
    expect(located).toBe(0);
  });
});

describe('review 3: a parent directory swapped to a symlink is not written through', () => {
  const swapToSymlink = (tools: Builtins, relativeDir: string, target: string): void => {
    const dir = path.join(tools.layout.project, relativeDir);
    fs.renameSync(dir, `${dir}-original`);
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, dir);
  };

  const DIFFERENT_LOCATION = /resolves to a different location than when it was approved \(.+ → .+\); retry the call/;

  it('Write re-executed from a PENDING record fails when the parent now points at a protected path', async () => {
    const tools = await makeBuiltins();
    fs.mkdirSync(path.join(tools.layout.project, 'dir'));
    const file = path.join(tools.layout.project, 'dir', 'new.txt');
    const hooks = path.join(tools.layout.project, '.git', 'hooks');
    swapToSymlink(tools, 'dir', hooks);
    tools.idempotency.seed(keyFor('run-1', 1, 'w1'), 'PENDING', { tool: 'Write', prepared: { path: file, preHash: null, postHash: sha256('payload') } });
    const outcome = await tools.run('Write', { file_path: file, content: 'payload' }, ACCEPT, 'allow_once', 'w1');
    const result = resultOf(outcome);
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(DIFFERENT_LOCATION);
    expect(fs.readdirSync(hooks)).toEqual([]);
  });

  it('Write re-executed from a PENDING record fails when the parent now points outside the roots', async () => {
    const tools = await makeBuiltins();
    fs.mkdirSync(path.join(tools.layout.project, 'dir'));
    const file = path.join(tools.layout.project, 'dir', 'new.txt');
    const elsewhere = path.join(tools.layout.outside, 'elsewhere');
    swapToSymlink(tools, 'dir', elsewhere);
    tools.idempotency.seed(keyFor('run-1', 1, 'w2'), 'PENDING', { tool: 'Write', prepared: { path: file, preHash: null, postHash: sha256('payload') } });
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'payload' }, ACCEPT, 'allow_once', 'w2'));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(DIFFERENT_LOCATION);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('Edit re-executed from a PENDING record fails when the parent now points at a protected path', async () => {
    const tools = await makeBuiltins();
    const OLD = 'value = 1\n';
    const NEW = 'value = 2\n';
    const file = put(tools, 'dir/cfg.txt', OLD);
    tools.markRead(file);
    const hooks = path.join(tools.layout.project, '.git', 'hooks');
    swapToSymlink(tools, 'dir', hooks);
    fs.writeFileSync(path.join(hooks, 'cfg.txt'), OLD);
    tools.idempotency.seed(keyFor('run-1', 1, 'e1'), 'PENDING', { tool: 'Edit', prepared: { path: file, preHash: sha256(OLD), postHash: sha256(NEW) } });
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: '1', new_string: '2' }, ACCEPT, 'allow_once', 'e1'));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(DIFFERENT_LOCATION);
    expect(fs.readFileSync(path.join(hooks, 'cfg.txt'), 'utf8')).toBe(OLD);
    expect(fs.readdirSync(hooks)).toEqual(['cfg.txt']);
  });
});

describe('review 4: Bash stream errors', () => {
  it('fails the call, closes both iterators and leaves no unhandled rejection when stdout throws', async () => {
    const tools = await makeBuiltins();
    const returned: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    onCleanup(() => process.off('unhandledRejection', onUnhandled));
    let releaseStderr: (() => void) | undefined;
    const stream = (name: string, next: () => Promise<IteratorResult<Uint8Array>>): AsyncIterable<Uint8Array> => ({
      [Symbol.asyncIterator]: () => ({
        next,
        return: async () => {
          returned.push(name);
          releaseStderr?.();
          return { done: true, value: undefined };
        },
      }),
    });
    let stdoutCalls = 0;
    const failingSandbox: Sandbox = {
      kind: 'seatbelt',
      spawn: (): SandboxedProcess => ({
        pid: 2_147_483_000,
        pgid: 2_147_483_000,
        stdout: stream('stdout', async () => {
          stdoutCalls += 1;
          if (stdoutCalls === 1) return { done: false, value: Buffer.from('partial\n') };
          throw new Error('stdout pipe broke');
        }),
        stderr: stream(
          'stderr',
          () =>
            new Promise((resolve) => {
              releaseStderr = () => resolve({ done: true, value: undefined });
            }),
        ),
        exited: new Promise((resolve) => setTimeout(() => resolve({ code: 0, signal: null }), 50)),
      }),
    };
    const [outcome] = await tools.executor.runBatch(tools.batch('Bash', { command: 'echo hi' }, { sandbox: failingSandbox }, 'allow_once'));
    await afterMicrotasks();
    expect(resultOf(outcome).status).toBe('failed');
    expect(unhandled).toEqual([]);
    expect([...returned].sort()).toEqual(['stderr', 'stdout']);
  });
});

describe('review 5: ReadOutput blob errors', () => {
  it('maps BLOB_NOT_FOUND to Unknown output handle', async () => {
    const tools = await makeBuiltins();
    tools.blobs.port.read = (() => Promise.reject(Object.assign(new Error('gone'), { code: 'BLOB_NOT_FOUND' }))) as typeof tools.blobs.port.read;
    const result = resultOf(await tools.run('ReadOutput', { handle: 'c'.repeat(64) }));
    expect(result).toEqual({ status: 'failed', output: 'Unknown output handle' });
  });

  it('surfaces any other blob error as an internal error', async () => {
    const tools = await makeBuiltins();
    tools.blobs.port.read = (() => Promise.reject(Object.assign(new Error('disk on fire'), { code: 'EIO' }))) as typeof tools.blobs.port.read;
    const result = resultOf(await tools.run('ReadOutput', { handle: 'c'.repeat(64) }));
    expect(result).toEqual({ status: 'failed', output: 'Internal error in ReadOutput: disk on fire' });
  });
});

describe('review 6: directory fsync failure after the rename', () => {
  const failDirectorySync = (): void => {
    const original = fs.promises.open;
    const patched = async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await original(...args);
      if ((await handle.stat()).isDirectory()) {
        handle.sync = () => Promise.reject(Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }));
      }
      return handle;
    };
    fs.promises.open = patched as typeof fs.promises.open;
    onCleanup(() => {
      fs.promises.open = original;
    });
  };

  const WARNING = /\nWarning: the change was written but the directory could not be synced \(.*EIO.*\)\.$/;

  it('Write completes with a warning and records the ledger so a following Edit succeeds', async () => {
    const tools = await makeBuiltins();
    const file = path.join(tools.layout.project, 'synced.txt');
    failDirectorySync();
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'alpha\n' }, ACCEPT));
    expect(result.status).toBe('completed');
    expect(result.output).toMatch(WARNING);
    expect(fs.readFileSync(file, 'utf8')).toBe('alpha\n');
    expect(tools.session.readLedger.get(file)?.sha256).toBe(sha256('alpha\n'));
    const edit = resultOf(await tools.run('Edit', { file_path: file, old_string: 'alpha', new_string: 'beta' }, ACCEPT));
    expect(edit.status).toBe('completed');
    expect(fs.readFileSync(file, 'utf8')).toBe('beta\n');
  });

  it('Edit completes with a warning and records the ledger', async () => {
    const tools = await makeBuiltins();
    const file = put(tools, 'e.txt', 'one\n');
    tools.markRead(file);
    failDirectorySync();
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'one', new_string: 'two' }, ACCEPT));
    expect(result.status).toBe('completed');
    expect(result.output).toMatch(WARNING);
    expect(tools.session.readLedger.get(file)?.sha256).toBe(sha256('two\n'));
  });
});

describe('review 7: symlinked files into readDenied and dangling symlinks', () => {
  const makeLinkedTree = async (realSandbox = false) => {
    const tools = await makeBuiltins({ realSandbox });
    const older = put(tools, 'older.txt', 'alpha older\n', 1);
    const newer = put(tools, 'newer.txt', 'alpha newer\n', 2);
    const vault = path.join(tools.layout.home, '.momonga');
    fs.mkdirSync(vault);
    const token = path.join(vault, 'token.txt');
    fs.writeFileSync(token, 'alpha token\n');
    fs.utimesSync(token, BASE_TIME + 9, BASE_TIME + 9);
    fs.symlinkSync(token, path.join(tools.layout.project, 'linked-token.txt'));
    fs.symlinkSync(path.join(tools.layout.project, 'missing-target.txt'), path.join(tools.layout.project, 'dangling.txt'));
    return { tools, older, newer };
  };

  it('Glob skips them', async () => {
    const { tools, older, newer } = await makeLinkedTree();
    const result = resultOf(await tools.run('Glob', { pattern: '*.txt' }));
    expect(result.output.split('\n')).toEqual([newer, older].map((file) => path.relative(tools.layout.project, file)));
  });

  it.runIf(HAS_RG)('Grep with ripgrep under the real sandbox skips them', async () => {
    const { tools, older, newer } = await makeLinkedTree(true);
    const result = resultOf(await tools.run('Grep', { pattern: 'alpha' }, { env: { PATH: RG_PATH } }));
    expect(result.status).toBe('completed');
    expect(result.output.split('\n')).toEqual([newer, older].map((file) => path.relative(tools.layout.project, file)));
  });
});

describe.runIf(process.platform === 'darwin')('review 8: readDenied comparison ignores case on darwin', () => {
  it('executor denies a write under a readDenied entry configured with different case', async () => {
    const tools = await makeBuiltins();
    const target = path.join(tools.layout.project, 'secrets', 'new.txt');
    const sandboxPolicy = withReadDenied(tools, path.join(tools.layout.project, 'SECRETS'));
    const result = resultOf(await tools.run('Write', { file_path: target, content: 'x' }, { ...ACCEPT, sandboxPolicy }));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/^Permission denied: .* is blocked by the sandbox policy$/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('Glob skips a subtree whose readDenied entry differs in case', async () => {
    const tools = await makeBuiltins();
    const visible = put(tools, 'visible.txt', 'x', 1);
    put(tools, 'vault/secret.txt', 'x', 2);
    const sandboxPolicy = withReadDenied(tools, path.join(tools.layout.project, 'VAULT'));
    const result = resultOf(await tools.run('Glob', { pattern: '**/*.txt' }, { sandboxPolicy }));
    expect(result.output.split('\n')).toEqual([path.relative(tools.layout.project, visible)]);
  });

  it.runIf(HAS_RG)('Grep with ripgrep under the real sandbox skips a subtree whose readDenied entry differs in case', async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const visible = put(tools, 'visible.txt', 'alpha', 1);
    put(tools, 'vault/secret.txt', 'alpha', 2);
    const sandboxPolicy = withReadDenied(tools, path.join(tools.layout.project, 'VAULT'));
    const result = resultOf(await tools.run('Grep', { pattern: 'alpha' }, { sandboxPolicy, env: { PATH: RG_PATH } }));
    expect(result.output.split('\n')).toEqual([path.relative(tools.layout.project, visible)]);
  });
});

describe('review 9: Grep parity for type and .rgignore', () => {
  const backends: Array<[string, string, boolean, boolean]> = [
    ['ripgrep', RG_PATH, HAS_RG, true],
  ];

  describe.each(backends)('%s backend', (_name, envPath, available, realSandbox) => {
    it.runIf(available)('rejects an unknown type with the shared message', async () => {
      const tools = await makeBuiltins({ realSandbox });
      put(tools, 'a.ts', 'alpha\n');
      const result = resultOf(await tools.run('Grep', { pattern: 'alpha', type: 'nope' }, { env: { PATH: envPath } }));
      expect(result.status).toBe('failed');
      expect(result.output.startsWith('Unknown file type "nope". Known types: ')).toBe(true);
      expect(result.output).toContain('ts');
      expect(result.output).toContain('swift');
    });

    it.runIf(available)('honors .rgignore over .ignore over .gitignore', async () => {
      const tools = await makeBuiltins({ realSandbox });
      const tree = makeIgnoreTree(tools);
      const result = resultOf(await tools.run('Grep', { pattern: 'alpha' }, { env: { PATH: envPath } }));
      expect(result.output.split('\n')).toEqual(tree.expected.map((file) => path.relative(tools.layout.project, file)));
    });
  });

  it('gives the shared unknown-type message before it locates ripgrep', async () => {
    const tools = await makeBuiltins();
    put(tools, 'a.ts', 'alpha\n');
    let located = 0;
    const ripgrep = { locate: async () => ({ ok: false as const, cause: `located ${(located += 1)} times` }) };
    const result = resultOf(await tools.run('Grep', { pattern: 'alpha', type: 'nope' }, { ripgrep }));
    expect(result.status).toBe('failed');
    expect(result.output.startsWith('Unknown file type "nope". Known types: ')).toBe(true);
    expect(located).toBe(0);
  });

  it('Glob honors .rgignore over .ignore over .gitignore', async () => {
    const tools = await makeBuiltins();
    const tree = makeIgnoreTree(tools);
    const result = resultOf(await tools.run('Glob', { pattern: '*.txt' }));
    expect(result.output.split('\n')).toEqual(tree.expected.map((file) => path.relative(tools.layout.project, file)));
  });
});

const makeIgnoreTree = (tools: Builtins) => {
  put(tools, '.gitignore', 'git-ignored.txt\ngit-reincluded.txt\n');
  put(tools, '.ignore', 'ignore-ignored.txt\nignore-reincluded.txt\n');
  put(tools, '.rgignore', '!git-reincluded.txt\n!ignore-reincluded.txt\nrg-ignored.txt\n');
  const plain = put(tools, 'plain.txt', 'alpha\n', 1);
  put(tools, 'git-ignored.txt', 'alpha\n', 2);
  const gitReincluded = put(tools, 'git-reincluded.txt', 'alpha\n', 3);
  put(tools, 'ignore-ignored.txt', 'alpha\n', 4);
  const ignoreReincluded = put(tools, 'ignore-reincluded.txt', 'alpha\n', 5);
  put(tools, 'rg-ignored.txt', 'alpha\n', 6);
  return { expected: [ignoreReincluded, gitReincluded, plain] };
};
