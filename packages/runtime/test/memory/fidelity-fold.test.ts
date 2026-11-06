import { describe, expect, it, vi } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { deniedCall, fidelityEnv, modelSaid, startedCall } from './fidelity-fixture.ts';

vi.setConfig({ testTimeout: 120_000 });

const TOKEN = 'make deploy-staging';

const attested = async (events: readonly RunEventPayload[], claim: 'executed' | 'any', input = 'fix the bug'): Promise<string[]> => {
  const env = fidelityEnv();
  const run = await env.finished(events, 'COMPLETED', input);
  return (await env.fidelity(run.id, [{ token: TOKEN, claim }])).attested;
};

describe('the fidelity fold decides sources by event type', () => {
  it('does not attest a token found only in model.responded text', async () => {
    expect(await attested(modelSaid(1, `I ran ${TOKEN} already`), 'any')).toEqual([]);
  });

  it('attests a token found only in a user message for an any claim and not for an executed claim', async () => {
    const input = `please run ${TOKEN} later`;
    expect(await attested([], 'any', input)).toEqual([TOKEN]);
    expect(await attested([], 'executed', input)).toEqual([]);
  });

  it('attests a token in the arguments of a call that started', async () => {
    expect(await attested(startedCall('c1', { command: TOKEN }), 'executed')).toEqual([TOKEN]);
  });

  it('does not attest a token in the arguments of a denied call', async () => {
    expect(await attested(deniedCall('c1', { command: TOKEN }), 'executed')).toEqual([]);
  });

  it('attests a token in the output of a call that ran', async () => {
    expect(await attested(startedCall('c1', { command: 'ls' }, `log: ${TOKEN} done`), 'executed')).toEqual([TOKEN]);
  });

  it('attests a token in a handled blob', async () => {
    const env = fidelityEnv();
    const { handle } = await env.store.blobs.put(`head\nthe blob says ${TOKEN}\ntail`, { mediaType: 'text/plain' } as never);
    const run = await env.finished(startedCall('c1', { command: 'ls' }, 'omitted', { handle }));
    expect((await env.fidelity(run.id, [{ token: TOKEN, claim: 'executed' }])).attested).toEqual([TOKEN]);
  });

  it('does not attest a token found only in a previous context.compacted summary', async () => {
    const summary = `DONE:\nran \`${TOKEN}\``;
    const compacted = { type: 'context.compacted', item: { type: 'message', role: 'user', content: summary }, summary, replacedThroughSeq: 1, source: 'model' } as RunEventPayload;
    expect(await attested([...modelSaid(1, 'working'), compacted], 'any')).toEqual([]);
  });

  it('attests a recorded file path by equality after stripping the working directory', async () => {
    const env = fidelityEnv();
    const run = await env.finished(startedCall('c1', { command: 'gen' }, 'ok', { files: [{ path: `${env.project}/src/gen.ts`, sha256: 'a'.repeat(64), access: 'write' }] }));
    expect((await env.fidelity(run.id, [{ token: 'src/gen.ts', claim: 'executed' }])).attested).toEqual(['src/gen.ts']);
  });

  it('ignores events after throughEventSeq', async () => {
    const env = fidelityEnv();
    const run = await env.finished(startedCall('c1', { command: TOKEN }));
    expect((await env.fidelity(run.id, [{ token: TOKEN, claim: 'executed' }], 1)).attested).toEqual([]);
  });
});
