import { describe, expect, it } from 'vitest';
import type { InstructionReader } from '@momonga/context';
import { makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

describe('the instruction reads of a claim are bounded by the claim, not by the process', () => {
  it('asks for an instruction reader under the signal of the claim that reads', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const asked: AbortSignal[] = [];
    const reader: InstructionReader = { contains: async () => true, read: async () => undefined, exists: async () => false, realpath: async (target: string) => target };
    env.gateway.script.push(textStep('Done.'));
    await env.enqueue('Read the rules');

    expect(
      await env.runOnce(
        env.worker('worker-1', {
          instructionReaderFor: (signal: AbortSignal) => {
            asked.push(signal);
            return reader;
          },
        }),
      ),
    ).toBe('yielded');

    const claimSignal = env.portCalls.toolSet[0]?.signal;
    expect(claimSignal).toBeDefined();
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter((signal) => signal !== claimSignal)).toEqual([]);
  });
});
