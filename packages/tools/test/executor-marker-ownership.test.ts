import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Sandbox } from '@momonga/sandbox';
import { SandboxPolicyError } from '@momonga/sandbox';
import type { ResultOutcome, ToolHooks } from '@momonga/tools';
import { LSOF_PATH, waitFor } from '@momonga/testkit';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { fakeSandbox, keyFor } from './helpers.ts';
import { makeBuiltins, resultOf, TEST_WRITER_LAUNCH } from './builtins/fixtures.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const openByThisProcess = (file: string): boolean => {
  const listing = execFileSync(LSOF_PATH, ['-a', '-p', String(process.pid), '-Fn'], { env: { LC_ALL: 'C' }, encoding: 'utf8' });
  return listing.split('\n').some((line) => line.startsWith('n') && line.slice(1).startsWith(file));
};

const refusingSandbox = (error: () => Error): Sandbox => ({
  kind: 'seatbelt',
  spawn: (command, ...rest) => {
    if (command.argv.join('\0') === TEST_WRITER_LAUNCH.argv.join('\0')) return fakeSandbox.spawn(command, ...rest);
    throw error();
  },
});

const markerFileGoneAndReleased = (markerDir: string, key: string): void => {
  const marker = path.join(markerDir, key);
  expect(fs.existsSync(marker)).toBe(false);
  expect(openByThisProcess(marker)).toBe(false);
};

describe.runIf(process.platform === 'darwin')('T13 every path out of a call that never spawns releases its marker', () => {
  it.for([
    ['a cwd refused by the sandbox', () => Object.assign(new Error('cwd /nowhere is outside the sandbox'), { code: 'ENOENT' })],
    ['a sandbox policy refusal', () => new SandboxPolicyError('session_tmp_not_read_allowed', 'injected policy refusal')],
  ] as const)('%s: the marker is removed, no descriptor is left, the row completes as failed, and the next Write runs', async ([, error]) => {
    const tools = await makeBuiltins({ sandbox: refusingSandbox(error) });
    const callId = 'refused';
    const outcome = await tools.run('Bash', { command: 'echo never' }, {}, 'allow_once', callId);
    expect(resultOf(outcome).status).toBe('failed');
    markerFileGoneAndReleased(tools.markerDir, keyFor('run-1', 1, callId));
    expect(tools.idempotency.stateOf(keyFor('run-1', 1, callId))).toBe('COMPLETED');
    const written = await tools.run('Write', { file_path: path.join(tools.layout.project, 'after.txt'), content: 'after' }, {}, 'allow_once', 'write-after');
    expect(resultOf(written).status).toBe('completed');
  });

  it('an abort after the marker was created: the marker is removed and no descriptor is left', async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    const tool = makeTool('Slow', { kind: 'execute', sideEffect: 'exec', subjectKind: 'none', execute: () => new Promise(() => undefined) });
    const running = harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('slow', 'Slow', {}, 'allow_once')], { signal: controller.signal }));
    const key = keyFor('run-1', 1, 'slow');
    await waitFor(() => fs.existsSync(path.join(harness.markerDir, key)), { description: 'the marker of the call' });
    controller.abort();
    const [outcome] = await running;
    expect(outcome?.kind).toBe('result');
    expect((outcome as ResultOutcome).result.status).toBe('failed');
    markerFileGoneAndReleased(harness.markerDir, key);
  });

  it('a throwing pre-hook: no marker is left and no descriptor is held', async () => {
    const hooks: ToolHooks = {
      matchesPreToolUse: () => true,
      preToolUse: async () => {
        throw new Error('pre-hook failed: injected');
      },
      postToolUse: async () => undefined,
    };
    const harness = makeHarness();
    const tool = makeTool('Slow', { kind: 'execute', sideEffect: 'exec', subjectKind: 'none', execute: async () => ({ status: 'completed', output: 'ran' }) });
    await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('hooked', 'Slow', {}, 'allow_once')], { hooks })).catch(() => undefined);
    markerFileGoneAndReleased(harness.markerDir, keyFor('run-1', 1, 'hooked'));
  });
});

describe('T13 drift: createMarker is the one creator and each creator closes its handle in a finally', () => {
  it.for(['packages/tools/src/executor.ts', 'packages/tools/src/sandboxed-command.ts', 'packages/runtime/src/process/job-marker-files.ts'])('%s creates markers only through createMarker and closes the handle in a finally', (relative) => {
    const text = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    expect(text).toContain('createMarker(');
    expect(text).not.toMatch(/openSync\([^)]*'wx'/);
    expect(text).toMatch(/finally\s*\{[^}]*\.close\(\)/);
  });

  it('no other source opens a marker with O_EXLOCK', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts') && /O_EXLOCK/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full));
      }
    };
    for (const pkg of fs.readdirSync(path.join(ROOT, 'packages'))) {
      const src = path.join(ROOT, 'packages', pkg, 'src');
      if (fs.existsSync(src)) walk(src);
    }
    expect(offenders.sort()).toEqual(['packages/foundation/src/platform/kernel-lock.ts', 'packages/foundation/src/platform/lock-capability.ts']);
  });
});
