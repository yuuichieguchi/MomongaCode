import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakePolicyFilesystem, hostFilesystemOf } from '@momonga/testkit';
import { createPolicyFilesystem } from '@momonga/tools';
import type { ToolExecutorOptions } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { minimalPolicyFor } from './helpers.ts';

const commandTool = (command: string, runs: string[]) =>
  makeTool('Bash', {
    kind: 'execute',
    sideEffect: 'exec',
    subject: () => ({ kind: 'command', tool: 'Bash', command }),
    execute: async () => {
      runs.push(command);
      return { status: 'completed', output: 'ran' };
    },
  });

const setup = (fsPort: ToolExecutorOptions['fs']) => {
  const harness = makeHarness({ executor: { fs: fsPort } });
  const extra = path.join(harness.layout.root, 'extra-writable');
  const tmp = path.join(harness.layout.root, 'sessions', 'one');
  for (const dir of [extra, tmp, path.join(harness.layout.project, 'bin')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(harness.layout.project, 'f'), 'x');
  const sandboxPolicy = { ...minimalPolicyFor({ layout: harness.layout }), writableRoots: [harness.layout.project, tmp, extra] };
  return { harness, extra, tmp, sandboxPolicy };
};

describe('executor passes the search path and the writable check to the resolver (3.13)', () => {
  it('passes batch.env.PATH and an isWritable built from the sandbox policy', async () => {
    const recording = fakePolicyFilesystem();
    const { harness, extra, tmp, sandboxPolicy } = setup(hostFilesystemOf(recording));
    const searchPath = `${extra}:/usr/bin:/bin`;
    await harness.executor.runBatch(
      harness.input(await toolSetOf(commandTool('sed -n 1p f', [])), [call('c1', 'Bash')], { env: { PATH: searchPath }, sandboxPolicy }),
    );
    const sedCalls = recording.resolveCalls.filter((entry) => entry.name === 'sed');
    expect(sedCalls.length).toBeGreaterThan(0);
    const [first] = sedCalls;
    expect(first?.searchPath).toBe(searchPath);
    expect(first?.isWritable(path.join(harness.layout.project, 'bin'))).toBe(true);
    expect(first?.isWritable(tmp)).toBe(true);
    expect(first?.isWritable(extra)).toBe(true);
    expect(first?.isWritable('/opt/homebrew/bin')).toBe(false);
  });

  it('gives no model when an extraWritable entry precedes /usr/bin, and approves with /usr/bin:/bin', async () => {
    const planted = setup(createPolicyFilesystem());
    const plantedRuns: string[] = [];
    const [asked] = await planted.harness.executor.runBatch(
      planted.harness.input(await toolSetOf(commandTool('sed -n 1p f', plantedRuns)), [call('c1', 'Bash')], {
        env: { PATH: `${planted.extra}:/usr/bin:/bin` },
        sandboxPolicy: planted.sandboxPolicy,
      }),
    );
    expect(asked).toMatchObject({ kind: 'needs_approval' });
    expect(plantedRuns).toEqual([]);

    const plain = setup(createPolicyFilesystem());
    const plainRuns: string[] = [];
    const [ran] = await plain.harness.executor.runBatch(
      plain.harness.input(await toolSetOf(commandTool('sed -n 1p f', plainRuns)), [call('c1', 'Bash')], { env: { PATH: '/usr/bin:/bin' }, sandboxPolicy: plain.sandboxPolicy }),
    );
    expect(ran).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(plainRuns).toEqual(['sed -n 1p f']);
  });
});
