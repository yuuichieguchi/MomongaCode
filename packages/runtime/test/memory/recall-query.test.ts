import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { MEMORY_QUERY_MAX_CHARS } from '@momonga/tools';
import { enqueue, harness, mustClaim, newSession } from '../../../store/test/helpers.ts';
import { recallQueryOf } from '../../src/memory/recall-query.ts';

const CWD = '/work/a';

const readCall = (index: number): RunEventPayload => ({
  type: 'tool.call',
  callId: `c${index}`,
  providerCallId: `c${index}`,
  name: 'Read',
  kind: 'read',
  title: `Read ${index}`,
  rawInput: {},
  locations: [{ path: `${CWD}/src/module-${String(index).padStart(4, '0')}.ts` }],
});

describe('the recall query', () => {
  it('the query holds the newest paths when the bound is full', async () => {
    const { store } = harness();
    const session = newSession(store, CWD);
    await enqueue(store, session.id);
    const claim = mustClaim(store, 'w1');
    const count = 1000;
    expect(store.append(claim, Array.from({ length: count }, (_unused, index) => readCall(index))).kind).toBe('ok');
    const newest = (await store.sessionTouched.newest(session.id, MEMORY_QUERY_MAX_CHARS)).map((entry) => entry.path);
    const query = recallQueryOf('fix the build', newest, CWD);
    expect(query).toContain('src/module-0999.ts');
    expect(query).not.toContain('src/module-0000.ts');
  });
});
