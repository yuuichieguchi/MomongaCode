import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeBuiltins, resultOf } from './builtins/fixtures.ts';
import { makeLayout, ruleFor } from './helpers.ts';
import { HAS_REAL_SANDBOX, realSandbox, recordingSandbox, scratchRootOf } from './read-only-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const setup = async () => {
  const recorded = recordingSandbox(realSandbox(scratchRootOf(makeLayout().root)));
  const built = await makeBuiltins({ sandbox: recorded.sandbox });
  return { ...built, spawns: recorded.spawns };
};

describe.runIf(HAS_REAL_SANDBOX)('review 1: an approved edit still works under the real sandbox', () => {
  it('acceptEdits runs echo hi > out with the writable workspace', async () => {
    const built = await setup();
    const result = resultOf(await built.run('Bash', { command: 'echo hi > out' }, { mode: 'acceptEdits' }));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(path.join(built.layout.project, 'out'), 'utf8')).toBe('hi\n');
    expect(built.spawns[0]?.policy.writableRoots).toContain(built.layout.project);
  });

  it('an allow rule for the target runs echo hi > out with the writable workspace', async () => {
    const built = await setup();
    const rules = [ruleFor(built.layout)('allow', 'Edit(./out)')];
    const result = resultOf(await built.run('Bash', { command: 'echo hi > out' }, { rules }));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(path.join(built.layout.project, 'out'), 'utf8')).toBe('hi\n');
    expect(built.spawns[0]?.policy.writableRoots).toContain(built.layout.project);
  });

  it('a redirect to /dev/null keeps the read-only policy', async () => {
    const built = await setup();
    resultOf(await built.run('Bash', { command: 'ls 2>/dev/null' }));
    expect(built.spawns[0]?.policy.writableRoots).toEqual([]);
  });
});
