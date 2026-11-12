import { describe, expect, it } from 'vitest';
import { nodeChildPorts } from '@momonga/tools';
import type { ShellHost } from '@momonga/tools';
import { hookRunContextFor } from '../../src/worker/hook-step.ts';
import type { ClaimContext } from '../../src/worker/claim-context.ts';

describe('hookRunContextFor', () => {
  it('hands the tool runtime shell host to the hook runner', () => {
    const shellHost: ShellHost = { platform: 'linux', isExecutable: () => true, child: nodeChildPorts() };
    const session = { id: 's1', cwd: '/work', permissionMode: 'manual' };
    const ctx = {
      options: {
        tools: {
          sandbox: {},
          shellHost,
          markerDir: '/markers',
          sessionState: () => ({ cwd: '/work' }),
        },
        clock: { now: () => 0 },
      },
      run: { id: 'r1', deadlineAt: 1 },
      control: { signal: new AbortController().signal },
    } as unknown as ClaimContext;
    const policy = { sandboxPolicy: {}, env: {}, tmpDir: '/tmp/x' } as never;

    const context = hookRunContextFor(ctx, session as never, {} as never, policy, {} as never, 1000, () => undefined);

    expect(context.shellHost).toBe(shellHost);
  });
});
