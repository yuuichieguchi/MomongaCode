import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTempDir, REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import type { Sandbox } from '@momonga/sandbox';
import { HAS_REAL_SANDBOX, createHostSandbox } from '../helpers.ts';
import { HAS_RG, RG_PATH, makeBuiltins, resultOf } from './fixtures.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const CONFIG_VARIABLE = 'RIPGREP_CONFIG_PATH';

const argvForm = (inner: Sandbox): Sandbox => ({
  ...inner,
  spawn: (command, policy, signal) => {
    const file = command.env?.[CONFIG_VARIABLE];
    if (file === undefined) return inner.spawn(command, policy, signal);
    const flags = fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n');
    const { [CONFIG_VARIABLE]: _file, ...env } = command.env as Record<string, string>;
    const [executable, ...operands] = command.argv;
    return inner.spawn({ ...command, argv: [executable as string, '--no-config', ...flags, ...operands], env }, policy, signal);
  },
});

const GLOBS = ['*.txt ', '*.txt\t', '*.txt\\ ', '*.txt\\  ', ' c.txt', '#*', '', ' ', '!*.txt '];

describe.runIf(HAS_RG && HAS_REAL_SANDBOX)('the model glob in the file form has the effect it had on argv', () => {
  let tmpRoot = '';

  beforeAll(() => {
    tmpRoot = createTempDir();
    fs.chmodSync(tmpRoot, 0o700);
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const answerOf = async (sandbox: Sandbox, glob: string): Promise<{ status: string; output: string }> => {
    const tools = await makeBuiltins({ sandbox });
    for (const name of ['a.txt', 'b.txt ', 'b.txt\t', ' c.txt', '#d.md', 'e.md']) tools.write(name, 'secret\n');
    const result = resultOf(await tools.run('Grep', { pattern: 'secret', path: tools.layout.project, glob, output_mode: 'content' }, { env: { PATH: RG_PATH, LANG: 'C' } }));
    return { status: result.status, output: result.output.split(tools.layout.project).join('<project>') };
  };

  it.each(GLOBS)('gives the same answer for the glob %j as argv did', async (glob) => {
    const sandbox = createHostSandbox({ tmpRoot, killGraceMs: 300 });
    const fileForm = await answerOf(sandbox, glob);
    const argv = await answerOf(argvForm(sandbox), glob);
    expect(fileForm).toEqual(argv);
  });

  it('accepts a glob that ends in whitespace and matches what argv matched: the trim drops it', async () => {
    const answer = await answerOf(createHostSandbox({ tmpRoot, killGraceMs: 300 }), '*.txt ');
    expect(answer).toEqual({ status: 'completed', output: ' c.txt:1:secret\na.txt:1:secret' });
  });

  it('carries an empty glob as argv did: nothing is filtered', async () => {
    const answer = await answerOf(createHostSandbox({ tmpRoot, killGraceMs: 300 }), '');
    expect(answer.status).toBe('completed');
    expect(answer.output.split('\n').length).toBe(6);
  });
});
