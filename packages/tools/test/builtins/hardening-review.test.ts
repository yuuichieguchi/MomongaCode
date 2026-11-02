import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { volumeIsCaseInsensitive } from '@momonga/policy';
import { SandboxPolicyError, validateSandboxPolicy } from '@momonga/sandbox';
import { HAS_RG, JS_BACKEND_PATH, RG_PATH, makeBuiltins, resultOf } from './fixtures.ts';
import type { Builtins } from './fixtures.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const ACCEPT = { mode: 'acceptEdits' } as const;

describe.runIf(volumeIsCaseInsensitive(os.tmpdir()))('Keychains stays unreadable whatever readAllowed says', () => {
  it('Read of home/Library/Keychains/k.db is refused with a case-variant readAllowed entry', async () => {
    const tools = await makeBuiltins();
    const keychains = path.join(tools.layout.home, 'Library', 'Keychains');
    fs.mkdirSync(keychains, { recursive: true });
    const secret = path.join(keychains, 'k.db');
    fs.writeFileSync(secret, 'keychain-secret\n');
    const sandboxPolicy = {
      ...tools.sandboxPolicy,
      readDenied: [...tools.sandboxPolicy.readDenied, path.join(tools.layout.home, 'Library')],
      readAllowed: [...(tools.sandboxPolicy.readAllowed ?? []), path.join(tools.layout.home, 'Library', 'KEYCHAINS')],
    };
    const attempt = tools.run('Read', { file_path: secret }, { mode: 'bypassPermissions', sandboxPolicy }, 'allow_once');
    const settled = await attempt.then(
      (outcome) => ({ kind: 'resolved' as const, outcome }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    if (settled.kind === 'resolved') {
      const result = resultOf(settled.outcome);
      expect(result.status).toBe('failed');
      expect(result.output).not.toContain('keychain-secret');
    }
  });
});

describe('validateSandboxPolicy rejects an invalid session tmp dir', () => {
  const cases: Array<[string, (tools: Builtins) => string]> = [
    ['home', (tools) => tools.layout.home],
    ['the sessions root', (tools) => path.dirname(tools.tmpDir)],
    ['/', () => '/'],
  ];

  for (const [label, tmpDirOf] of cases) {
    it(`rejects a tmpDir that is ${label} with session_tmp_not_read_allowed`, async () => {
      const tools = await makeBuiltins();
      let thrown: unknown;
      try {
        validateSandboxPolicy(tools.sandboxPolicy, { tmpDir: tmpDirOf(tools) });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SandboxPolicyError);
      expect((thrown as SandboxPolicyError).code).toBe('session_tmp_not_read_allowed');
    });
  }

  it('accepts the tmpDir the policy was built with', async () => {
    const tools = await makeBuiltins();
    const target = path.join(tools.tmpDir, 'ok.txt');
    const result = resultOf(await tools.run('Write', { file_path: target, content: 'ok' }, ACCEPT));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(target, 'utf8')).toBe('ok');
  });
});

describe('walking toward an allowed entry never reads inside the denied dir', () => {
  const fixture = async () => {
    const tools = await makeBuiltins();
    const vault = path.join(tools.layout.project, 'vault');
    const allowedFile = tools.write('vault/ok/a.txt', 'alpha allowed\n');
    tools.write('vault/.gitignore', '*\n');
    tools.write('vault/sibling.txt', 'alpha sibling\n');
    const visibleFile = tools.write('visible.txt', 'alpha visible\n');
    const sandboxPolicy = {
      ...tools.sandboxPolicy,
      readDenied: [...tools.sandboxPolicy.readDenied, vault],
      readAllowed: [...(tools.sandboxPolicy.readAllowed ?? []), path.join(vault, 'ok')],
    };
    return { tools, vault, allowedFile, visibleFile, sandboxPolicy };
  };

  const lines = (output: string): string[] => output.split('\n').filter((line) => line !== '').sort();

  it('Glob from the project finds the allowed file despite an ignore-all file in the denied dir', async () => {
    const fx = await fixture();
    const result = resultOf(await fx.tools.run('Glob', { pattern: '**/*.txt' }, { sandboxPolicy: fx.sandboxPolicy }));
    expect(lines(result.output)).toEqual([fx.visibleFile, fx.allowedFile].sort());
  });

  it('Grep with the JS backend finds the allowed file despite an ignore-all file in the denied dir', async () => {
    const fx = await fixture();
    const result = resultOf(await fx.tools.run('Grep', { pattern: 'alpha' }, { sandboxPolicy: fx.sandboxPolicy, env: { PATH: JS_BACKEND_PATH, LANG: 'C' } }));
    expect(lines(result.output)).toEqual([fx.visibleFile, fx.allowedFile].sort());
  });

  it('Glob never lists the denied dir nor reads files directly inside it', async () => {
    const fx = await fixture();
    const vaultKey = fs.realpathSync(fx.vault).toLowerCase();
    const touched: string[] = [];
    const keyOf = (target: unknown): string | undefined => (typeof target === 'string' ? path.resolve(target).toLowerCase() : undefined);
    const recordListing = (target: unknown): void => {
      if (keyOf(target) === vaultKey) touched.push(`readdir ${String(target)}`);
    };
    const recordRead = (target: unknown): void => {
      const key = keyOf(target);
      if (key !== undefined && path.dirname(key) === vaultKey) touched.push(`readFile ${String(target)}`);
    };
    const realReaddir = fs.promises.readdir.bind(fs.promises);
    const realReadFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      recordListing(target);
      return (realReaddir as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.promises.readdir);
    vi.spyOn(fs.promises, 'readFile').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      recordRead(target);
      return (realReadFile as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.promises.readFile);
    const result = resultOf(await fx.tools.run('Glob', { pattern: '**/*.txt' }, { sandboxPolicy: fx.sandboxPolicy }));
    expect(result.status).toBe('completed');
    expect(touched).toEqual([]);
  });
});

describe('Write through a dangling relative symlink reached via a directory symlink', () => {
  it('creates the file where the kernel would put it', async () => {
    const tools = await makeBuiltins();
    const { project } = tools.layout;
    fs.mkdirSync(path.join(project, 'real', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(project, 'real', 'target'));
    fs.mkdirSync(path.join(project, 'target'));
    fs.symlinkSync(path.join(project, 'real', 'sub'), path.join(project, 'alias'));
    fs.symlinkSync(path.join('..', 'target', 'f'), path.join(project, 'real', 'sub', 'link'));
    const result = resultOf(await tools.run('Write', { file_path: path.join(project, 'alias', 'link'), content: 'payload' }, ACCEPT));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(path.join(project, 'real', 'target', 'f'), 'utf8')).toBe('payload');
    expect(fs.existsSync(path.join(project, 'target', 'f'))).toBe(false);
  });
});

const grepBackends: Array<[string, string, boolean, boolean]> = [
  ['JS fallback', JS_BACKEND_PATH, true, false],
  ['ripgrep', RG_PATH, HAS_RG, true],
];

describe.each(grepBackends)('Grep allowed-root discovery (%s backend)', (_name, envPath, available, realSandbox) => {
  const grepFrom = async (tools: Builtins, sandboxPolicy: Builtins['sandboxPolicy']) =>
    resultOf(await tools.run('Grep', { pattern: 'needle', output_mode: 'content' }, { sandboxPolicy, env: { PATH: envPath, LANG: 'C' } }));

  it.runIf(available)('reports a match under nested allowed entries exactly once', { timeout: 30_000 }, async () => {
    const tools = await makeBuiltins({ realSandbox });
    const vault = path.join(tools.layout.project, 'vault');
    const deepFile = tools.write('vault/ok/deep/a.txt', 'needle here\n');
    const sandboxPolicy = {
      ...tools.sandboxPolicy,
      readDenied: [...tools.sandboxPolicy.readDenied, vault],
      readAllowed: [...(tools.sandboxPolicy.readAllowed ?? []), path.join(vault, 'ok'), path.join(vault, 'ok', 'deep')],
    };
    const result = await grepFrom(tools, sandboxPolicy);
    expect(result.status).toBe('completed');
    const matches = result.output.split('\n').filter((line) => line.includes('needle here'));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain(deepFile);
  });

  it.runIf(available)('does not reach an allowed entry whose denied parent is ignored by the project', { timeout: 30_000 }, async () => {
    const tools = await makeBuiltins({ realSandbox });
    const vault = path.join(tools.layout.project, 'vault');
    tools.write('.gitignore', 'vault/\n');
    tools.write('vault/ok/a.txt', 'needle hidden\n');
    const visible = tools.write('visible.txt', 'needle visible\n');
    const sandboxPolicy = {
      ...tools.sandboxPolicy,
      readDenied: [...tools.sandboxPolicy.readDenied, vault],
      readAllowed: [...(tools.sandboxPolicy.readAllowed ?? []), path.join(vault, 'ok')],
    };
    const result = await grepFrom(tools, sandboxPolicy);
    expect(result.output).toContain(visible);
    expect(result.output).not.toContain('needle hidden');
  });
});

describe.runIf(volumeIsCaseInsensitive(os.tmpdir()))('roots compare case-insensitively on a case-insensitive volume', () => {
  it('Write to a differently cased path under a missing root is inside the roots in acceptEdits', async () => {
    const tools = await makeBuiltins();
    const root = path.join(tools.layout.project, 'newdir');
    const target = path.join(tools.layout.project, 'NEWDIR', 'f.txt');
    const outcome = await tools.run('Write', { file_path: target, content: 'x' }, { ...ACCEPT, roots: [root] });
    expect(outcome?.kind).toBe('result');
  });
});

describe.each(grepBackends)('Grep with an allowed target (%s backend)', (_name, envPath, available, realSandbox) => {
  const grepIn = async (tools: Builtins, target: string, sandboxPolicy: Builtins['sandboxPolicy']) =>
    resultOf(await tools.run('Grep', { pattern: 'needle', path: target, output_mode: 'content' }, { sandboxPolicy, env: { PATH: envPath, LANG: 'C' } }));

  it.runIf(available)('reports a match under a nested allowed entry exactly once when the target is the outer allowed entry', { timeout: 30_000 }, async () => {
    const tools = await makeBuiltins({ realSandbox });
    const vault = path.join(tools.layout.project, 'vault');
    const deepFile = tools.write('vault/ok/deep/a.txt', 'needle deep\n');
    const sandboxPolicy = {
      ...tools.sandboxPolicy,
      readDenied: [...tools.sandboxPolicy.readDenied, vault],
      readAllowed: [...(tools.sandboxPolicy.readAllowed ?? []), path.join(vault, 'ok'), path.join(vault, 'ok', 'deep')],
    };
    const result = await grepIn(tools, path.join(vault, 'ok'), sandboxPolicy);
    expect(result.status).toBe('completed');
    const matches = result.output.split('\n').filter((line) => line.includes('needle deep'));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain(deepFile);
  });

  it.runIf(available)('finds a match in an allowed entry below a denied dir inside the target exactly once', { timeout: 30_000 }, async () => {
    const tools = await makeBuiltins({ realSandbox });
    const target = path.join(tools.layout.project, 'T');
    const denied = path.join(target, 'a', 'D');
    const allowedFile = tools.write('T/a/D/x/f.txt', 'needle allowed\n');
    tools.write('T/a/D/secret.txt', 'needle secret\n');
    const sandboxPolicy = {
      ...tools.sandboxPolicy,
      readDenied: [...tools.sandboxPolicy.readDenied, denied],
      readAllowed: [...(tools.sandboxPolicy.readAllowed ?? []), path.join(denied, 'x')],
    };
    const result = await grepIn(tools, target, sandboxPolicy);
    expect(result.status).toBe('completed');
    const matches = result.output.split('\n').filter((line) => line.includes('needle allowed'));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain(allowedFile);
    expect(result.output).not.toContain('needle secret');
  });
});

describe('validateSandboxPolicy rejects a malformed readAllowed policy', () => {
  const codeOf = (action: () => unknown): unknown => {
    try {
      action();
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxPolicyError);
      return (error as SandboxPolicyError).code;
    }
    throw new Error('expected a SandboxPolicyError');
  };

  it('rejects an allowed entry that contains another readDenied entry', async () => {
    const tools = await makeBuiltins();
    const vault = path.join(tools.layout.project, 'vault');
    const sandboxPolicy = {
      ...tools.sandboxPolicy,
      readDenied: [...tools.sandboxPolicy.readDenied, vault, path.join(vault, 'ok', 'deep', 'z')],
      readAllowed: [...(tools.sandboxPolicy.readAllowed ?? []), path.join(vault, 'ok'), path.join(vault, 'ok', 'deep'), path.join(vault, 'ok', 'deep', 'z', 'w')],
    };
    expect(codeOf(() => validateSandboxPolicy(sandboxPolicy))).toBe('read_allowed_contains_denied');
  });

  it('rejects an allowed entry outside every readDenied entry', async () => {
    const tools = await makeBuiltins();
    const sandboxPolicy = {
      ...tools.sandboxPolicy,
      readAllowed: [...(tools.sandboxPolicy.readAllowed ?? []), path.join(tools.layout.project, 'free')],
    };
    expect(codeOf(() => validateSandboxPolicy(sandboxPolicy))).toBe('read_allowed_not_inside_denied');
  });
});
