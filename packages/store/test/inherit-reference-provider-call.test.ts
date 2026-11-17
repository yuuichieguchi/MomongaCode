import { describe, expect, it } from 'vitest';
import { callItem, requested, responded } from './inherit-fixtures.ts';
import { FLOOR_TOKENS, UNBOUNDED_WINDOW, answeredRun, chainBuilder, referenceHarness, withReader } from './support/reference.ts';

describe('the reference window names the recorded provider call id', () => {
  it('an output of a call whose provider id differs from its call id carries the provider id', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'parent task', (claim) => {
      b.append(claim, [
        requested(1),
        responded(1, [callItem('prov-1')]),
        { type: 'tool.call', callId: 'call-1', providerCallId: 'prov-1', name: 'Write', kind: 'edit', title: 'Write x.txt', rawInput: { file_path: '/work/a/x.txt' } },
        { type: 'tool.started', callId: 'call-1', idemKey: 'k-call-1' },
        { type: 'tool.completed', callId: 'call-1', status: 'completed', output: 'out' },
      ]);
    });
    const child = await b.createRun('child task');
    expect(await b.inherit(b.claimNext(child.id), 'manual')).toEqual({ kind: 'inherited' });
    const reply = await withReader(h.dbPath, (reader) => reader.readInheritedWindow({ runId: child.id, windowTokens: UNBOUNDED_WINDOW, floorTokens: FLOOR_TOKENS }));
    const outputIds = reply.entries.flatMap((entry) => ('item' in entry && entry.item.type === 'function_call_output' ? [entry.item.call_id] : []));
    expect(outputIds).toEqual(['prov-1']);
  });
});
