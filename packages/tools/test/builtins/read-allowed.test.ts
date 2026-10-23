import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_PATH, RG_BIN, RG_PATH, makeBuiltins, resultOf } from './fixtures.ts';
import type { Builtins } from './fixtures.ts';

const HAS_RG = process.platform === 'darwin' && fs.existsSync(RG_BIN) && fs.existsSync('/usr/bin/sandbox-exec');
const PROCESS_TIMEOUT = { timeout: 30_000 };

const fixture = async (options: { realSandbox?: boolean } = {}) => {
  const tools = await makeBuiltins(options);
  const { project, home } = tools.layout;
  const vault = path.join(project, 'vault');
  const ok = path.join(vault, 'ok');
  const allowedFile = tools.write('vault/ok/a.txt', 'alpha allowed\n');
  const secretFile = tools.write('vault/secret.txt', 'alpha secret\n');
  const visibleFile = tools.write('visible.txt', 'alpha visible\n');
  const momonga = path.join(home, '.momonga');
  fs.mkdirSync(momonga, { recursive: true });
  const token = path.join(momonga, 'token.txt');
  fs.writeFileSync(token, 'alpha token\n');
  const sandboxPolicy = { ...tools.sandboxPolicy, readDenied: [...tools.sandboxPolicy.readDenied, vault], readAllowed: [ok] };
  return { tools, vault, ok, allowedFile, secretFile, visibleFile, token, sandboxPolicy };
};

const linesOf = (output: string): string[] => output.split('\n').filter((line) => line !== '').sort();

const grep = (tools: Builtins, args: Record<string, unknown>, sandboxPolicy: unknown, envPath: string) =>
  tools.run('Grep', { pattern: 'alpha', ...args }, { sandboxPolicy: sandboxPolicy as Builtins['sandboxPolicy'], env: { PATH: envPath, LANG: 'C' } });

describe('readAllowed inside a readDenied root (builtins)', () => {
  it('Read reads a file inside the allowed dir', async () => {
    const fx = await fixture();
    const result = resultOf(await fx.tools.run('Read', { file_path: fx.allowedFile }, { sandboxPolicy: fx.sandboxPolicy }));
    expect(result.status).toBe('completed');
    expect(result.output).toContain('alpha allowed');
  });

  it('Read still blocks a sibling of the allowed dir', async () => {
    const fx = await fixture();
    const result = resultOf(await fx.tools.run('Read', { file_path: fx.secretFile }, { sandboxPolicy: fx.sandboxPolicy }));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/^Permission denied: .* is blocked by the sandbox policy$/);
  });

  it('Read blocks a symlink in the allowed dir that points into home/.momonga', async () => {
    const fx = await fixture();
    const link = path.join(fx.ok, 'link.txt');
    fs.symlinkSync(fx.token, link);
    const result = resultOf(await fx.tools.run('Read', { file_path: link }, { mode: 'bypassPermissions', sandboxPolicy: fx.sandboxPolicy }, 'allow_once'));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/^Permission denied: .* is blocked by the sandbox policy$/);
    expect(result.output).not.toContain('alpha token');
  });

  it.runIf(process.platform === 'darwin')('Read through a differently cased allowed entry still works on darwin', async () => {
    const fx = await fixture();
    const policy = { ...fx.sandboxPolicy, readAllowed: [path.join(fx.vault, 'OK')] };
    const result = resultOf(await fx.tools.run('Read', { file_path: fx.allowedFile }, { sandboxPolicy: policy }));
    expect(result.status).toBe('completed');
  });

  it('Glob lists files inside the allowed dir when searching it directly', async () => {
    const fx = await fixture();
    const result = resultOf(await fx.tools.run('Glob', { pattern: '**/*.txt', path: fx.ok }, { sandboxPolicy: fx.sandboxPolicy }));
    expect(result.status).toBe('completed');
    expect(linesOf(result.output)).toEqual([fx.allowedFile]);
  });

  it('Glob from the project includes the allowed dir and skips its denied siblings', async () => {
    const fx = await fixture();
    const result = resultOf(await fx.tools.run('Glob', { pattern: '**/*.txt' }, { sandboxPolicy: fx.sandboxPolicy }));
    expect(linesOf(result.output)).toEqual([fx.visibleFile, fx.allowedFile].sort());
  });

  it('Glob skips a symlinked dir in the allowed dir that points into home/.momonga', async () => {
    const fx = await fixture();
    fs.symlinkSync(path.dirname(fx.token), path.join(fx.ok, 'linked'));
    const result = resultOf(await fx.tools.run('Glob', { pattern: '**/*.txt', path: fx.ok }, { sandboxPolicy: fx.sandboxPolicy }));
    expect(linesOf(result.output)).toEqual([fx.allowedFile]);
  });

  it('Grep with the JS backend searches the allowed dir', async () => {
    const fx = await fixture();
    const result = resultOf(await grep(fx.tools, { path: fx.ok }, fx.sandboxPolicy, BASE_PATH));
    expect(result.status).toBe('completed');
    expect(linesOf(result.output)).toEqual([fx.allowedFile]);
  });

  it('Grep with the JS backend from the project finds the allowed file and skips denied siblings', async () => {
    const fx = await fixture();
    const result = resultOf(await grep(fx.tools, {}, fx.sandboxPolicy, BASE_PATH));
    expect(linesOf(result.output)).toEqual([fx.visibleFile, fx.allowedFile].sort());
  });

  it('Grep with the JS backend skips a symlink in the allowed dir that points into home/.momonga', async () => {
    const fx = await fixture();
    fs.symlinkSync(fx.token, path.join(fx.ok, 'link.txt'));
    const result = resultOf(await grep(fx.tools, { path: fx.ok }, fx.sandboxPolicy, BASE_PATH));
    expect(linesOf(result.output)).toEqual([fx.allowedFile]);
  });
});

describe.runIf(HAS_RG)('readAllowed inside a readDenied root (Grep with ripgrep under real Seatbelt)', () => {
  it('searches the allowed dir', PROCESS_TIMEOUT, async () => {
    const fx = await fixture({ realSandbox: true });
    const result = resultOf(await grep(fx.tools, { path: fx.ok }, fx.sandboxPolicy, RG_PATH));
    expect(result.status).toBe('completed');
    expect(linesOf(result.output)).toEqual([fx.allowedFile]);
  });

  it('from the project finds the allowed file and skips denied siblings', PROCESS_TIMEOUT, async () => {
    const fx = await fixture({ realSandbox: true });
    const result = resultOf(await grep(fx.tools, {}, fx.sandboxPolicy, RG_PATH));
    expect(result.status).toBe('completed');
    expect(linesOf(result.output)).toEqual([fx.visibleFile, fx.allowedFile].sort());
  });

  it('never returns content reached through a symlink in the allowed dir into home/.momonga', PROCESS_TIMEOUT, async () => {
    const fx = await fixture({ realSandbox: true });
    fs.symlinkSync(fx.token, path.join(fx.ok, 'link.txt'));
    const result = resultOf(await grep(fx.tools, { path: fx.ok, output_mode: 'content' }, fx.sandboxPolicy, RG_PATH));
    expect(result.output).toContain('alpha allowed');
    expect(result.output).not.toContain('alpha token');
  });
});
