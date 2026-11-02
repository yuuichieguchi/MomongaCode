import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_PATH, RG_BIN, RG_PATH, makeBuiltins, onCleanup, range, resultOf } from './fixtures.ts';
import type { Builtins } from './fixtures.ts';

const BASE_TIME = 1_700_000_000;

type Tree = { tools: Builtins; hidden: string; a: string; b: string; readme: string; context: string };

const put = (tools: Builtins, relative: string, content: string, secondsAfterBase: number): string => {
  const file = tools.write(relative, content);
  fs.utimesSync(file, BASE_TIME + secondsAfterBase, BASE_TIME + secondsAfterBase);
  return file;
};

const makeTree = async (realSandbox: boolean): Promise<Tree> => {
  const tools = await makeBuiltins({ realSandbox });
  const hidden = put(tools, '.hidden.ts', 'alpha hidden\n', 5);
  const a = put(tools, 'a.ts', 'const alpha = 1;\nconst beta = 2;\nlet Alpha = 3;\n', 4);
  const b = put(tools, 'b.js', 'alpha();\n', 3);
  const readme = put(tools, 'docs/readme.md', 'no match here\nALPHA upper\n', 2);
  const context = put(tools, 'ctx.txt', `${range(1, 9).map((n) => (n === 3 || n === 8 ? `hit${n}` : `l${n}`)).join('\n')}\n`, 1);
  put(tools, '.gitignore', 'ignored/\n', 0);
  put(tools, 'ignored/skip.ts', 'alpha ignored\n', 9);
  put(tools, '.git/HEAD', 'alpha in git\n', 9);
  const outsideDir = path.join(tools.layout.outside, 'linked');
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, 'remote.ts'), 'alpha remote\n');
  fs.symlinkSync(outsideDir, path.join(tools.layout.project, 'linked'));
  return { tools, hidden, a, b, readme, context };
};

const backends: Array<[string, string, boolean, boolean]> = [
  ['ripgrep', RG_PATH, process.platform === 'darwin' && fs.existsSync(RG_BIN), true],
  ['JS fallback', BASE_PATH, true, false],
];

const grepIn = (tree: Tree, envPath: string) => async (args: Record<string, unknown>, extra: Parameters<Builtins['run']>[2] = {}) =>
  resultOf(await tree.tools.run('Grep', args, { env: { PATH: envPath, LANG: 'C' }, ...extra }));

describe.each(backends)('Grep (%s backend)', (_name, envPath, available, realSandbox) => {
  describe.runIf(available)('shared fixture suite', () => {
    it('lists matching files by mtime descending in files_with_matches mode by default', async () => {
      const tree = await makeTree(realSandbox);
      const result = await grepIn(tree, envPath)({ pattern: 'alpha' });
      expect(result).toMatchObject({ status: 'completed' });
      expect(result.output.split('\n')).toEqual([tree.hidden, tree.a, tree.b]);
    });

    it('ignores ripgrep config files', async () => {
      const tree = await makeTree(realSandbox);
      const config = path.join(tree.tools.layout.root, 'ripgreprc');
      fs.writeFileSync(config, '--glob\n!a.ts\n');
      const result = await grepIn(tree, envPath)({ pattern: 'alpha' }, { env: { PATH: envPath, LANG: 'C', RIPGREP_CONFIG_PATH: config } });
      expect(result.output.split('\n')).toEqual([tree.hidden, tree.a, tree.b]);
    });

    it('matches case-insensitively with -i', async () => {
      const tree = await makeTree(realSandbox);
      const result = await grepIn(tree, envPath)({ pattern: 'alpha', '-i': true });
      expect(result.output.split('\n')).toEqual([tree.hidden, tree.a, tree.b, tree.readme]);
    });

    it('emits path:line:text in content mode with line numbers on by default', async () => {
      const tree = await makeTree(realSandbox);
      const result = await grepIn(tree, envPath)({ pattern: 'alpha', path: tree.a, output_mode: 'content', '-i': true });
      expect(result.output).toBe(`${tree.a}:1:const alpha = 1;\n${tree.a}:3:let Alpha = 3;`);
    });

    it('omits line numbers when -n is false', async () => {
      const tree = await makeTree(realSandbox);
      const result = await grepIn(tree, envPath)({ pattern: 'beta', path: tree.a, output_mode: 'content', '-n': false });
      expect(result.output).toBe(`${tree.a}:const beta = 2;`);
    });

    it('prints context lines with - separators and -- between groups for -C', async () => {
      const tree = await makeTree(realSandbox);
      const c = tree.context;
      const result = await grepIn(tree, envPath)({ pattern: 'hit', path: c, output_mode: 'content', '-C': 1 });
      expect(result.output).toBe([`${c}-2-l2`, `${c}:3:hit3`, `${c}-4-l4`, '--', `${c}-7-l7`, `${c}:8:hit8`, `${c}-9-l9`].join('\n'));
    });

    it('prints only trailing context for -A', async () => {
      const tree = await makeTree(realSandbox);
      const c = tree.context;
      const result = await grepIn(tree, envPath)({ pattern: 'hit', path: c, output_mode: 'content', '-A': 1 });
      expect(result.output).toBe([`${c}:3:hit3`, `${c}-4-l4`, '--', `${c}:8:hit8`, `${c}-9-l9`].join('\n'));
    });

    it('prints only leading context for -B', async () => {
      const tree = await makeTree(realSandbox);
      const c = tree.context;
      const result = await grepIn(tree, envPath)({ pattern: 'hit', path: c, output_mode: 'content', '-B': 2 });
      expect(result.output).toBe([`${c}-1-l1`, `${c}-2-l2`, `${c}:3:hit3`, '--', `${c}-6-l6`, `${c}-7-l7`, `${c}:8:hit8`].join('\n'));
    });

    it('merges overlapping context without a separator', async () => {
      const tree = await makeTree(realSandbox);
      const c = tree.context;
      const result = await grepIn(tree, envPath)({ pattern: 'hit', path: c, output_mode: 'content', '-C': 2 });
      expect(result.output).toBe(
        [`${c}-1-l1`, `${c}-2-l2`, `${c}:3:hit3`, `${c}-4-l4`, `${c}-5-l5`, `${c}-6-l6`, `${c}-7-l7`, `${c}:8:hit8`, `${c}-9-l9`].join('\n'),
      );
    });

    it('counts matches per file as path:N', async () => {
      const tree = await makeTree(realSandbox);
      const result = await grepIn(tree, envPath)({ pattern: 'alpha', path: tree.a, output_mode: 'count', '-i': true });
      expect(result.output).toBe(`${tree.a}:2`);
    });

    it('filters files with glob', async () => {
      const tree = await makeTree(realSandbox);
      const result = await grepIn(tree, envPath)({ pattern: 'alpha', glob: '*.js' });
      expect(result.output).toBe(tree.b);
    });

    it('filters files with type', async () => {
      const tree = await makeTree(realSandbox);
      const result = await grepIn(tree, envPath)({ pattern: 'alpha', type: 'ts' });
      expect(result.output.split('\n')).toEqual([tree.hidden, tree.a]);
    });

    it('applies offset and head_limit to output entries', async () => {
      const tree = await makeTree(realSandbox);
      const grep = grepIn(tree, envPath);
      expect((await grep({ pattern: 'alpha', head_limit: 1 })).output).toBe(tree.hidden);
      expect((await grep({ pattern: 'alpha', offset: 1 })).output.split('\n')).toEqual([tree.a, tree.b]);
      expect((await grep({ pattern: 'alpha', offset: 1, head_limit: 1 })).output).toBe(tree.a);
    });

    it('applies head_limit to content lines', async () => {
      const tree = await makeTree(realSandbox);
      const result = await grepIn(tree, envPath)({ pattern: 'l[0-9]', path: tree.context, output_mode: 'content', head_limit: 2 });
      expect(result.output).toBe(`${tree.context}:1:l1\n${tree.context}:2:l2`);
    });

    it('matches across lines with multiline', async () => {
      const tree = await makeTree(realSandbox);
      const result = await grepIn(tree, envPath)({ pattern: 'alpha = 1;\\nconst beta', multiline: true });
      expect(result.output).toBe(tree.a);
    });

    it('reports no matches', async () => {
      const tree = await makeTree(realSandbox);
      const result = await grepIn(tree, envPath)({ pattern: 'zzz_nothing' });
      expect(result).toMatchObject({ status: 'completed', output: 'No matches found' });
    });

    it('skips .git, ignored paths and symlinked directories', async () => {
      const tree = await makeTree(realSandbox);
      const result = await grepIn(tree, envPath)({ pattern: 'alpha (ignored|in git|remote)' });
      expect(result.output).toBe('No matches found');
    });

    it('skips readDenied subtrees', async () => {
      const tree = await makeTree(realSandbox);
      put(tree.tools, 'vault/secret.ts', 'alpha secret\n', 8);
      const sandboxPolicy = {
        ...tree.tools.sandboxPolicy,
        readDenied: [...tree.tools.sandboxPolicy.readDenied, path.join(tree.tools.layout.project, 'vault')],
      };
      const result = await grepIn(tree, envPath)({ pattern: 'alpha' }, { sandboxPolicy });
      expect(result.output).not.toContain('vault');
      expect(result.output.split('\n').filter((line) => line.startsWith('/'))).toEqual([tree.hidden, tree.a, tree.b]);
    });

    it('is denied when the search path is readDenied', async () => {
      const tree = await makeTree(realSandbox);
      const vault = path.join(tree.tools.layout.project, 'vault');
      put(tree.tools, 'vault/secret.ts', 'alpha secret\n', 8);
      const sandboxPolicy = { ...tree.tools.sandboxPolicy, readDenied: [...tree.tools.sandboxPolicy.readDenied, vault] };
      const result = await grepIn(tree, envPath)({ pattern: 'alpha', path: vault }, { sandboxPolicy, mode: 'bypassPermissions' });
      expect(result).toEqual({ status: 'failed', output: `Permission denied: ${vault} is blocked by the sandbox policy`, denial: { source: 'sandbox', reason: `${vault} is blocked by the sandbox policy` } });
    });

    it('returns partial matches with a note when some paths could not be read', async () => {
      const tree = await makeTree(realSandbox);
      const locked = put(tree.tools, 'locked.ts', 'alpha locked\n', 7);
      fs.chmodSync(locked, 0o000);
      onCleanup(() => fs.chmodSync(locked, 0o644));
      const result = await grepIn(tree, envPath)({ pattern: 'alpha' });
      expect(result.output).toContain(tree.a);
      expect(result.output).toContain(tree.b);
      expect(result.output).toContain('(some paths could not be read)');
    });

    it('rejects a relative path', async () => {
      const tree = await makeTree(realSandbox);
      const result = await grepIn(tree, envPath)({ pattern: 'alpha', path: 'docs' });
      expect(result).toMatchObject({ status: 'failed', output: 'path must be an absolute path' });
    });
  });
});
