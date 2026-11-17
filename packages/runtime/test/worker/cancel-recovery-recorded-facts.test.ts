import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import { seedStartedCalls } from './cancel-fixture.ts';

const WRITE = { callId: 'call_w_1', name: 'Write', kind: 'edit' as const, args: { file_path: 'notes/a.md', content: 'x' }, facts: { files: [{ path: 'notes/a.md', access: 'write' }] } };
const BASH = { callId: 'call_b_1', name: 'Bash', kind: 'execute' as const, args: { command: 'sleep 30' }, facts: { command: 'sleep 30' } };

describe('a cancelled run abandons its started calls', () => {
  it('reconciles each abandoned call with the command and files its record holds', async () => {
    const env = await makeEnv();
    const { run } = await seedStartedCalls(env, [WRITE, BASH]);
    const worker = env.worker('worker-1');

    await env.settled(env.runOnce(worker), 'the cancel recovery');

    expect(env.run(run.id).status).toBe('CANCELLED');
    const reconciled = env.ofType(run.id, 'tool.reconciled');
    expect(reconciled).toHaveLength(2);
    expect(reconciled).toContainEqual(expect.objectContaining({ callId: BASH.callId, outcome: 'unknown', command: 'sleep 30' }));
    expect(reconciled).toContainEqual(expect.objectContaining({ callId: WRITE.callId, outcome: 'unknown', files: WRITE.facts.files }));
  });
});
