import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeBuiltins, range, resultOf } from './fixtures.ts';
import type { Builtins } from './fixtures.ts';

const BASE_TIME = 1_700_000_000;

const touch = (tools: Builtins, relative: string, secondsAfterBase: number, content = 'x'): string => {
  const file = tools.write(relative, content);
  fs.utimesSync(file, BASE_TIME + secondsAfterBase, BASE_TIME + secondsAfterBase);
  return file;
};

const linesOf = (output: string): string[] => output.split('\n');

describe('Glob', () => {
  it('returns absolute paths sorted by mtime descending', async () => {
    const tools = await makeBuiltins();
    const oldest = touch(tools, 'src/a.ts', 1);
    const newest = touch(tools, 'src/deep/b.ts', 3);
    const middle = touch(tools, 'c.ts', 2);
    touch(tools, 'src/readme.md', 4);
    const result = resultOf(await tools.run('Glob', { pattern: '**/*.ts' }));
    expect(result).toMatchObject({ status: 'completed' });
    expect(linesOf(result.output)).toEqual([newest, middle, oldest]);
  });

  it('breaks mtime ties by path', async () => {
    const tools = await makeBuiltins();
    const b = touch(tools, 'b.txt', 5);
    const a = touch(tools, 'a.txt', 5);
    const c = touch(tools, 'c.txt', 5);
    const result = resultOf(await tools.run('Glob', { pattern: '*.txt' }));
    expect(linesOf(result.output)).toEqual([a, b, c]);
  });

  it('matches the pattern relative to the given path', async () => {
    const tools = await makeBuiltins();
    const inSrc = touch(tools, 'src/main.ts', 1);
    touch(tools, 'main.ts', 2);
    touch(tools, 'src/nested/deep.ts', 3);
    const result = resultOf(await tools.run('Glob', { pattern: '*.ts', path: path.join(tools.layout.project, 'src') }));
    expect(linesOf(result.output)).toEqual([inSrc]);
  });

  it('defaults the path to the session cwd', async () => {
    const tools = await makeBuiltins();
    touch(tools, 'top.ts', 1);
    const inner = touch(tools, 'pkg/inner.ts', 2);
    tools.session.cwd = path.join(tools.layout.project, 'pkg');
    const result = resultOf(await tools.run('Glob', { pattern: '*.ts' }));
    expect(linesOf(result.output)).toEqual([inner]);
  });

  it('includes dotfiles and skips .git', async () => {
    const tools = await makeBuiltins();
    const dotfile = touch(tools, '.env.example', 2);
    const dotdirFile = touch(tools, '.github/workflows/ci.yml', 1);
    touch(tools, '.git/HEAD', 3);
    touch(tools, '.git/objects/ab/cdef', 4);
    const result = resultOf(await tools.run('Glob', { pattern: '**/*' }));
    expect(linesOf(result.output)).toEqual([dotfile, dotdirFile]);
  });

  it('honors the root .gitignore, nested .gitignore files and .ignore', async () => {
    const tools = await makeBuiltins();
    touch(tools, '.gitignore', 10, 'build/\n');
    touch(tools, 'pkg/.gitignore', 11, '*.log\n');
    touch(tools, '.ignore', 12, 'scratch.txt\n');
    touch(tools, 'build/out.txt', 1);
    touch(tools, 'pkg/debug.log', 2);
    const rootLog = touch(tools, 'root.log', 3);
    touch(tools, 'scratch.txt', 4);
    const kept = touch(tools, 'pkg/kept.txt', 5);
    const result = resultOf(await tools.run('Glob', { pattern: '**/*.{txt,log}' }));
    expect(linesOf(result.output)).toEqual([kept, rootLog]);
  });

  it('does not follow symlinked directories', async () => {
    const tools = await makeBuiltins();
    const outsideDir = path.join(tools.layout.outside, 'linked');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'remote.ts'), 'x');
    fs.symlinkSync(outsideDir, path.join(tools.layout.project, 'linked'));
    const local = touch(tools, 'local.ts', 1);
    const result = resultOf(await tools.run('Glob', { pattern: '**/*.ts' }));
    expect(linesOf(result.output)).toEqual([local]);
  });

  it('skips readDenied subtrees', async () => {
    const tools = await makeBuiltins();
    const visible = touch(tools, 'visible.txt', 1);
    touch(tools, 'vault/secret.txt', 2);
    const sandboxPolicy = { ...tools.sandboxPolicy, readDenied: [...tools.sandboxPolicy.readDenied, path.join(tools.layout.project, 'vault')] };
    const result = resultOf(await tools.run('Glob', { pattern: '**/*.txt' }, { sandboxPolicy }));
    expect(linesOf(result.output)).toEqual([visible]);
  });

  it('is denied when the search path itself is readDenied', async () => {
    const tools = await makeBuiltins();
    const vault = path.join(tools.layout.project, 'vault');
    touch(tools, 'vault/secret.txt', 1);
    const sandboxPolicy = { ...tools.sandboxPolicy, readDenied: [...tools.sandboxPolicy.readDenied, vault] };
    const result = resultOf(await tools.run('Glob', { pattern: '**/*', path: vault }, { sandboxPolicy, mode: 'bypassPermissions' }));
    expect(result).toEqual({ status: 'failed', output: `Permission denied: ${vault} is blocked by the sandbox policy`, denial: { source: 'sandbox', reason: `${vault} is blocked by the sandbox policy` } });
  });

  it('caps results at 100 and appends the truncation notice', async () => {
    const tools = await makeBuiltins();
    const files = range(1, 101).map((n) => touch(tools, `many/f${String(n).padStart(3, '0')}.txt`, n));
    const result = resultOf(await tools.run('Glob', { pattern: 'many/*.txt' }));
    const lines = linesOf(result.output);
    expect(lines).toHaveLength(101);
    expect(lines.slice(0, 100)).toEqual(files.slice(1).reverse());
    expect(lines[100]).toBe('(Results are truncated. Consider a more specific path or pattern.)');
  });

  it('returns exactly 100 results without the truncation notice', async () => {
    const tools = await makeBuiltins();
    range(1, 100).forEach((n) => touch(tools, `many/f${n}.txt`, n));
    const result = resultOf(await tools.run('Glob', { pattern: 'many/*.txt' }));
    expect(linesOf(result.output)).toHaveLength(100);
    expect(result.output).not.toContain('Results are truncated');
  });

  it('reports no matches', async () => {
    const tools = await makeBuiltins();
    touch(tools, 'a.txt', 1);
    const result = resultOf(await tools.run('Glob', { pattern: '**/*.rs' }));
    expect(result).toMatchObject({ status: 'completed', output: 'No files found' });
  });

  it('fails when the path is not a directory', async () => {
    const tools = await makeBuiltins();
    const file = touch(tools, 'a.txt', 1);
    expect(resultOf(await tools.run('Glob', { pattern: '*', path: file })).status).toBe('failed');
    expect(resultOf(await tools.run('Glob', { pattern: '*', path: path.join(tools.layout.project, 'nope') })).status).toBe('failed');
  });

  it('rejects a relative path', async () => {
    const tools = await makeBuiltins();
    const result = resultOf(await tools.run('Glob', { pattern: '*', path: 'src' }));
    expect(result).toMatchObject({ status: 'failed', output: 'path must be an absolute path' });
  });

  it('asks before searching outside the roots', async () => {
    const tools = await makeBuiltins();
    const [outcome] = await tools.executor.runBatch(tools.batch('Glob', { pattern: '*', path: tools.layout.outside }));
    expect(outcome?.kind).toBe('needs_approval');
  });
});
