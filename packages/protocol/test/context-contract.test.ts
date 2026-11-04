import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { CONTEXT_CHARGE_PURPOSES, CONTRIBUTION_KINDS, EVENT_TYPES, GOVERNING_KINDS, MEMORY_EVIDENCE_KINDS, MEMORY_KINDS, MEMORY_STATES, MEMORY_STATUSES, RUN_API_SCHEMAS, SUMMARY_SOURCES, USAGE_CHARGE_PURPOSES, toPublicRunEvent } from '@momonga/protocol';
import type { GoverningFactView, GoverningKind, MemoryEvidence, MemoryKind, MemorySource, MemoryState, MemoryStatus, MemoryView, RunEvent, SummaryFidelity, SummarySource } from '@momonga/protocol';

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);
const acceptsEvent = ajv.compile(RUN_API_SCHEMAS.PublicRunEvent);
const acceptsMemory = ajv.compile(RUN_API_SCHEMAS.MemoryView);

const ENVELOPE = { id: 7, runId: 'r1', sessionId: 's1', seq: 4, step: 1, createdAt: 1_800_000_000_000 };
const FIDELITY: SummaryFidelity = { fabricated: ['src/ghost.ts'], identifiers: 3, retained: 2, sections: 'partial' };
const COMPACTED = { ...ENVELOPE, type: 'context.compacted', summary: 'so far', replacedThroughSeq: 3 };
const COMPACTION_ITEM = { type: 'compaction', id: 'cmp-1', encrypted_content: 'opaque' };
const MESSAGE_ITEM = { type: 'message', role: 'user', content: '<conversation_summary>\nso far\n</conversation_summary>' };

describe('context constants', () => {
  it('lists the governing kinds of the design', () => {
    expect(GOVERNING_KINDS).toEqual(['constraint', 'preference', 'commitment', 'role', 'identity']);
  });

  it('lists memory kinds, states, evidence kinds and statuses, statuses in recall tier order', () => {
    expect(MEMORY_KINDS).toEqual(['fact', 'episode', 'procedure']);
    expect(MEMORY_STATES).toEqual(['active', 'candidate', 'archived', 'duplicate', 'rejected']);
    expect(MEMORY_EVIDENCE_KINDS).toEqual(['file', 'commit', 'check']);
    expect(MEMORY_STATUSES).toEqual(['verified', 'unbound', 'unverifiable', 'stale']);
  });

  it('lists summary sources and contribution kinds', () => {
    expect(SUMMARY_SOURCES).toEqual(['model', 'deterministic']);
    expect(CONTRIBUTION_KINDS).toEqual(['memory', 'governing', 'summary', 'working_state']);
  });

  it('keeps the in-run charge purposes and lists the out-of-run ones separately', () => {
    expect(USAGE_CHARGE_PURPOSES).toEqual(['compaction', 'permission_classifier', 'rejected_answer']);
    expect(CONTEXT_CHARGE_PURPOSES).toEqual(['reflection', 'guideline']);
  });

  it('registers the three new event types as public events', () => {
    expect(EVENT_TYPES).toEqual(expect.arrayContaining(['context.governing_loaded', 'context.memories_loaded', 'context.contribution']));
  });
});

describe('context types', () => {
  it('defines the governing fact view of the design', () => {
    expectTypeOf<GoverningKind>().toEqualTypeOf<'constraint' | 'preference' | 'commitment' | 'role' | 'identity'>();
    expectTypeOf<GoverningFactView>().toEqualTypeOf<{
      id: string;
      kind: GoverningKind;
      target: string;
      text: string;
      scope: { level: 'user' } | { level: 'project'; project: string; paths: string[] };
      validFrom: number;
      validUntil: number | null;
      retiredAt: number | null;
      supersedes: string[];
      enforcement: { behavior: 'deny' | 'ask'; rule: string } | null;
      source: { kind: 'command'; at: number } | { kind: 'proposal'; sessionId: string; runId: string; seq: number; callId: string };
    }>();
  });

  it('defines memory evidence and the memory view additions', () => {
    expectTypeOf<MemoryKind>().toEqualTypeOf<'fact' | 'episode' | 'procedure'>();
    expectTypeOf<MemoryState>().toEqualTypeOf<'active' | 'candidate' | 'archived' | 'duplicate' | 'rejected'>();
    expectTypeOf<MemoryStatus>().toEqualTypeOf<'verified' | 'stale' | 'unverifiable' | 'unbound'>();
    expectTypeOf<SummarySource>().toEqualTypeOf<'model' | 'deterministic'>();
    expectTypeOf<MemoryEvidence>().toEqualTypeOf<
      | { kind: 'file'; project: string; path: string; sha256: string }
      | { kind: 'commit'; sha: string }
      | { kind: 'check'; runId: string; callId: string; seq: number; command: string; exitCode: number }
    >();
    expectTypeOf<MemoryView['evidence']>().toEqualTypeOf<MemoryEvidence[]>();
    expectTypeOf<MemoryView['state']>().toEqualTypeOf<MemoryState>();
    expectTypeOf<MemoryView['kind']>().toEqualTypeOf<MemoryKind>();
    expectTypeOf<MemoryView['duplicateOf']>().toEqualTypeOf<string | null>();
    expectTypeOf<MemoryView['supersedes']>().toEqualTypeOf<string[]>();
    expectTypeOf<MemoryView['retiredAt']>().toEqualTypeOf<number | null>();
    expectTypeOf<MemoryView['contributedAt']>().toEqualTypeOf<number | null>();
    expectTypeOf<MemoryView['status']>().toEqualTypeOf<MemoryStatus>();
  });

  it('defines the memory source as a union on its kind', () => {
    expectTypeOf<MemorySource>().toEqualTypeOf<
      | { kind: 'tool'; sessionId: string; runId: string; step: number; callId: string; seq: number }
      | { kind: 'reflection'; sessionId: string; runId: string; ordinal: number }
      | { kind: 'command'; at: number }
    >();
  });
});

describe('MemoryView schema additions', () => {
  const view = {
    id: 'm1',
    scope: 'user',
    origin: 'trusted',
    project: null,
    text: 'tests live in test/',
    source: { kind: 'tool', sessionId: 's1', runId: 'r1', step: 2, callId: 'c1', seq: 5 },
    createdAt: 1,
    lastUsedAt: 2,
  };
  const evidence = [
    { kind: 'file', project: '/work/a', path: 'src/a.ts', sha256: 'abc' },
    { kind: 'commit', sha: 'd818eb5' },
    { kind: 'check', runId: 'r1', callId: 'c1', seq: 5, command: 'npm test', exitCode: 0 },
  ];
  const stored = { ...view, kind: 'fact', state: 'active', duplicateOf: null, supersedes: ['m0'], supersededBy: [], retiredAt: null, evidence, contributedAt: null };
  const full = { ...stored, status: 'verified' };

  it('accepts a view with the fields of the design', () => {
    expect(acceptsMemory(full)).toBe(true);
    expect(acceptsMemory({ ...full, state: 'duplicate', duplicateOf: 'm0' })).toBe(true);
  });

  it('rejects a stored view whose status is not computed yet, because status is computed at every read', () => {
    expect(acceptsMemory(stored)).toBe(false);
  });

  it.each(['kind', 'state', 'duplicateOf', 'supersedes', 'supersededBy', 'retiredAt', 'contributedAt', 'evidence', 'status'])('requires %s', (field) => {
    expect(acceptsMemory(full)).toBe(true);
    const { [field]: _removed, ...without } = full as Record<string, unknown>;
    expect(acceptsMemory(without)).toBe(false);
  });

  it('accepts a reflection source and rejects a source without its kind or with fields of the other kind', () => {
    const reflection = { sessionId: 's1', runId: 'r1', ordinal: 0 };
    expect(acceptsMemory({ ...full, source: { kind: 'reflection', ...reflection } })).toBe(true);
    expect(acceptsMemory({ ...full, source: reflection })).toBe(false);
    expect(acceptsMemory({ ...full, source: { kind: 'reflection', ...reflection, callId: 'c1' } })).toBe(false);
    expect(acceptsMemory({ ...full, source: { kind: 'tool', sessionId: 's1', runId: 'r1', ordinal: 0 } })).toBe(false);
  });

  it('rejects an unknown kind, state, status and evidence kind, and malformed evidence', () => {
    expect(acceptsMemory(full)).toBe(true);
    expect(acceptsMemory({ ...full, kind: 'note' })).toBe(false);
    expect(acceptsMemory({ ...full, state: 'deleted' })).toBe(false);
    expect(acceptsMemory({ ...full, status: 'fresh' })).toBe(false);
    expect(acceptsMemory({ ...full, evidence: [{ kind: 'url', url: 'x' }] })).toBe(false);
    expect(acceptsMemory({ ...full, evidence: [{ kind: 'file', project: '/work/a', path: 'src/a.ts' }] })).toBe(false);
    expect(acceptsMemory({ ...full, evidence: [{ kind: 'file', path: 'src/a.ts', sha256: 'abc' }] })).toBe(false);
    expect(acceptsMemory({ ...full, evidence: [{ kind: 'commit', sha: 'abc', path: 'src/a.ts' }] })).toBe(false);
  });
});

describe('public context.governing_loaded', () => {
  const event = {
    ...ENVELOPE,
    type: 'context.governing_loaded',
    active: [{ id: 'g1', textSha256: 'aa' }],
    conflicts: [{ target: 'pandas', ids: ['g1', 'g2'] }],
  };

  it('accepts the recorded shape, with and without conflicts in it', () => {
    expect(acceptsEvent(event)).toBe(true);
    expect(acceptsEvent({ ...event, conflicts: [] })).toBe(true);
  });

  it('requires active and conflicts and closes its entries', () => {
    expect(acceptsEvent(event)).toBe(true);
    const { conflicts: _conflicts, ...withoutConflicts } = event;
    expect(acceptsEvent(withoutConflicts)).toBe(false);
    expect(acceptsEvent({ ...event, active: [{ id: 'g1' }] })).toBe(false);
    expect(acceptsEvent({ ...event, active: [{ id: 'g1', textSha256: 'aa', text: 'x' }] })).toBe(false);
    expect(acceptsEvent({ ...event, conflicts: [{ target: 'pandas' }] })).toBe(false);
  });

  it('is public without the lease token', () => {
    expect(toPublicRunEvent({ ...event, leaseToken: 3 } as unknown as RunEvent)).toEqual(event);
  });
});

describe('public context.memories_loaded', () => {
  const event = { ...ENVELOPE, type: 'context.memories_loaded', memories: [{ id: 'm1', status: 'stale' }] };

  it('accepts recalled memories with their status, and none', () => {
    expect(acceptsEvent(event)).toBe(true);
    expect(acceptsEvent({ ...event, memories: [] })).toBe(true);
  });

  it('rejects an unknown status, a missing status and a missing list', () => {
    expect(acceptsEvent(event)).toBe(true);
    expect(acceptsEvent({ ...event, memories: [{ id: 'm1', status: 'fresh' }] })).toBe(false);
    expect(acceptsEvent({ ...event, memories: [{ id: 'm1' }] })).toBe(false);
    const { memories: _memories, ...withoutMemories } = event;
    expect(acceptsEvent(withoutMemories)).toBe(false);
  });

  it('is public without the lease token', () => {
    expect(toPublicRunEvent({ ...event, leaseToken: 3 } as unknown as RunEvent)).toEqual(event);
  });
});

describe('public context.contribution', () => {
  const event = {
    ...ENVELOPE,
    type: 'context.contribution',
    items: [
      { kind: 'memory', id: 'm1', contributed: true },
      { kind: 'governing', id: 'g1', contributed: false },
      { kind: 'summary', id: '12', contributed: true },
      { kind: 'working_state', id: '12', contributed: false },
    ],
  };

  it('accepts every contribution kind, and no items', () => {
    expect(acceptsEvent(event)).toBe(true);
    expect(acceptsEvent({ ...event, items: [] })).toBe(true);
  });

  it('rejects an unknown kind, a missing flag and a missing list', () => {
    expect(acceptsEvent(event)).toBe(true);
    expect(acceptsEvent({ ...event, items: [{ kind: 'skill', id: 'x', contributed: true }] })).toBe(false);
    expect(acceptsEvent({ ...event, items: [{ kind: 'memory', id: 'x' }] })).toBe(false);
    const { items: _items, ...withoutItems } = event;
    expect(acceptsEvent(withoutItems)).toBe(false);
  });
});

describe('public context.compacted', () => {
  it('accepts an event recorded before source, fidelity and guidelineVersion existed', () => {
    expect(acceptsEvent(COMPACTED)).toBe(true);
  });

  it('accepts each new field, and rejects wrong values', () => {
    expect(acceptsEvent({ ...COMPACTED, source: 'model', fidelity: FIDELITY, guidelineVersion: 2 })).toBe(true);
    expect(acceptsEvent({ ...COMPACTED, source: 'deterministic' })).toBe(true);
    expect(acceptsEvent({ ...COMPACTED, source: 'guess' })).toBe(false);
    expect(acceptsEvent({ ...COMPACTED, guidelineVersion: 'v2' })).toBe(false);
    expect(acceptsEvent({ ...COMPACTED, fidelity: { ...FIDELITY, sections: 'most' } })).toBe(false);
    expect(acceptsEvent({ ...COMPACTED, fidelity: { fabricated: [], identifiers: 1 } })).toBe(false);
  });

  it('carries the new fields into the public event and still drops the item', () => {
    const recorded = { ...COMPACTED, leaseToken: 3, item: COMPACTION_ITEM, source: 'model', fidelity: FIDELITY, guidelineVersion: 2 };
    expect(toPublicRunEvent(recorded as unknown as RunEvent)).toEqual({ ...COMPACTED, source: 'model', fidelity: FIDELITY, guidelineVersion: 2 });
  });

  it('drops a message item of a deterministic summary too', () => {
    const recorded = { ...COMPACTED, leaseToken: 3, item: MESSAGE_ITEM, source: 'deterministic' };
    expect(toPublicRunEvent(recorded as unknown as RunEvent)).toEqual({ ...COMPACTED, source: 'deterministic' });
  });

  it('adds no keys to an older recorded event', () => {
    const publicEvent = toPublicRunEvent({ ...COMPACTED, leaseToken: 3, item: COMPACTION_ITEM } as unknown as RunEvent);
    expect(Object.keys(publicEvent).sort()).toEqual(Object.keys(COMPACTED).sort());
  });
});

describe('public usage.charged', () => {
  const charged = { ...ENVELOPE, type: 'usage.charged', inputTokens: 5, outputTokens: 1, totalTokens: 6 };

  it.each(['compaction', 'permission_classifier'])('accepts purpose %s', (purpose) => {
    expect(acceptsEvent({ ...charged, purpose })).toBe(true);
  });

  it.each(['reflection', 'guideline'])('rejects purpose %s, which is charged outside a run', (purpose) => {
    expect(acceptsEvent({ ...charged, purpose })).toBe(false);
  });

  it('rejects an unlisted purpose', () => {
    expect(acceptsEvent({ ...charged, purpose: 'embedding' })).toBe(false);
  });
});
