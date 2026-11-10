import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, momongaLayout } from '@momonga/foundation';
import { buildSandboxPolicy } from '@momonga/tools';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import { trackGroup } from './builtins/fixtures.ts';
import { HAS_REAL_SANDBOX, createHostSandbox, makeLayout } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const collect = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const runScript = async (sandbox: Sandbox, policy: SandboxPolicy, cwd: string, tmpDir: string, script: string) => {
  const proc = sandbox.spawn({ argv: ['/bin/sh', '-c', script], cwd, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, tmpDir }, policy, new AbortController().signal);
  trackGroup(proc.pgid);
  const [stdout, stderr, exit] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
  return { code: exit.code, stdout, stderr };
};

describe.runIf(HAS_REAL_SANDBOX)('the executables area under the cache base, on the real OS sandbox of this host', () => {
  const setup = () => {
    const layout = makeLayout();
    const paths = momongaLayout(layout.home);
    const area = path.join(paths.cacheBase, 'executables');
    const extracted = path.join(area, 'ripgrep-15.2.0-0123456789abcdef');
    fs.mkdirSync(extracted, { recursive: true });
    const rg = path.join(extracted, 'rg');
    fs.writeFileSync(rg, '#!/bin/sh\nprintf "rg ran"\n', { mode: 0o700 });
    const sandboxTmpRoot = path.join(layout.root, 'sandbox-tmp');
    fs.mkdirSync(sandboxTmpRoot);
    const tmpDir = path.join(paths.tmp.sessions, 'own-session');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const policy = buildSandboxPolicy({ roots: [layout.home], home: layout.home, tmpDir, sessionsTmpRoot: paths.tmp.sessions, fileRules: EMPTY_FILE_RULES, protectedSet: EMPTY_PROTECTED_SET, network: 'deny' });
    const sandbox = createHostSandbox({ tmpRoot: sandboxTmpRoot, killGraceMs: 300 });
    return { layout, paths, area, extracted, rg, policy, sandbox, tmpDir };
  };

  it('refuses a write into the area even when a session root contains the whole cache base', async () => {
    const { layout, rg, extracted, policy, sandbox, tmpDir } = setup();
    const before = fs.readFileSync(rg, 'utf8');
    const overwrite = await runScript(sandbox, policy, layout.project, tmpDir, `printf evil > '${rg}'`);
    const create = await runScript(sandbox, policy, layout.project, tmpDir, `printf evil > '${path.join(extracted, 'rg.partial-x')}'`);
    const remove = await runScript(sandbox, policy, layout.project, tmpDir, `rm -f '${rg}'`);
    const newDirectory = await runScript(sandbox, policy, layout.project, tmpDir, `mkdir '${path.join(path.dirname(extracted), 'ripgrep-evil')}'`);
    expect(overwrite.code).not.toBe(0);
    expect(create.code).not.toBe(0);
    expect(newDirectory.code).not.toBe(0);
    expect(remove.code === 0 && !fs.existsSync(rg)).toBe(false);
    expect(fs.readFileSync(rg, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(extracted, 'rg.partial-x'))).toBe(false);
  });

  it('keeps the area readable and executable inside the sandbox, because Grep runs rg there', async () => {
    const { layout, rg, policy, sandbox, tmpDir } = setup();
    const read = await runScript(sandbox, policy, layout.project, tmpDir, `cat '${rg}'`);
    const exec = await runScript(sandbox, policy, layout.project, tmpDir, `'${rg}'`);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain('rg ran');
    expect(exec).toMatchObject({ code: 0, stdout: 'rg ran' });
  });

  it('keeps the tmp area under the cache base writable', async () => {
    const { layout, policy, sandbox, tmpDir } = setup();
    const own = await runScript(sandbox, policy, layout.project, tmpDir, `printf ok > '${path.join(tmpDir, 'note')}' && cat '${path.join(tmpDir, 'note')}'`);
    expect(own).toMatchObject({ code: 0, stdout: 'ok' });
  });
});
