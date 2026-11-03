import { describe, expect, it } from 'vitest';
import { bashTool } from '../../src/builtins/bash.ts';
import type { ReconcileContext } from '../../src/types.ts';

const reconcile = (earlierAttempt: ReconcileContext['earlierAttempt']) =>
  bashTool.reconcile?.({ command: 'ssh-agent' }, { key: 'k', pgid: 4242 } as never, { earlierAttempt, processMarker: '/no/such/marker' } as ReconcileContext);

describe('Bash reconcile of an earlier attempt with a process that could not be inspected', () => {
  it('reports unknown, not stopped, and names the process', async () => {
    const result = await reconcile({ stopped: false, uninspectable: [{ pid: 31_340, command: 'ssh-agent' }] });
    expect(result).toMatchObject({ outcome: 'unknown' });
    expect(result?.output).toContain('Process 31340 (ssh-agent) could not be inspected');
    expect(result?.output).toContain('may still be running');
    expect(result?.output).not.toContain('was stopped');
    expect(result?.output).not.toContain('no longer running');
  });

  it('keeps the stopped answer when nothing was uninspectable', async () => {
    const result = await reconcile({ stopped: true });
    expect(result?.output).toContain('The interrupted command was stopped.');
  });
});
