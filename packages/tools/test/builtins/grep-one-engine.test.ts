import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
