import { describe, expect, it, vi } from 'vitest';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { createFidelityFold } from '../../src/memory/fidelity-fold.ts';
import { deniedCall, fidelityEnv, modelSaid, reconciledCall, rejectedCall, startedCall, unfinishedCall } from './fidelity-fixture.ts';

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

  it('does not attest a token in the arguments of a call the person rejected, which never started', async () => {
    expect(await attested(rejectedCall('c1', { command: TOKEN }), 'executed')).toEqual([]);
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

describe('evidence of work done is a call that finished unrefused or was confirmed applied (decision 37 B)', () => {
  it('attests the arguments of a started call reconciled as already_applied', async () => {
    expect(await attested(reconciledCall('c1', { command: TOKEN }, 'already_applied', 'reconciled'), 'executed')).toEqual([TOKEN]);
  });

  it('does not attest the arguments of a started call reconciled as not_applied', async () => {
    expect(await attested(reconciledCall('c1', { command: TOKEN }, 'not_applied', 'reconciled'), 'executed')).toEqual([]);
  });

  it('does not attest the arguments of a started call reconciled as unknown', async () => {
    expect(await attested(reconciledCall('c1', { command: TOKEN }, 'unknown', 'reconciled'), 'executed')).toEqual([]);
  });

  it('does not attest the arguments of a call that started and never completed', async () => {
    expect(await attested(unfinishedCall('c1', { command: TOKEN }), 'executed')).toEqual([]);
  });

  it.each(['already_applied', 'not_applied', 'unknown'] as const)('attests the output text of a call reconciled as %s', async (outcome) => {
    expect(await attested(reconciledCall('c1', { command: 'ls' }, outcome, `the record says ${TOKEN}`), 'executed')).toEqual([TOKEN]);
  });

  it('does not attest the arguments of a not_applied call followed by another completed call', async () => {
    const events = [...reconciledCall('c1', { command: TOKEN }, 'not_applied', 'reconciled'), ...startedCall('c2', { command: 'ls' })];
    expect(await attested(events, 'executed')).toEqual([]);
  });
});

const envelope = (seq: number, payload: Record<string, unknown>): RunEvent => ({ id: seq, runId: 'run-2', sessionId: 's', seq, step: 0, leaseToken: 1, createdAt: 0, ...payload }) as unknown as RunEvent;

const REFERENCE_EVENT = envelope(2, {
  type: 'context.inherited',
  form: 'reference',
  fromRunId: 'run-1',
  fromLastSeq: 9,
  nextItemSeq: 5,
  fromNextItemSeq: 5,
  omitSeqs: [],
  synthesised: [],
  via: [],
  itemCount: 4,
  closures: [],
  markers: [],
  workingFacts: { itemEvents: [] },
  activatedSkills: [],
  digest: 'd',
});

const inheritedEvents = (payloads: readonly RunEventPayload[]): RunEvent[] => payloads.map((payload, index) => envelope(index + 1, payload as unknown as Record<string, unknown>));

type RecordPort = (event: RunEvent, add: (event: RunEvent) => void) => void;

describe('the fold reads a reference event through the record port (13.12 design item 2)', () => {
  const foldWith = (claim: 'executed' | 'any', port: RecordPort) =>
    (createFidelityFold as unknown as (tokens: readonly { token: string; claim: 'executed' | 'any' }[], cwd: string, record: RecordPort) => ReturnType<typeof createFidelityFold>)(
      [{ token: TOKEN, claim }],
      '/work',
      port,
    );

  it('attests a token in an inherited tool output as executed', () => {
    const fold = foldWith('executed', (_event, add) => inheritedEvents(startedCall('c1', { command: 'ls' }, `log ${TOKEN}`)).forEach(add));
    fold.add(REFERENCE_EVENT);
    fold.finish();
    expect(fold.attested()).toEqual([TOKEN]);
  });

  it('attests a token in an inherited user message for any and not for executed', () => {
    const port: RecordPort = (_event, add) => inheritedEvents([{ type: 'user.message', text: `run ${TOKEN}` } as RunEventPayload]).forEach(add);
    const any = foldWith('any', port);
    any.add(REFERENCE_EVENT);
    any.finish();
    expect(any.attested()).toEqual([TOKEN]);
    const executed = foldWith('executed', port);
    executed.add(REFERENCE_EVENT);
    executed.finish();
    expect(executed.attested()).toEqual([]);
  });

  it('does not attest a token in an inherited assistant message', () => {
    const fold = foldWith('any', (_event, add) => inheritedEvents(modelSaid(1, `I ran ${TOKEN}`)).forEach(add));
    fold.add(REFERENCE_EVENT);
    fold.finish();
    expect(fold.attested()).toEqual([]);
  });

  it('hands the reference event itself to the port', () => {
    const seen: RunEvent[] = [];
    const fold = foldWith('executed', (event) => {
      seen.push(event);
    });
    fold.add(REFERENCE_EVENT);
    expect(seen).toEqual([REFERENCE_EVENT]);
  });

  it('does not call the port once every token is resolved', () => {
    let calls = 0;
    const fold = foldWith('executed', () => {
      calls += 1;
    });
    inheritedEvents(startedCall('c0', { command: TOKEN })).forEach((event) => fold.add(event));
    expect(fold.unresolved).toBe(0);
    fold.add(REFERENCE_EVENT);
    expect(calls).toBe(0);
  });
});
