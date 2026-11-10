import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import { makeBuiltins, resultOf } from './fixtures.ts';

const sourceOf = (relative: string): string => fs.readFileSync(path.resolve(import.meta.dirname, relative), 'utf8');

describe('Grep has exactly one search backend', () => {
  const grepSource = sourceOf('../../src/builtins/grep.ts');

  it('no longer contains the JavaScript fallback', () => {
    expect(grepSource).not.toMatch(/searchWithJavaScript/);
    expect(grepSource).not.toMatch(/from 'picomatch'/);
    expect(grepSource).not.toMatch(/new RegExp\(/);
  });

  it('no longer walks PATH for rg itself: the locator on the context decides', () => {
    expect(grepSource).not.toMatch(/resolveRipgrep/);
    expect(grepSource).not.toMatch(/ctx\.env\['PATH'\]/);
  });

  it('describes ripgrep syntax without "when available"', () => {
    expect(grepSource).toContain('(ripgrep syntax)');
    expect(grepSource).not.toContain('when available');
  });

  it('leaves the test fixtures without a JavaScript backend path', () => {
    expect(sourceOf('./fixtures.ts')).not.toMatch(/JS_BACKEND_PATH/);
  });
});

describe('Grep through the ripgrep locator on the tool context', () => {
  it('fails with the English message and the cause when the locator fails, even when PATH would give a result', async () => {
    const tools = await makeBuiltins();
    tools.write('a.ts', 'alpha\n');
    const locator = { locate: async () => ({ ok: false as const, cause: 'the embedded ripgrep does not match the checksum in its manifest' }) };
    const outcome = await tools.run('Grep', { pattern: 'alpha' }, { ripgrep: locator, env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', LANG: 'C' } } as never);
    const { ripgrepUnavailableMessage } = await import('../../src/ripgrep-locator.ts');
    const result = resultOf(outcome);
    expect(result.status).not.toBe('completed');
    expect(result.output).toBe(ripgrepUnavailableMessage('the embedded ripgrep does not match the checksum in its manifest'));
  });

  it('spawns the executable the locator names, by absolute path, and releases it when the call ends', async () => {
    const spawned: string[][] = [];
    const sandbox = {
      kind: 'none' as const,
      spawn: (command: { argv: string[] }) => {
        spawned.push(command.argv);
        throw new Error('spawn stopped by the test');
      },
    };
    const tools = await makeBuiltins({ sandbox: sandbox as never });
    tools.write('a.ts', 'alpha\n');
    let released = 0;
    const locator = {
      locate: async () => ({ ok: true as const, path: '/nonexistent/located-rg', source: 'bundled' as const, version: '15.2.0', release: async () => void (released += 1) }),
    };
    await tools.run('Grep', { pattern: 'alpha' }, { ripgrep: locator } as never);
    expect(spawned.map((argv) => argv[0])).toEqual(['/nonexistent/located-rg']);
    expect(released).toBe(1);
  });
});

const textStream = (text: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    if (text !== '') yield Buffer.from(text);
  },
});

const answeringSandbox = (answer: (argv: string[]) => string) => {
  const spawned: string[][] = [];
  const sandbox = {
    kind: 'none' as const,
    spawn: (command: { argv: string[] }, policy: unknown) => {
      spawned.push(command.argv);
      return { pid: 999_990, pgid: 999_990, policy, stdout: textStream(answer(command.argv)), stderr: textStream(''), exited: Promise.resolve({ code: 0, signal: null }) };
    },
  };
  return { sandbox, spawned };
};

describe('Grep reports the ripgrep it ran as its backend (design 6.4)', () => {
  it('carries the source and the manifest version of a bundled ripgrep, without running --version', async () => {
    const { sandbox, spawned } = answeringSandbox(() => '');
    const tools = await makeBuiltins({ sandbox: sandbox as never });
    const target = tools.write('a.ts', 'alpha\n');
    sandbox.spawn = ((command: { argv: string[] }, policy: unknown) => {
      spawned.push(command.argv);
      return { pid: 999_990, pgid: 999_990, policy, stdout: textStream(`${target}\0`), stderr: textStream(''), exited: Promise.resolve({ code: 0, signal: null }) };
    }) as typeof sandbox.spawn;
    const locator = { locate: async () => ({ ok: true as const, path: '/bundled/rg', source: 'bundled' as const, version: '15.2.0', release: async () => undefined }) };
    const result = resultOf(await tools.run('Grep', { pattern: 'alpha' }, { ripgrep: locator } as never));
    expect(result.backend).toEqual({ source: 'bundled', version: '15.2.0' });
    expect(spawned.filter((argv) => argv.includes('--version'))).toEqual([]);
  });

  it('runs --version of a system ripgrep once per locator, inside the sandbox, and carries it on every call', async () => {
    let target = '';
    const { sandbox, spawned } = answeringSandbox((argv) => (argv[1] === '--version' ? 'ripgrep 14.1.1\n\nfeatures:+pcre2\n' : `${target}\0`));
    const tools = await makeBuiltins({ sandbox: sandbox as never });
    target = tools.write('a.ts', 'alpha\n');
    const locator = { locate: async () => ({ ok: true as const, path: '/usr/bin/rg', source: 'system' as const, release: async () => undefined }) };
    const first = resultOf(await tools.run('Grep', { pattern: 'alpha' }, { ripgrep: locator } as never));
    const second = resultOf(await tools.run('Grep', { pattern: 'alpha' }, { ripgrep: locator } as never));
    expect(first.backend).toEqual({ source: 'system', version: '14.1.1' });
    expect(second.backend).toEqual({ source: 'system', version: '14.1.1' });
    expect(spawned.filter((argv) => argv[1] === '--version')).toEqual([['/usr/bin/rg', '--version']]);
  });

  it('fails naming the executable when --version does not report a ripgrep version', async () => {
    const { sandbox } = answeringSandbox((argv) => (argv[1] === '--version' ? 'not ripgrep\n' : ''));
    const tools = await makeBuiltins({ sandbox: sandbox as never });
    tools.write('a.ts', 'alpha\n');
    const locator = { locate: async () => ({ ok: true as const, path: '/opt/rg', source: 'path' as const, release: async () => undefined }) };
    const result = resultOf(await tools.run('Grep', { pattern: 'alpha' }, { ripgrep: locator } as never));
    expect(result.status).toBe('failed');
    expect(result.output).toContain('/opt/rg --version did not report a ripgrep version');
  });
});

describe('Grep hands ripgrep its flags through an owner-only file that lives only for the call', () => {
  const seenAtSpawn = (seen: Array<{ file: string; mode: number; text: string }>, after: (argv: string[]) => string | Error) => ({
    kind: 'none' as const,
    spawn: (command: { argv: string[]; env: Record<string, string> }, policy: { readAllowed?: readonly string[] }) => {
      const file = command.env['RIPGREP_CONFIG_PATH'] as string;
      seen.push({ file, mode: fs.statSync(file).mode & 0o777, text: fs.readFileSync(file, 'utf8') });
      expect(policy.readAllowed).toContain(file);
      const answer = after(command.argv);
      if (answer instanceof Error) throw answer;
      return { pid: 999_990, pgid: 999_990, stdout: textStream(answer), stderr: textStream(''), exited: Promise.resolve({ code: 0, signal: null }) };
    },
  });

  const bundled = { locate: async () => ({ ok: true as const, path: '/bundled/rg', source: 'bundled' as const, version: '15.2.0', release: async () => undefined }) };

  it('writes it owner-only under the read-denied product root, passes no flag on argv, and removes it when the call ends', async () => {
    const seen: Array<{ file: string; mode: number; text: string }> = [];
    let target = '';
    const tools = await makeBuiltins({ sandbox: seenAtSpawn(seen, () => `${target}\0`) as never });
    target = tools.write('a.ts', 'alpha\n');
    const result = resultOf(await tools.run('Grep', { pattern: 'alpha' }, { ripgrep: bundled } as never));
    expect(result.status).toBe('completed');
    const [only] = seen;
    expect(path.dirname(only?.file as string)).toBe(momongaLayout(tools.layout.home).grepArguments);
    expect(only?.mode).toBe(0o600);
    expect(only?.text.split('\n')).toContain('--null');
    expect(only?.text.split('\n')).not.toContain('--no-config');
    expect(fs.existsSync(only?.file as string)).toBe(false);
  });

  it('removes it when the spawn fails', async () => {
    const seen: Array<{ file: string; mode: number; text: string }> = [];
    const tools = await makeBuiltins({ sandbox: seenAtSpawn(seen, () => new Error('spawn stopped by the test')) as never });
    tools.write('a.ts', 'alpha\n');
    const result = resultOf(await tools.run('Grep', { pattern: 'alpha' }, { ripgrep: bundled } as never));
    expect(result.status).toBe('failed');
    expect(seen).toHaveLength(1);
    expect(fs.existsSync(seen[0]?.file as string)).toBe(false);
  });

  it('refuses a model glob with a line break, which one line of the file cannot carry, before any spawn', async () => {
    const seen: Array<{ file: string; mode: number; text: string }> = [];
    const tools = await makeBuiltins({ sandbox: seenAtSpawn(seen, () => '') as never });
    tools.write('a.ts', 'alpha\n');
    const result = resultOf(await tools.run('Grep', { pattern: 'alpha', glob: '*.ts\n--pre=sh' }, { ripgrep: bundled } as never));
    expect(result.output).toContain('glob must not contain a line break');
    expect(seen).toEqual([]);
  });
});
